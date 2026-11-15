/**
 * Public, stateless routes.
 *
 * These exist so the storefront can correct images without a database, a
 * credential or a lookup: the browser sends a self-contained calibration code
 * plus the image, and the server re-derives and validates the matrix from the
 * code's embedded evidence.
 *
 * Deliberate differences from the authenticated `/v1` routes:
 *   - no store is touched, so no profile or revision state can leak between users
 *   - a passphrase gates the expensive routes (not a per-user credential)
 *   - limits are per resolved client address, with a separate global ceiling
 *
 * What is *not* different: the engine, the image caps and the matrix guardrails.
 * An anonymous caller gets exactly the same validation as the owner.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { IMAGE_LIMITS } from '../src/lib/calibrationLimits';
import { ApiError } from './errors';
import { assessPreset, PresetError, PRESET_LIMITS } from './preset';
import {
  RATE_LIMIT_TIERS,
  rateLimitGroup,
  resolveClientAddress,
  type RateLimiter,
} from './rateLimiter';

export interface PublicRouteOptions {
  /** Shared word that gates /v1/public/correct. Absent → the route is closed. */
  passphrase?: string;
  trustedProxies: readonly string[];
  limiter: RateLimiter;
  /** Restrict browser imports to this exact origin. */
  allowedOrigin?: string;
  accessLog: (event: Record<string, unknown>) => void;
}

export interface PublicRouteDeps {
  /** Same worker pool the authenticated route uses. */
  runCorrection: (
    image: Buffer,
    matrix: ReturnType<typeof assessPreset>['matrix']
  ) => Promise<{ png: Buffer; width: number; height: number; bitDepth: number; sourceFormat: string }>;
  decodeBase64Strict: (value: string) => Buffer;
  readJsonBody: (
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string
  ) => Promise<{ ok: true; body: unknown } | { ok: false }>;
  sendJson: (
    res: ServerResponse,
    status: number,
    payload: unknown,
    headers?: Record<string, string>
  ) => void;
}

const PRESET_BODY_KEYS = new Set(['code']);
const CORRECT_BODY_KEYS = new Set(['code', 'imageBase64']);

function expectKeys(body: unknown, allowed: Set<string>, required: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(422, 'INVALID_REQUEST', 'body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ApiError(422, 'INVALID_REQUEST', `unexpected field "${key}"`);
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      throw new ApiError(422, 'INVALID_REQUEST', `"${key}" is required`);
    }
  }
  return record;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Case- and whitespace-insensitive: people type the word by hand. */
function passphraseMatches(supplied: string, expected: string): boolean {
  const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '');
  return timingSafeEqual(digest(normalise(supplied)), digest(normalise(expected)));
}

function presetFailure(error: PresetError): ApiError {
  const status =
    error.code === 'PRESET_MALFORMED' ||
    error.code === 'PRESET_CHECKSUM' ||
    error.code === 'PRESET_VERSION'
      ? 400
      : 422;
  return new ApiError(status, error.code, error.message);
}

export function validatePassphrase(passphrase: string): void {
  const trimmed = passphrase.trim();
  if (trimmed.length < 5) {
    throw new Error('Public passphrase must be at least 5 characters');
  }
  if (trimmed.length > 64) {
    throw new Error('Public passphrase must be at most 64 characters');
  }
  if (new Set(trimmed.toLowerCase()).size < 3) {
    throw new Error('Public passphrase must use at least 3 distinct characters');
  }
}

/**
 * Returns true when the request was handled here. Anything these routes do not
 * own falls through to the authenticated router, which is the only place stored
 * calibrations can be read or written.
 */
export async function handlePublicRoute(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  options: PublicRouteOptions,
  deps: PublicRouteDeps,
  pathname: string
): Promise<boolean> {
  if (pathname !== '/v1/public/preset' && pathname !== '/v1/public/correct') {
    return false;
  }

  // Precedence: an edge that sets a single-client header is more trustworthy
  // than a comma list a client can prepend to. Both are only read when the TCP
  // peer is a configured proxy.
  const forwarded =
    req.headers['cf-connecting-ip'] ??
    req.headers['x-real-ip'] ??
    req.headers['x-forwarded-for'];
  const address = resolveClientAddress(req.socket.remoteAddress, forwarded, options.trustedProxies);

  const limited = (tier: keyof typeof RATE_LIMIT_TIERS, headers: Record<string, string> = {}) => {
    const decision = options.limiter.check(`${tier}:${address}`, RATE_LIMIT_TIERS[tier]);
    const limitHeaders = {
      'X-RateLimit-Limit': String(decision.limit),
      'X-RateLimit-Remaining': String(Math.max(0, decision.remaining)),
      'X-RateLimit-Reset': String(Math.ceil(decision.resetAt / 1000)),
      ...headers,
    };
    if (!decision.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests; retry later', {
        ...limitHeaders,
        'Retry-After': String(decision.retryAfterSeconds),
      });
    }
    return limitHeaders;
  };

  if (req.method !== 'POST') {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST', { Allow: 'POST' });
  }

  // ---- /v1/public/preset -------------------------------------------------
  // Cheap and pure: decode, re-fit, report strength. No image work, so it gets
  // its own allowance and needs no passphrase.
  if (pathname === '/v1/public/preset') {
    const limitHeaders = limited('preset');
    const parsed = await deps.readJsonBody(req, res, requestId);
    if (!parsed.ok) return true;
    const body = expectKeys(parsed.body, PRESET_BODY_KEYS, ['code']);
    const code = body.code;
    if (typeof code !== 'string' || code.length === 0) {
      throw new ApiError(422, 'INVALID_REQUEST', 'code must be a non-empty string');
    }
    if (code.length > PRESET_LIMITS.maxLength + 32) {
      throw new ApiError(422, 'PRESET_MALFORMED', 'Calibration code is too long');
    }

    try {
      const assessment = assessPreset(code);
      options.accessLog({
        level: 'info',
        event: 'public_preset',
        requestId,
        tier: assessment.decoded.tier,
        points: assessment.decoded.patches.length,
        residual: Number(assessment.residual.toFixed(2)),
      });
      deps.sendJson(
        res,
        200,
        {
          code: assessment.decoded.code,
          tier: assessment.decoded.tier,
          points: assessment.decoded.patches.length,
          residual: Number(assessment.residual.toFixed(2)),
          warnings: assessment.warnings,
          diagnostics: {
            clippingFraction: Number(assessment.diagnostics.clippingFraction.toFixed(3)),
            saturationRetention:
              assessment.diagnostics.saturationRetention === null
                ? null
                : Number(assessment.diagnostics.saturationRetention.toFixed(3)),
            minAnchorSeparation: assessment.fit.minAnchorSeparation,
            rank1: assessment.diagnostics.rank1,
          },
        },
        limitHeaders
      );
    } catch (error) {
      if (error instanceof PresetError) throw presetFailure(error);
      throw error;
    }
    return true;
  }

  // ---- /v1/public/correct ------------------------------------------------
  if (!options.passphrase) {
    throw new ApiError(503, 'PUBLIC_CORRECTION_DISABLED', 'Public correction is not enabled');
  }

  // Passphrase attempts are limited before the body is read, so guessing costs
  // the guesser before it costs the box.
  limited('passphrase');
  const globalLimit = options.limiter.check('correct-global', RATE_LIMIT_TIERS.correctGlobal);
  if (!globalLimit.allowed) {
    throw new ApiError(429, 'RATE_LIMITED', 'Service is at capacity; retry later', {
      'Retry-After': String(globalLimit.retryAfterSeconds),
    });
  }
  const limitHeaders = limited('correct');

  const supplied = req.headers['x-calibration-word'];
  const word = Array.isArray(supplied) ? supplied[0] : supplied;
  if (!word || !passphraseMatches(word, options.passphrase)) {
    options.accessLog({ level: 'warn', event: 'public_passphrase_rejected', requestId, address });
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid access word is required');
  }

  const parsed = await deps.readJsonBody(req, res, requestId);
  if (!parsed.ok) return true;
  const body = expectKeys(parsed.body, CORRECT_BODY_KEYS, ['code', 'imageBase64']);

  const code = body.code;
  if (typeof code !== 'string' || code.length === 0) {
    throw new ApiError(422, 'INVALID_REQUEST', 'code must be a non-empty string');
  }
  const imageBase64 = body.imageBase64;
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    throw new ApiError(422, 'INVALID_REQUEST', 'imageBase64 must be a non-empty base64 string');
  }
  if (imageBase64.length > Math.ceil(IMAGE_LIMITS.maxInputBytes / 3) * 4 + 4) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'imageBase64 is too large');
  }
  const image = deps.decodeBase64Strict(imageBase64);
  if (image.length > IMAGE_LIMITS.maxInputBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Decoded image exceeds the byte limit');
  }

  let assessment;
  try {
    assessment = assessPreset(code);
  } catch (error) {
    if (error instanceof PresetError) throw presetFailure(error);
    throw error;
  }

  const startedAt = Date.now();
  const result = await deps.runCorrection(image, assessment.matrix);
  options.accessLog({
    level: 'info',
    event: 'public_correction',
    requestId,
    address,
    tier: assessment.decoded.tier,
    points: assessment.decoded.patches.length,
    pixels: result.width * result.height,
    outputBytes: result.png.length,
    ms: Date.now() - startedAt,
  });

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': result.png.length,
    'Cache-Control': 'no-store',
    'X-Image-Width': String(result.width),
    'X-Image-Height': String(result.height),
    'X-Image-Bit-Depth': String(result.bitDepth),
    'X-Source-Format': result.sourceFormat,
    'X-Calibration-Tier': assessment.decoded.tier,
    'X-Calibration-Points': String(assessment.decoded.patches.length),
    'X-Calibration-Residual': assessment.residual.toFixed(2),
    ...limitHeaders,
  });
  res.end(result.png);
  return true;
}

export { RATE_LIMIT_TIERS, rateLimitGroup };

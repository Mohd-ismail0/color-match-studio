import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { IMAGE_LIMITS, SERVER_LIMITS } from '../src/lib/calibrationLimits';
import { assessMatrix, validateColorMatrix } from '../src/lib/matrixValidation';
import {
  ApiError,
  errorBody,
} from './errors';
import { CalibrationStore, StoreError } from './store';
import { WorkerPool, PoolError } from './workerPool';
import { ImageError } from './imagePipeline';
import {
  decodeBase64Strict,
  parseAppendRevision,
  parseCorrect,
  parseCreateCalibration,
} from './schema';
import {
  draftFromAppend,
  draftFromCreate,
  serializeRevision,
  verifyStoredRevision,
} from './calibrationService';

export interface ColorApiOptions {
  dbPath?: string;
  store?: CalibrationStore;
  workerCount?: number;
  queueLimit?: number;
  jobTimeoutMs?: number;
  queueTimeoutMs?: number;
  /** Restrict browser imports to this exact origin (default: local dev ports). */
  allowedOrigin?: string;
}

export interface ColorApiServer extends Server {
  store: CalibrationStore;
  pool: WorkerPool;
  shutdown: () => Promise<void>;
}

const BODY_TOO_LARGE = Symbol('body-too-large');

export function validateApiKey(key: string): void {
  if (typeof key !== 'string' || key.length < 32) {
    throw new Error('API key must be at least 32 characters');
  }
  if (new Set(key).size < 8) {
    throw new Error('API key must contain at least 8 distinct characters');
  }
  if (/^(.)\1+$/.test(key)) {
    throw new Error('API key must not be a single repeated character');
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function originAllowed(origin: string | undefined, configured?: string): string | null {
  if (!origin) return null;
  if (configured) return origin === configured ? origin : null;
  return origin === 'http://localhost:8080' || origin === 'http://127.0.0.1:8080'
    ? origin
    : null;
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  return /^application\/json\s*(?:;\s*charset=utf-8)?$/i.test(value.trim());
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendTooLarge(req: IncomingMessage, res: ServerResponse, requestId: string): void {
  const body = errorBody('PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit', requestId);
  res.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(body, () => {
    // The request may still be streaming. Close the socket explicitly: never
    // leave a half-read keep-alive connection behind (audit C3).
    req.destroy();
  });
}

type BodyResult = { ok: true; body: unknown } | { ok: false };

function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string
): Promise<BodyResult> {
  if (!isJsonContentType(req.headers['content-type'])) {
    // No body was consumed; the error response carries Connection: close.
    return Promise.reject(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
  }

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > IMAGE_LIMITS.maxBodyBytes) {
    sendTooLarge(req, res, requestId);
    return Promise.resolve({ ok: false });
  }

  return new Promise<BodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const body = errorBody('REQUEST_TIMEOUT', 'Request body was not received in time', requestId);
      res.writeHead(408, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      });
      res.end(body, () => req.destroy());
      resolve({ ok: false });
    }, SERVER_LIMITS.requestBodyTimeoutMs);

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > IMAGE_LIMITS.maxBodyBytes) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        req.pause();
        sendTooLarge(req, res, requestId);
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON'));
      }
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new ApiError(400, 'REQUEST_ABORTED', 'Request body could not be read'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function accessLog(entry: Record<string, unknown>): void {
  try {
    console.error(JSON.stringify(entry));
  } catch {
    // logging must never affect responses
  }
}

export function colorApi(key: string, options: ColorApiOptions = {}): ColorApiServer {
  validateApiKey(key);
  const expectedAuth = digest(`Bearer ${key}`);
  const store = options.store ?? new CalibrationStore(options.dbPath);
  const pool = new WorkerPool({
    size: options.workerCount,
    queueLimit: options.queueLimit,
    jobTimeoutMs: options.jobTimeoutMs,
    queueTimeoutMs: options.queueTimeoutMs,
  });
  const allowedOrigin = options.allowedOrigin;
  const startedAt = Date.now();
  let shuttingDown = false;

  interface FailureWindow {
    count: number;
    resetAt: number;
  }
  const authFailures = new Map<string, FailureWindow>();

  const clientIp = (req: IncomingMessage): string => req.socket.remoteAddress ?? 'unknown';

  const authorized = (req: IncomingMessage): boolean => {
    const supplied = req.headers.authorization ?? '';
    return timingSafeEqual(digest(supplied), expectedAuth);
  };

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const origin = originAllowed(req.headers.origin, allowedOrigin);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Calibration-Profile, X-Calibration-Revision, X-Calibration-Hash');
    }

    try {
      if (shuttingDown) {
        throw new ApiError(503, 'SHUTTING_DOWN', 'Server is shutting down');
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const segments = pathname.split('/').filter(Boolean);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
          'Content-Length': '0',
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          uptimeMs: Date.now() - startedAt,
          queue: pool.stats(),
        });
        return;
      }

      if (!segments[0] || segments[0] !== 'v1') {
        throw new ApiError(404, 'NOT_FOUND', 'Unknown route');
      }

      const ip = clientIp(req);
      const failure = authFailures.get(ip);
      if (failure && failure.count >= SERVER_LIMITS.authFailuresPerMinute && Date.now() < failure.resetAt) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many authentication failures; retry later', {
          'Retry-After': String(Math.max(1, Math.ceil((failure.resetAt - Date.now()) / 1000))),
        });
      }

      if (!authorized(req)) {
        const now = Date.now();
        if (!failure || now >= failure.resetAt) {
          authFailures.set(ip, { count: 1, resetAt: now + 60_000 });
        } else {
          failure.count += 1;
        }
        accessLog({ level: 'warn', event: 'auth_failure', requestId, ip, path: pathname });
        throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
      }

      if (req.method === 'POST' && pathname === '/v1/calibrations') {
        const parsed = await readJsonBody(req, res, requestId);
        if (!parsed.ok) return;
        if (store.countProfiles() >= 10_000) {
          throw new ApiError(429, 'PROFILE_LIMIT', 'Calibration profile limit reached');
        }
        const input = parseCreateCalibration(parsed.body);
        const draft = draftFromCreate(input);
        const created = store.createProfile(input.name, draft);
        sendJson(
          res,
          201,
          {
            profile: created.profile,
            revision: serializeRevision(created.revision),
          },
          { Location: `/v1/calibrations/${created.profile.id}` }
        );
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/calibrations') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? 50 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new ApiError(422, 'INVALID_REQUEST', 'limit must be an integer 1–200');
        }
        const profiles = store.listProfiles(limit);
        sendJson(res, 200, { profiles });
        return;
      }

      if (segments.length >= 3 && segments[1] === 'calibrations') {
        const profileId = segments[2];
        if (req.method === 'GET' && segments.length === 3) {
          const profile = store.getProfile(profileId);
          if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Calibration profile not found');
          sendJson(res, 200, { profile });
          return;
        }

        if (req.method === 'POST' && segments.length === 4 && segments[3] === 'revisions') {
          const parsed = await readJsonBody(req, res, requestId);
          if (!parsed.ok) return;
          const input = parseAppendRevision(parsed.body);
          const draft = draftFromAppend(input);
          const revision = store.appendRevision(profileId, draft);
          sendJson(res, 201, { revision: serializeRevision(revision) });
          return;
        }

        if (req.method === 'GET' && segments.length === 5 && segments[3] === 'revisions') {
          const revisionNumber = Number(segments[4]);
          if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
            throw new ApiError(422, 'INVALID_REQUEST', 'revision must be a positive integer');
          }
          const revision = store.getRevision(profileId, revisionNumber);
          if (!revision) {
            throw new ApiError(404, 'REVISION_NOT_FOUND', 'Calibration revision not found');
          }
          verifyStoredRevision(revision);
          sendJson(res, 200, { revision: serializeRevision(revision) });
          return;
        }
      }

      if (req.method === 'POST' && pathname === '/v1/correct') {
        const startedAtCorrection = Date.now();
        const parsed = await readJsonBody(req, res, requestId);
        if (!parsed.ok) return;
        const input = parseCorrect(parsed.body);
        const image = decodeBase64Strict(input.imageBase64);
        if (image.length > IMAGE_LIMITS.maxInputBytes) {
          throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Decoded image exceeds the byte limit');
        }

        let matrix;
        let calibrationRef: { profileId: string; revision: number; hash: string } | undefined;
        if (input.calibration) {
          const stored = store.getRevision(input.calibration.profileId, input.calibration.revision);
          if (!stored) {
            throw new ApiError(404, 'REVISION_NOT_FOUND', 'Calibration revision not found');
          }
          verifyStoredRevision(stored);
          matrix = stored.matrix;
          calibrationRef = {
            profileId: stored.profileId,
            revision: stored.revision,
            hash: stored.contentHash,
          };
          res.setHeader('X-Calibration-Profile', stored.profileId);
          res.setHeader('X-Calibration-Revision', String(stored.revision));
          res.setHeader('X-Calibration-Hash', stored.contentHash);
        } else {
          if (!input.matrix) throw new ApiError(422, 'INVALID_REQUEST', 'matrix is required');
          const validation = validateColorMatrix(input.matrix);
          if (!validation.ok) {
            throw new ApiError(422, 'MATRIX_REJECTED', validation.errors.join('; '));
          }
          const assessment = assessMatrix(input.matrix);
          if (assessment.destructive) {
            throw new ApiError(
              422,
              'MATRIX_REJECTED',
              `Matrix rejected by colour guardrail (${assessment.reasons.join('; ')})`
            );
          }
          matrix = input.matrix;
        }

        const result = await pool.run(image, matrix);
        accessLog({
          level: 'info',
          event: 'correction',
          requestId,
          profileId: calibrationRef?.profileId ?? null,
          revision: calibrationRef?.revision ?? null,
          contentHash: calibrationRef?.hash ?? null,
          pixels: result.info.pixels,
          bitDepth: result.info.bitDepth,
          sourceFormat: result.info.sourceFormat,
          outputBytes: result.png.length,
          ms: Date.now() - startedAtCorrection,
        });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': result.png.length,
          'Cache-Control': 'no-store',
          'X-Image-Width': String(result.info.width),
          'X-Image-Height': String(result.info.height),
          'X-Image-Bit-Depth': String(result.info.bitDepth),
          'X-Source-Format': result.info.sourceFormat,
        });
        res.end(result.png);
        return;
      }

      throw new ApiError(404, 'NOT_FOUND', 'Unknown route');
    } catch (error) {
      handleError(req, res, error, requestId);
    }
  });

  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeoutMs;

  const handleError = (
    req: IncomingMessage,
    res: ServerResponse,
    error: unknown,
    requestId: string
  ): void => {
    if (res.headersSent) {
      res.end();
      return;
    }
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Unexpected server error';
    let headers: Record<string, string> = {};

    if (error instanceof ApiError) {
      status = error.status;
      code = error.code;
      message = error.message;
      headers = { ...error.headers };
    } else if (error instanceof StoreError) {
      status = error.code === 'NOT_FOUND' ? 404 : error.code === 'LIMIT' ? 409 : 500;
      code = `STORE_${error.code}`;
      message = error.message;
    } else if (error instanceof PoolError && error.remoteCode) {
      // Image validation failed inside the isolated worker.
      const remote = error.remoteCode;
      const isImageError =
        remote === 'IMAGE_TOO_LARGE' ||
        remote === 'IMAGE_TYPE_UNSUPPORTED' ||
        remote === 'IMAGE_INVALID' ||
        remote === 'IMAGE_DEPTH_UNSUPPORTED' ||
        remote === 'MATRIX_REJECTED';
      if (isImageError) {
        status =
          remote === 'IMAGE_TOO_LARGE' ? 413 : remote === 'IMAGE_TYPE_UNSUPPORTED' ? 415 : 422;
        code = remote;
        message = error.message;
      } else {
        status = 500;
        code = 'WORKER_FAILED';
        message = error.message;
      }
    } else if (error instanceof PoolError) {
      code = error.code;
      if (error.code === 'QUEUE_FULL') {
        status = 429;
        const stats = pool.stats();
        headers = { 'Retry-After': String(Math.max(1, Math.ceil(stats.queued / 2) + 1)) };
      } else if (error.code === 'JOB_TIMEOUT') {
        status = 504;
      } else if (error.code === 'QUEUE_TIMEOUT') {
        status = 503;
        headers = { 'Retry-After': '2' };
      } else if (error.code === 'SERVER_CLOSED') {
        status = 503;
      } else {
        status = 500;
      }
      message = error.message;
    } else if (error instanceof ImageError) {
      status =
        error.code === 'IMAGE_TOO_LARGE'
          ? 413
          : error.code === 'IMAGE_TYPE_UNSUPPORTED'
            ? 415
            : 422;
      code = error.code;
      message = error.message;
    }

    if (status >= 500) {
      accessLog({ level: 'error', requestId, code, message, path: req.url });
    }

    if (!req.readableEnded && req.method === 'POST') {
      headers = { ...headers, Connection: 'close' };
    }
    const body = errorBody(code, message, requestId);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body, () => {
      if (headers.Connection === 'close') req.destroy();
    });
  };

  const apiServer = server as ColorApiServer;
  apiServer.store = store;
  apiServer.pool = pool;
  apiServer.shutdown = async () => {
    shuttingDown = true;
    await pool.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  };

  return apiServer;
}

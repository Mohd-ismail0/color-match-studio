/**
 * Stateless colour-preset codes.
 *
 * The browser fits the correction while the user is looking at their reference
 * card, then encodes only the *evidence* — sampled colour and intended colour
 * per patch — into a short string. The API re-fits and re-validates from that
 * evidence with the same engine the UI uses, so a preset needs no database, no
 * profile store and no lookup: every request carries what it needs.
 *
 * Format (fixed order, unambiguous alphabet, no padding):
 *
 *   lc1-<T><PPPP…><CCCC>
 *
 *   T       one tier letter: a (1 point), b (2), c (3–5), d (6–12)
 *   PPPP…   6 chars per patch: 3 sampled + 3 target, 5 bits per channel
 *   CCCC    4 checksum chars: first 20 bits of SHA-256 over "<T><PPPP…>"
 *
 * A preset is evidence, never authority. The API ignores any matrix the client
 * might claim, re-derives it from the patches, and applies the same
 * structural/destructive checks as the interactive app — so a forged preset
 * cannot produce a matrix the engine itself would have refused.
 */

import { createHash } from 'node:crypto';

import { MATRIX_LIMITS } from '../src/lib/calibrationLimits';
import { assessMatrix } from '../src/lib/matrixValidation';
import { applyColorMatrix, calculateMatrixDetailed } from '../src/lib/colorCorrection';
import type { ColorMatrix, ColorPoint } from '@/types/colorCorrector';
import type { MatrixAssessment } from '../src/lib/matrixValidation';
import type { FitDiagnostics } from '@/types/colorCorrector';

/** Alphabet omits I, L, O, U: less ambiguity if someone reads a code aloud. */
export const PRESET_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ALPHABET_INDEX = new Map([...PRESET_ALPHABET].map((char, index) => [char, index]));

export const PRESET_PREFIX = 'LC1-';

/** Tier letters and the point counts they allow. */
export const PRESET_TIERS = {
  a: { minPoints: 1, maxPoints: 1 },
  b: { minPoints: 2, maxPoints: 2 },
  c: { minPoints: 3, maxPoints: 5 },
  d: { minPoints: 6, maxPoints: 12 },
} as const;

export type PresetTier = keyof typeof PRESET_TIERS;

export const PRESET_LIMITS = {
  /** Longest accepted code: tier + 12 patches + checksum. */
  maxLength: 1 + PRESET_TIERS.d.maxPoints * 6 + 4,
  /**
   * Channels travel as 5 bits, i.e. steps of 8/255. Detected colours come off
   * an 8-bit canvas after averaging, so anything finer would imply precision
   * the browser never measured.
   */
  channelStep: 8,
  /** Mean absolute residual above which a preset is an identity fallback, not a calibration. */
  maxResidual: 48,
  /**
   * A single patch may legitimately move a channel a long way — a correct
   * magenta reading is r≈220 against a target of r≈60 — so this only rejects
   * the physically impossible (a "shift" that cannot be a shift at all).
   */
  maxAbsChannelDelta: 255,
} as const;

export type PresetErrorCode =
  | 'PRESET_MALFORMED'
  | 'PRESET_CHECKSUM'
  | 'PRESET_VERSION'
  | 'PRESET_TIER'
  | 'PRESET_POINTS'
  | 'PRESET_DUPLICATE'
  | 'PRESET_RANGE'
  | 'PRESET_UNUSABLE'
  | 'PRESET_WEAK';

export class PresetError extends Error {
  constructor(
    readonly code: PresetErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PresetError';
  }
}

export interface PresetPatch {
  sampledColor: RGB;
  targetColor: RGB;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface DecodedPreset {
  prefix: typeof PRESET_PREFIX;
  tier: PresetTier;
  patches: PresetPatch[];
  /** Canonical upper-case code including checksum. */
  code: string;
}

export interface PresetAssessment {
  decoded: DecodedPreset;
  matrix: ColorMatrix;
  /** Mean absolute residual in display units across the preset patches. */
  residual: number;
  warnings: string[];
  diagnostics: MatrixAssessment;
  fit: FitDiagnostics;
}

const clamp8 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

function packTriplet(color: RGB): string {
  // Quantise to 5 bits per channel, then pack: r in bits 14–10, g in 9–5, b in 4–0.
  // The division must happen before the shift, and the quotient clamped to 31 so
  // a 255 reading cannot overflow into the next channel.
  const five = (value: number): number => Math.min(31, Math.round(clamp8(value) / PRESET_LIMITS.channelStep));
  const packed = (five(color.r) << 10) | (five(color.g) << 5) | five(color.b);
  let out = '';
  for (let shift = 10; shift >= 0; shift -= 5) {
    out += PRESET_ALPHABET[(packed >> shift) & 31];
  }
  return out;
}

function unpackTriplet(chars: string): RGB {
  let packed = 0;
  for (const char of chars) {
    const value = ALPHABET_INDEX.get(char);
    if (value === undefined) {
      throw new PresetError('PRESET_MALFORMED', `Invalid preset character "${char}"`);
    }
    packed = (packed << 5) | value;
  }
  const expand = (five: number): number => five * PRESET_LIMITS.channelStep;
  const color = { r: expand((packed >> 10) & 31), g: expand((packed >> 5) & 31), b: expand(packed & 31) };
  if (color.r > 255 || color.g > 255 || color.b > 255) {
    throw new PresetError('PRESET_RANGE', 'Preset colour is outside the 0–255 range');
  }
  return color;
}

function checksumChars(payload: string): string {
  const digest = createHash('sha256').update(payload).digest();
  const bits = (digest[0] << 12) | (digest[1] << 4) | (digest[2] >> 4);
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) {
    out += PRESET_ALPHABET[(bits >> shift) & 31];
  }
  return out;
}

/**
 * Strip formatting people (or chat apps) add: spaces, dashes, lower case.
 * Dashes are removed entirely, so the canonical code re-inserts the prefix
 * separator rather than relying on the caller having kept it.
 */
export function normalisePresetCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s\-_]/g, '');
}

const PREFIX_BARE = 'LC1';

export function presetTierFor(patches: number): PresetTier {
  if (patches >= 6) return 'd';
  if (patches >= 3) return 'c';
  return patches === 2 ? 'b' : 'a';
}

export function encodePreset(tier: PresetTier, patches: PresetPatch[]): string {
  const limits = PRESET_TIERS[tier];
  if (!limits) {
    throw new PresetError('PRESET_TIER', `Unknown preset tier "${tier}"`);
  }
  if (patches.length < limits.minPoints || patches.length > limits.maxPoints) {
    throw new PresetError(
      'PRESET_POINTS',
      `Tier "${tier}" accepts ${limits.minPoints}–${limits.maxPoints} points, got ${patches.length}`
    );
  }
  const seen = new Set<string>();
  for (const patch of patches) {
    const key = `${clamp8(patch.sampledColor.r)},${clamp8(patch.sampledColor.g)},${clamp8(patch.sampledColor.b)}`;
    if (seen.has(key)) {
      throw new PresetError(
        'PRESET_DUPLICATE',
        'Two points measured the same colour — move one point onto a different patch'
      );
    }
    seen.add(key);
  }
  const body = patches
    .map((patch) => packTriplet(patch.sampledColor) + packTriplet(patch.targetColor))
    .join('');
  const payload = tier + body;
  return PRESET_PREFIX + payload + checksumChars(payload);
}

export function decodePreset(input: string): DecodedPreset {
  const normalised = normalisePresetCode(input);
  if (!normalised) {
    throw new PresetError('PRESET_MALFORMED', 'Calibration code is empty');
  }
  if (!normalised.startsWith(PREFIX_BARE)) {
    throw new PresetError('PRESET_VERSION', `Calibration code must start with ${PREFIX_BARE}`);
  }
  const payload = normalised.slice(PREFIX_BARE.length);
  if (payload.length < 1 + 6 + 4 || payload.length > PRESET_LIMITS.maxLength) {
    throw new PresetError('PRESET_MALFORMED', 'Calibration code length is out of range');
  }

  const tier = payload[0].toLowerCase() as PresetTier;
  if (!(tier in PRESET_TIERS)) {
    throw new PresetError('PRESET_TIER', `Unknown preset tier "${payload[0]}"`);
  }
  const body = payload.slice(1, -4);
  const provided = payload.slice(-4);
  if (checksumChars(tier + body) !== provided) {
    throw new PresetError('PRESET_CHECKSUM', 'Calibration code checksum does not match');
  }
  if (body.length % 6 !== 0) {
    throw new PresetError('PRESET_MALFORMED', 'Calibration code does not contain whole points');
  }

  const count = body.length / 6;
  const limits = PRESET_TIERS[tier];
  if (count < limits.minPoints || count > limits.maxPoints) {
    throw new PresetError(
      'PRESET_POINTS',
      `Tier "${tier}" accepts ${limits.minPoints}–${limits.maxPoints} points, got ${count}`
    );
  }

  const patches: PresetPatch[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < body.length; offset += 6) {
    const sampledColor = unpackTriplet(body.slice(offset, offset + 3));
    const targetColor = unpackTriplet(body.slice(offset + 3, offset + 6));
    for (const channel of ['r', 'g', 'b'] as const) {
      if (Math.abs(sampledColor[channel] - targetColor[channel]) > PRESET_LIMITS.maxAbsChannelDelta) {
        throw new PresetError('PRESET_RANGE', 'Patch claims an implausible colour shift');
      }
    }
    const key = `${sampledColor.r},${sampledColor.g},${sampledColor.b}`;
    if (seen.has(key)) {
      throw new PresetError('PRESET_DUPLICATE', 'Patch repeats the same sampled colour');
    }
    seen.add(key);
    patches.push({ sampledColor, targetColor });
  }

  // Re-encode so the canonical form is byte-identical to what a caller who
  // normalised the code would produce (the tier letter is case-insensitive on
  // input, but the checksum is computed over the lower-case form).
  return { prefix: PRESET_PREFIX, tier, patches, code: encodePreset(tier, patches) };
}

export function presetToPoints(decoded: DecodedPreset): ColorPoint[] {
  return decoded.patches.map((patch, index) => ({
    id: `p${index + 1}`,
    label: `patch ${index + 1}`,
    role: 'custom' as const,
    x: 0,
    y: 0,
    sampledColor: patch.sampledColor,
    targetColor: patch.targetColor,
  }));
}

/**
 * Decode → re-fit → validate. The returned matrix always comes from the engine
 * on the server; nothing about it is taken from the client's word.
 */
export function assessPreset(input: string): PresetAssessment {
  const decoded = decodePreset(input);
  const points = presetToPoints(decoded);

  let fit;
  try {
    fit = calculateMatrixDetailed(points, 'advanced');
  } catch (error) {
    throw new PresetError(
      'PRESET_UNUSABLE',
      error instanceof Error ? `Patches cannot be fitted: ${error.message}` : 'Patches cannot be fitted'
    );
  }

  const matrix = fit.matrix;
  // Guardrails from the same module the interactive app uses: a preset cannot
  // smuggle a rank-collapsing or clipping matrix past an anonymous request.
  const diagnostics = assessMatrix(matrix);
  if (diagnostics.destructive) {
    throw new PresetError(
      'PRESET_WEAK',
      `Calibration rejected by colour guardrail (${diagnostics.reasons.join('; ')})`
    );
  }
  // The engine falls back to an identity matrix when the patches describe
  // something destructive. Identity is a safe preview, never a calibration a
  // client may claim — so an anonymous request must be refused, not corrected
  // with "no change" and reported as success.
  if (fit.diagnostics?.destructiveFallback) {
    throw new PresetError(
      'PRESET_UNUSABLE',
      'Patches describe a correction the engine refuses to apply (identity fallback)'
    );
  }
  // A "fit" whose residual is at pixel-noise scale means the patches described
  // no usable correction: the engine fell back to identity and reported why.
  if (!Number.isFinite(fit.meanResidual) || fit.meanResidual > PRESET_LIMITS.maxResidual) {
    const detail = fit.warnings?.length ? ` (${fit.warnings[fit.warnings.length - 1]})` : '';
    throw new PresetError(
      'PRESET_UNUSABLE',
      `Patches do not describe a usable correction: residual ${fit.meanResidual.toFixed(1)}${detail}`
    );
  }

  // Bounds are enforced here as well as inside the engine so a future engine
  // change cannot silently widen what an unauthenticated caller can submit.
  let maxCoefficient = 0;
  for (const row of matrix.matrix) {
    for (const coefficient of row) {
      maxCoefficient = Math.max(maxCoefficient, Math.abs(coefficient));
    }
  }
  const maxOffset = Math.max(
    Math.abs(matrix.offset.r),
    Math.abs(matrix.offset.g),
    Math.abs(matrix.offset.b)
  );
  if (maxCoefficient > MATRIX_LIMITS.maxAbsCoefficient || maxOffset > MATRIX_LIMITS.maxAbsOffset) {
    throw new PresetError('PRESET_UNUSABLE', 'Derived matrix exceeds supported bounds');
  }

  return {
    decoded,
    matrix,
    residual: fit.meanResidual,
    warnings: fit.warnings ?? [],
    diagnostics,
    fit: fit.diagnostics,
  };
}

/** Display-referred residual of one patch, for reporting fit quality. */
export function patchResidual(patch: PresetPatch, matrix: ColorMatrix): number {
  const out = applyColorMatrix(patch.sampledColor, matrix);
  return (
    (Math.abs(out.r - patch.targetColor.r) +
      Math.abs(out.g - patch.targetColor.g) +
      Math.abs(out.b - patch.targetColor.b)) /
    3
  );
}

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

export const PRESET_PREFIX = 'LC2-';

/** One colour triplet: 3 channels × 6 bits = 19 significant bits, in 4 chars. */
const TRIPLET_CHARS = 4;
/** One patch: sampled + intended colour. */
const PATCH_CHARS = TRIPLET_CHARS * 2;


/** Tier letters and the point counts they allow. */
export const PRESET_TIERS = {
  a: { minPoints: 1, maxPoints: 1 },
  b: { minPoints: 2, maxPoints: 2 },
  c: { minPoints: 3, maxPoints: 5 },
  d: { minPoints: 6, maxPoints: 12 },
} as const;

export type PresetTier = keyof typeof PRESET_TIERS;

/** Checksum width. Must match `checksumChars`. */
const CHECKSUM_CHARS = 4;

/**
 * Roles decide the fit: the engine branches on white/grey/black anchors, and
 * fitting the same patch numbers without roles produced visibly different
 * images (up to 59/255). So the code carries each patch's role, 2 bits each.
 */
export const PRESET_ROLES = ['white', 'grey', 'black', 'custom'] as const;
export type PresetRole = (typeof PRESET_ROLES)[number];

const rolesToBits = (patches: PresetPatch[]): string => {
  const chars: string[] = [];
  for (let i = 0; i < patches.length; i += 5) {
    let packed = 0;
    // 5 roles × 2 bits = 10 bits → 2 chars.
    for (let j = 0; j < 5; j += 1) {
      const patch = patches[i + j];
      const index = patch ? PRESET_ROLES.indexOf(patch.role) : 0;
      packed = (packed << 2) | (index < 0 ? 0 : index);
    }
    chars.push(PRESET_ALPHABET[(packed >> 5) & 31], PRESET_ALPHABET[packed & 31]);
  }
  return chars.join('');
};

const bitsToRoles = (chars: string, count: number): PresetRole[] => {
  const roles: PresetRole[] = [];
  for (let i = 0; i < chars.length; i += 2) {
    let packed = 0;
    for (const char of chars.slice(i, i + 2)) {
      const value = ALPHABET_INDEX.get(char);
      if (value === undefined) {
        throw new PresetError('PRESET_MALFORMED', `Invalid preset character "${char}"`);
      }
      packed = (packed << 5) | value;
    }
    for (let j = 0; j < 5; j += 1) {
      const index = (packed >> (8 - j * 2)) & 3;
      roles.push(PRESET_ROLES[index]);
    }
  }
  return roles.slice(0, count);
};

export const PRESET_LIMITS = {
  /** Longest accepted code: tier + 12 patches + checksum. */
  maxLength: 1 + PRESET_TIERS.d.maxPoints * PATCH_CHARS + CHECKSUM_CHARS,
  /**
   * Worst-case error from 6-bit coding is about 2/255 (levels are spread across
   * the whole 0–255 range, so the step is 255/63 ≈ 4.05). An 8-bit canvas can produce
   * every integer 0–255, so rounding to steps of 8 shifted the fitted matrix
   * enough to move output pixels by up to 45/255 against the browser's own fit.
   * 6 bits keeps the code short while staying inside the noise floor of a card
   * reading (measured parity: ≤3/255).
   */
  channelStep: 4,
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
  /** Patch role; drives which fit branch the engine takes. */
  role: PresetRole;
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

/** 6-bit level for a channel; the inverse of the expansion used when decoding. */
const levelOf = (value: number): number => Math.min(63, Math.max(0, Math.round((clamp8(value) * 63) / 255)));

/**
 * Round a channel to the precision the code can carry. The browser applies this
 * *before* fitting, so both sides fit from literally the same integers and the
 * matrices match exactly instead of merely closely. Close is not enough: the
 * 8-bit encode is gamma-steep near black, where a 0.001 linear difference can
 * show as tens of steps.
 */
export function quantiseChannel(value: number): number {
  // 64 levels spread across the full 0–255 range so 255 is representable.
  // Rounding 255/4 into 63 levels would land on 252 and quietly tell the engine
  // that "white" is 252, biasing every target.
  return Math.round((levelOf(value) * 255) / 63);
}

export function quantisePatch<T extends { sampledColor: RGB; targetColor: RGB }>(patch: T): T {
  const quantise = (color: RGB): RGB => ({
    r: quantiseChannel(color.r),
    g: quantiseChannel(color.g),
    b: quantiseChannel(color.b),
  });
  return { ...patch, sampledColor: quantise(patch.sampledColor), targetColor: quantise(patch.targetColor) };
}

function packTriplet(color: RGB): string {
  // Quantise to 6 bits per channel, then pack: r in bits 17–12, g in 11–6, b in 5–0.
  // The division must happen before the shift, and the quotient clamped to 63 so
  // a 255 reading cannot overflow into the next channel.
  const packed = (levelOf(color.r) << 12) | (levelOf(color.g) << 6) | levelOf(color.b);
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) {
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
  const expand = (level: number): number => Math.round((level * 255) / 63);
  const color = { r: expand((packed >> 12) & 63), g: expand((packed >> 6) & 63), b: expand(packed & 63) };
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
  return out.slice(0, CHECKSUM_CHARS);
}

/**
 * Strip formatting people (or chat apps) add: spaces, dashes, lower case.
 * Dashes are removed entirely, so the canonical code re-inserts the prefix
 * separator rather than relying on the caller having kept it.
 */
export function normalisePresetCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s\-_]/g, '');
}

const PREFIX_BARE = PRESET_PREFIX.replace('-', '');

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
  const colors = patches
    .map((patch) => packTriplet(patch.sampledColor) + packTriplet(patch.targetColor))
    .join('');
  const payload = tier + rolesToBits(patches) + colors;
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
  if (payload.length < 1 + PATCH_CHARS + CHECKSUM_CHARS || payload.length > PRESET_LIMITS.maxLength) {
    throw new PresetError('PRESET_MALFORMED', 'Calibration code length is out of range');
  }

  const tier = payload[0].toLowerCase() as PresetTier;
  if (!(tier in PRESET_TIERS)) {
    throw new PresetError('PRESET_TIER', `Unknown preset tier "${payload[0]}"`);
  }
  // Split at the known boundary rather than assuming a fixed checksum width.
  const body = payload.slice(1, payload.length - CHECKSUM_CHARS);
  const provided = payload.slice(payload.length - CHECKSUM_CHARS);
  if (checksumChars(tier + body) !== provided) {
    throw new PresetError('PRESET_CHECKSUM', 'Calibration code checksum does not match');
  }
  // Roles occupy a whole number of 2-char groups (5 patches each), then the
  // colour body follows. The tier tells us how many patches to expect, so the
  // boundary is derived rather than guessed.
  const roleCharsFor = (patchCount: number): number => Math.ceil(patchCount / 5) * 2;
  const colorCharsFor = (patchCount: number): number => patchCount * PATCH_CHARS;
  const totalFor = (patchCount: number): number => roleCharsFor(patchCount) + colorCharsFor(patchCount);

  const candidates = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter(
    (n) => n >= PRESET_TIERS[tier].minPoints && n <= PRESET_TIERS[tier].maxPoints
  );
  const count = candidates.find((n) => totalFor(n) === body.length);
  if (!count) {
    throw new PresetError('PRESET_MALFORMED', 'Calibration code does not contain whole points');
  }
  const roles = bitsToRoles(body.slice(0, roleCharsFor(count)), count);
  const colors = body.slice(roleCharsFor(count));
  const limits = PRESET_TIERS[tier];
  if (count < limits.minPoints || count > limits.maxPoints) {
    throw new PresetError(
      'PRESET_POINTS',
      `Tier "${tier}" accepts ${limits.minPoints}–${limits.maxPoints} points, got ${count}`
    );
  }

  const patches: PresetPatch[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < colors.length; offset += PATCH_CHARS) {
    const sampledColor = unpackTriplet(colors.slice(offset, offset + TRIPLET_CHARS));
    const targetColor = unpackTriplet(colors.slice(offset + TRIPLET_CHARS, offset + PATCH_CHARS));
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
    patches.push({ sampledColor, targetColor, role: roles[offset / PATCH_CHARS] });
  }

  // Re-encode so the canonical form is byte-identical to what a caller who
  // normalised the code would produce (the tier letter is case-insensitive on
  // input, but the checksum is computed over the lower-case form).
  return { prefix: PRESET_PREFIX, tier, patches, code: encodePreset(tier, patches) };
}

export function presetToPoints(decoded: DecodedPreset): ColorPoint[] {
  return decoded.patches.map((patch, index) => ({
    id: `p${index + 1}`,
    // Role labels matter: inferPointRole reads the label when no explicit role
    // is present, and the angle (white/grey/black) selects the fit branch.
    label: patch.role === 'custom' ? `patch ${index + 1}` : patch.role,
    role: patch.role,
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

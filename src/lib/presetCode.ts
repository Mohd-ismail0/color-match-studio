/**
 * Browser-side preset codes.
 *
 * Deliberately a mirror of `api/preset.ts`'s encoder, because the browser must
 * hand a user a code the API will accept. The two implementations are compared
 * in `api/preset.test.ts` so drift shows up as a failing test rather than a code
 * that fails in production hours later.
 *
 * Only encoding lives here: the browser produces evidence (what it measured and
 * what the patches are supposed to be). It never ships a matrix to the API.
 */

export const PRESET_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PRESET_PREFIX = 'LC2-';

/** One colour triplet: 3 channels × 6 bits = 19 significant bits, in 4 chars. */
const TRIPLET_CHARS = 4;
/** One patch: sampled + intended colour. */
const PATCH_CHARS = TRIPLET_CHARS * 2;
/** Checksum width. Must match the server's CHECKSUM_CHARS. */
const CHECKSUM_CHARS = 4;

export const PRESET_TIERS = {
  a: { minPoints: 1, maxPoints: 1 },
  b: { minPoints: 2, maxPoints: 2 },
  c: { minPoints: 3, maxPoints: 5 },
  d: { minPoints: 6, maxPoints: 12 },
} as const;

export type PresetTier = keyof typeof PRESET_TIERS;

/**
 * 6 bits per channel, spread across the full 0–255 range (worst-case error
 * ~2/255). Coarser coding measurably shifted the fitted matrix away from the
 * browser's own fit, which would make "correct in the browser" and "correct via
 * the code" disagree. See src/test/presetParity.test.ts.
 */
export const PRESET_CHANNEL_STEP = 255 / 63;

/**
 * Roles travel with each patch because the engine's fit branches on
 * white/grey/black anchors. Omitting them made the same card produce different
 * images in the browser and via the code (measured: up to 59/255).
 */
export const PRESET_ROLES = ['white', 'grey', 'black', 'custom'] as const;
export type PresetRole = (typeof PRESET_ROLES)[number];

export interface PresetPatch {
  sampledColor: { r: number; g: number; b: number };
  targetColor: { r: number; g: number; b: number };
  role: PresetRole;
}

/** 5 roles × 2 bits = 10 bits → 2 chars per group of five patches. */
function rolesToBits(patches: PresetPatch[]): string {
  const chars: string[] = [];
  for (let i = 0; i < patches.length; i += 5) {
    let packed = 0;
    for (let j = 0; j < 5; j += 1) {
      const patch = patches[i + j];
      const index = patch ? PRESET_ROLES.indexOf(patch.role) : 0;
      packed = (packed << 2) | (index < 0 ? 0 : index);
    }
    chars.push(PRESET_ALPHABET[(packed >> 5) & 31], PRESET_ALPHABET[packed & 31]);
  }
  return chars.join('');
}

export class PresetEncodeError extends Error {
  constructor(
    readonly code: 'PRESET_POINTS' | 'PRESET_DUPLICATE' | 'PRESET_TIER',
    message: string
  ) {
    super(message);
    this.name = 'PresetEncodeError';
  }
}

const clamp8 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/**
 * Round a channel to the precision the code can carry. Applied *before* fitting
 * so the browser and the API fit from the same integers and produce identical
 * matrices — matching them approximately is not enough, because the 8-bit
 * encode is steep near black and turns tiny linear differences into tens of
 * steps.
 */
export function quantiseChannel(value: number): number {
  // 64 levels spread across the full 0–255 range so 255 stays representable.
  // Quantising against a fixed step lands pure white on 252 and biases targets.
  const level = Math.min(63, Math.max(0, Math.round((clamp8(value) * 63) / 255)));
  return Math.round((level * 255) / 63);
}

/** 6-bit level for a channel; inverse of the expansion used when decoding. */
const levelOf = (value: number): number =>
  Math.min(63, Math.max(0, Math.round((clamp8(value) * 63) / 255)));

export function quantiseColour<T extends { r: number; g: number; b: number }>(color: T): T {
  return {
    ...color,
    r: quantiseChannel(color.r),
    g: quantiseChannel(color.g),
    b: quantiseChannel(color.b),
  };
}

function packTriplet(color: { r: number; g: number; b: number }): string {
  // Quantise to 6 bits per channel, then pack: r in bits 17–12, g in 11–6, b in 5–0.
  const packed = (levelOf(color.r) << 12) | (levelOf(color.g) << 6) | levelOf(color.b);
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) {
    out += PRESET_ALPHABET[(packed >> shift) & 31];
  }
  return out;
}

export function presetTierFor(patches: number): PresetTier {
  if (patches >= 6) return 'd';
  if (patches >= 3) return 'c';
  return patches === 2 ? 'b' : 'a';
}

/**
 * SHA-256 over the payload, truncated to 20 bits. WebCrypto is async and is not
 * available on insecure origins, so this uses a small, self-contained
 * implementation of the same digest the API computes.
 */
function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLength = bytes.length * 8;
  // pad = 0x80 byte + 8 length bytes; round up to the next 64-byte block.
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  return [...H].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function checksumChars(payload: string): string {
  const hex = sha256Hex(payload);
  const byte = (index: number): number => parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  const bits = (byte(0) << 12) | (byte(1) << 4) | (byte(2) >> 4);
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) {
    out += PRESET_ALPHABET[(bits >> shift) & 31];
  }
  return out.slice(0, CHECKSUM_CHARS);
}

export function encodePreset(patches: PresetPatch[], tier?: PresetTier): string {
  if (patches.length === 0) {
    throw new PresetEncodeError('PRESET_POINTS', 'Add at least one reference point');
  }
  const resolved = tier ?? presetTierFor(patches.length);
  const limits = PRESET_TIERS[resolved];
  if (!limits) {
    throw new PresetEncodeError('PRESET_TIER', `Unknown tier "${resolved}"`);
  }
  if (patches.length < limits.minPoints || patches.length > limits.maxPoints) {
    throw new PresetEncodeError(
      'PRESET_POINTS',
      `Tier "${resolved}" accepts ${limits.minPoints}–${limits.maxPoints} points, got ${patches.length}`
    );
  }
  const seen = new Set<string>();
  for (const patch of patches) {
    const key = `${clamp8(patch.sampledColor.r)},${clamp8(patch.sampledColor.g)},${clamp8(patch.sampledColor.b)}`;
    if (seen.has(key)) {
      throw new PresetEncodeError(
        'PRESET_DUPLICATE',
        'Two points measured the same colour — move one point onto a different patch'
      );
    }
    seen.add(key);
  }
  const colors = patches
    .map((patch) => packTriplet(patch.sampledColor) + packTriplet(patch.targetColor))
    .join('');
  const payload = resolved + rolesToBits(patches) + colors;
  return PRESET_PREFIX + payload + checksumChars(payload);
}

/**
 * Grouped for reading on screen. The prefix is deliberately kept: a code shown
 * without it looks like something else entirely, and the API's normaliser
 * strips spacing anyway.
 */
/**
 * Groups the code for reading aloud or transcribing. Cosmetic only: removing
 * the spaces must return the exact code, so what a user sees and what the copy
 * button puts on the clipboard are the same value. Uppercasing here would have
 * mangled the lowercase tier letter and re-kept the prefix dash, producing
 * "LC2--D3FZG…" — accepted by the API (it normalises), but not a faithful
 * display of the code that was built.
 */
export function formatPresetForDisplay(code: string): string {
  const body = code.trim();
  if (!body.startsWith(PRESET_PREFIX)) return code;
  return PRESET_PREFIX + body.slice(PRESET_PREFIX.length).replace(/(.{6})/g, '$1 ').trim();
}

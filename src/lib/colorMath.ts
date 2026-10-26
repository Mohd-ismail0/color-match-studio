import type { ColorMatrix, RGB } from '@/types/colorCorrector';

/**
 * Colour maths shared by the browser pipeline and the Node API.
 *
 * Encoding uses fixed quantised LUTs on both sides so that the exact same
 * matrix produces byte-identical output in the UI and through /v1/correct
 * (audit C8). The 8-bit LUT introduces at most a fraction of one display code
 * value versus a full-precision float reference; this is a quantisation bound,
 * not a colour-accuracy claim.
 */

export const SRGB_TO_LINEAR_8 = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) table[i] = srgbToLinear(i);
  return table;
})();

export const LINEAR_TO_SRGB_8 = (() => {
  const table = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    table[i] = Math.max(0, Math.min(255, Math.round(linearToSrgb(i / 65535))));
  }
  return table;
})();

export const LINEAR_TO_SRGB_16 = (() => {
  const table = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    table[i] = Math.max(0, Math.min(65535, Math.round(linearToSrgb(i / 65535) * 257)));
  }
  return table;
})();

let srgbToLinear16Cache: Float32Array | null = null;

export function getSrgbToLinear16Table(): Float32Array {
  if (!srgbToLinear16Cache) {
    const table = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) table[i] = srgbToLinear(i / 257);
    srgbToLinear16Cache = table;
  }
  return srgbToLinear16Cache;
}

export function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** sRGB (0–255) → linear (0–1) */
export function srgbToLinear(channel: number): number {
  const c = Math.max(0, Math.min(255, channel)) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** linear (0–1) → sRGB (0–255 float, unclamped before round) */
export function linearToSrgb(linear: number): number {
  const c = Math.max(0, linear);
  const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return srgb * 255;
}

export function rgbToLinear(rgb: RGB): RGB {
  return {
    r: srgbToLinear(rgb.r),
    g: srgbToLinear(rgb.g),
    b: srgbToLinear(rgb.b),
  };
}

/** Quantised linear→8-bit encode used by every pipeline path. */
export function encodeLinear8(linear: number): number {
  if (!(linear > 0)) return 0;
  if (linear >= 1) return 255;
  return LINEAR_TO_SRGB_8[(linear * 65535 + 0.5) | 0];
}

/** Quantised linear→16-bit encode (PNG master path). */
export function encodeLinear16(linear: number): number {
  if (!(linear > 0)) return 0;
  if (linear >= 1) return 65535;
  return LINEAR_TO_SRGB_16[(linear * 65535 + 0.5) | 0];
}

export function applyMatrixLinear(colorLinear: RGB, matrix: ColorMatrix): RGB {
  const { matrix: m, offset } = matrix;
  return {
    r: m[0][0] * colorLinear.r + m[0][1] * colorLinear.g + m[0][2] * colorLinear.b + offset.r,
    g: m[1][0] * colorLinear.r + m[1][1] * colorLinear.g + m[1][2] * colorLinear.b + offset.g,
    b: m[2][0] * colorLinear.r + m[2][1] * colorLinear.g + m[2][2] * colorLinear.b + offset.b,
  };
}

/** Apply matrix in linear light, return display-referred 8-bit RGB. */
export function applyColorMatrix(color: RGB, matrix: ColorMatrix): RGB {
  const linear = applyMatrixLinear(rgbToLinear(color), matrix);
  return {
    r: encodeLinear8(linear.r),
    g: encodeLinear8(linear.g),
    b: encodeLinear8(linear.b),
  };
}

/** In-place RGBA8 correction (alpha untouched). Shared by UI and worker. */
export function applyMatrixToRgba8(data: Uint8Array | Uint8ClampedArray, matrix: ColorMatrix): void {
  const { matrix: m, offset } = matrix;
  const toLinear = SRGB_TO_LINEAR_8;
  for (let i = 0; i < data.length; i += 4) {
    const r = toLinear[data[i]];
    const g = toLinear[data[i + 1]];
    const b = toLinear[data[i + 2]];
    data[i] = encodeLinear8(m[0][0] * r + m[0][1] * g + m[0][2] * b + offset.r);
    data[i + 1] = encodeLinear8(m[1][0] * r + m[1][1] * g + m[1][2] * b + offset.g);
    data[i + 2] = encodeLinear8(m[2][0] * r + m[2][1] * g + m[2][2] * b + offset.b);
  }
}

/**
 * In-place RGBA16 correction. `data` is big-endian? No: raw 16-bit PNG data
 * from libvips is host-endian (little-endian on x86/arm), matching Uint16Array.
 * Alpha is left untouched.
 */
export function applyMatrixToRgba16(
  data: Uint16Array,
  matrix: ColorMatrix,
  toLinear: Float32Array = getSrgbToLinear16Table()
): void {
  const { matrix: m, offset } = matrix;
  for (let i = 0; i < data.length; i += 4) {
    const r = toLinear[data[i]];
    const g = toLinear[data[i + 1]];
    const b = toLinear[data[i + 2]];
    data[i] = encodeLinear16(m[0][0] * r + m[0][1] * g + m[0][2] * b + offset.r);
    data[i + 1] = encodeLinear16(m[1][0] * r + m[1][1] * g + m[1][2] * b + offset.g);
    data[i + 2] = encodeLinear16(m[2][0] * r + m[2][1] * g + m[2][2] * b + offset.b);
  }
}

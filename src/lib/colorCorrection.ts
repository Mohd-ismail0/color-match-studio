import {
  RGB,
  ColorPoint,
  ColorMatrix,
  ColorPointRole,
  MatrixFitResult,
} from '@/types/colorCorrector';

const IDENTITY_MATRIX: ColorMatrix = {
  matrix: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  offset: { r: 0, g: 0, b: 0 },
};

/** Longest edge cap to avoid tab OOM on huge camera files */
export const MAX_IMAGE_DIMENSION = 8192;

/** Advanced fit rejected when mean residual exceeds this (8-bit DN) */
const MAX_MEAN_RESIDUAL = 18;

/** Ridge term for Tikhonov regularization of ATA */
const REGULARIZATION = 1e-4;

export function cloneIdentityMatrix(): ColorMatrix {
  return {
    matrix: IDENTITY_MATRIX.matrix.map((row) => [...row]),
    offset: { ...IDENTITY_MATRIX.offset },
  };
}

export function parseHexColor(hex: string): RGB | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!result) return null;
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

/** @deprecated Prefer parseHexColor for validation; returns black on failure */
export function hexToRgb(hex: string): RGB {
  return parseHexColor(hex) ?? { r: 0, g: 0, b: 0 };
}

export function rgbToHex(rgb: RGB): string {
  const toHex = (n: number) => {
    const hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
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

export function inferPointRole(label: string, explicit?: ColorPointRole): ColorPointRole {
  if (explicit && explicit !== 'custom') return explicit;
  const normalized = label.trim().toLowerCase();
  if (normalized === 'white') return 'white';
  if (normalized === 'grey' || normalized === 'gray') return 'grey';
  if (normalized === 'black') return 'black';
  return explicit ?? 'custom';
}

export function defaultTargetForRole(role: ColorPointRole, sampled: RGB): RGB {
  if (role === 'white') return { r: 255, g: 255, b: 255 };
  if (role === 'grey') return { r: 128, g: 128, b: 128 };
  if (role === 'black') return { r: 0, g: 0, b: 0 };
  return { ...sampled };
}

export function defaultLabelForRole(role: ColorPointRole, index: number): string {
  if (role === 'white') return 'White';
  if (role === 'grey') return 'Grey';
  if (role === 'black') return 'Black';
  return `Point ${index + 1}`;
}

export function nextAutoRole(points: ColorPoint[]): ColorPointRole {
  const roles = new Set(points.map((p) => inferPointRole(p.label, p.role)));
  if (!roles.has('white')) return 'white';
  if (!roles.has('grey')) return 'grey';
  if (!roles.has('black')) return 'black';
  return 'custom';
}

function findByRole(points: ColorPoint[], role: ColorPointRole): ColorPoint | undefined {
  return points.find((p) => inferPointRole(p.label, p.role) === role);
}

export function sampleColorFromCanvas(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  sampleSize: number = 5
): RGB {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { r: 0, g: 0, b: 0 };

  const halfSize = Math.floor(sampleSize / 2);
  const startX = Math.max(0, Math.floor(x) - halfSize);
  const startY = Math.max(0, Math.floor(y) - halfSize);
  const width = Math.min(sampleSize, canvas.width - startX);
  const height = Math.min(sampleSize, canvas.height - startY);

  if (width <= 0 || height <= 0) {
    return { r: 0, g: 0, b: 0 };
  }

  const imageData = ctx.getImageData(startX, startY, width, height);
  const data = imageData.data;

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let weightSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;

    // Softly down-weight heavily clipped specular / crushed pixels
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const clipped =
      (r <= 2 && g <= 2 && b <= 2) || (r >= 253 && g >= 253 && b >= 253) ? 0.25 : 1;

    const w = (a / 255) * clipped;
    totalR += r * w;
    totalG += g * w;
    totalB += b * w;
    weightSum += w;
  }

  if (weightSum < 1e-6) {
    return { r: 0, g: 0, b: 0 };
  }

  return {
    r: Math.round(totalR / weightSum),
    g: Math.round(totalG / weightSum),
    b: Math.round(totalB / weightSum),
  };
}

function channelScale(target: number, sampled: number): number {
  if (Math.abs(sampled) < 1e-9) {
    return Math.abs(target) < 1e-9 ? 1 : 0;
  }
  return target / sampled;
}

/**
 * Fit diagonal affine out = sample * scale + offset in linear light
 * using ordinary least squares over the provided reference points.
 */
function fitDiagonalAffine(points: ColorPoint[]): { scales: RGB; offsets: RGB } {
  const scales = { r: 1, g: 1, b: 1 };
  const offsets = { r: 0, g: 0, b: 0 };

  (['r', 'g', 'b'] as const).forEach((channel) => {
    const n = points.length;
    if (n === 1) {
      const p = points[0];
      const s = rgbToLinear(p.sampledColor)[channel];
      const t = rgbToLinear(p.targetColor)[channel];
      scales[channel] = channelScale(t, s);
      offsets[channel] = 0;
      return;
    }

    // Solve [s 1; ...] [scale; offset] = t  via normal equations
    let sumS = 0;
    let sumS2 = 0;
    let sumT = 0;
    let sumST = 0;

    for (const p of points) {
      const s = rgbToLinear(p.sampledColor)[channel];
      const t = rgbToLinear(p.targetColor)[channel];
      sumS += s;
      sumS2 += s * s;
      sumT += t;
      sumST += s * t;
    }

    const det = n * sumS2 - sumS * sumS;
    if (Math.abs(det) < 1e-12) {
      // Degenerate: fall back to mean scale, zero offset
      scales[channel] = channelScale(sumT / n, sumS / n);
      offsets[channel] = 0;
      return;
    }

    scales[channel] = (n * sumST - sumS * sumT) / det;
    offsets[channel] = (sumS2 * sumT - sumS * sumST) / det;
  });

  return { scales, offsets };
}

/**
 * Diagonal affine correction using white / grey / black reference points.
 * Fits in linear sRGB so neutrals and exposure behave more predictably.
 *
 * Priority (photography practice):
 * - White + Black → exact end-point stretch (locks levels)
 * - White or Grey alone → per-channel scale (WB / exposure)
 * - White + Grey → white scale (preserves white lock; grey is for advanced mode)
 * - Multiple role points without both ends → diagonal least squares
 */
export function calculateSimpleMatrix(points: ColorPoint[]): ColorMatrix {
  if (points.length === 0) {
    return cloneIdentityMatrix();
  }

  const whitePoint = findByRole(points, 'white');
  const greyPoint = findByRole(points, 'grey');
  const blackPoint = findByRole(points, 'black');

  if (whitePoint && blackPoint) {
    // Exact black→white linear stretch in linear light — locks the range
    const scales = { r: 1, g: 1, b: 1 };
    const offsets = { r: 0, g: 0, b: 0 };
    (['r', 'g', 'b'] as const).forEach((channel) => {
      const sampleLow = rgbToLinear(blackPoint.sampledColor)[channel];
      const sampleHigh = rgbToLinear(whitePoint.sampledColor)[channel];
      const targetLow = rgbToLinear(blackPoint.targetColor)[channel];
      const targetHigh = rgbToLinear(whitePoint.targetColor)[channel];
      const delta = sampleHigh - sampleLow;
      if (Math.abs(delta) < 1e-9) {
        scales[channel] = 1;
        offsets[channel] = targetLow - sampleLow;
      } else {
        scales[channel] = (targetHigh - targetLow) / delta;
        offsets[channel] = targetLow - sampleLow * scales[channel];
      }
    });
    return {
      matrix: [
        [scales.r, 0, 0],
        [0, scales.g, 0],
        [0, 0, scales.b],
      ],
      offset: offsets,
    };
  }

  const fitPoints = [whitePoint, greyPoint, blackPoint].filter(
    (p): p is ColorPoint => !!p
  );
  const { scales, offsets } = fitDiagonalAffine(
    fitPoints.length > 0 ? fitPoints : [points[0]]
  );

  return {
    matrix: [
      [scales.r, 0, 0],
      [0, scales.g, 0],
      [0, 0, scales.b],
    ],
    offset: offsets,
  };
}

function applyMatrixLinear(colorLinear: RGB, matrix: ColorMatrix): RGB {
  const { matrix: m, offset } = matrix;
  return {
    r: m[0][0] * colorLinear.r + m[0][1] * colorLinear.g + m[0][2] * colorLinear.b + offset.r,
    g: m[1][0] * colorLinear.r + m[1][1] * colorLinear.g + m[1][2] * colorLinear.b + offset.g,
    b: m[2][0] * colorLinear.r + m[2][1] * colorLinear.g + m[2][2] * colorLinear.b + offset.b,
  };
}

export function meanAbsoluteResidual(points: ColorPoint[], matrix: ColorMatrix): number {
  if (points.length === 0) return 0;
  let total = 0;
  for (const p of points) {
    const out = applyColorMatrix(p.sampledColor, matrix);
    total +=
      Math.abs(out.r - p.targetColor.r) +
      Math.abs(out.g - p.targetColor.g) +
      Math.abs(out.b - p.targetColor.b);
  }
  return total / (points.length * 3);
}

function rgbVolumeHeuristic(points: ColorPoint[]): number {
  if (points.length < 3) return 0;
  const a = rgbToLinear(points[0].sampledColor);
  const b = rgbToLinear(points[1].sampledColor);
  const c = rgbToLinear(points[2].sampledColor);
  // Scalar triple product magnitude — near 0 means collinear (e.g. greyscale only)
  const ab = { r: b.r - a.r, g: b.g - a.g, b: b.b - a.b };
  const ac = { r: c.r - a.r, g: c.g - a.g, b: c.b - a.b };
  const cross = {
    r: ab.g * ac.b - ab.b * ac.g,
    g: ab.b * ac.r - ab.r * ac.b,
    b: ab.r * ac.g - ab.g * ac.r,
  };
  return Math.sqrt(cross.r * cross.r + cross.g * cross.g + cross.b * cross.b);
}

/**
 * Multi-point least-squares color correction in linear sRGB.
 * Uses Tikhonov regularization and falls back to simple mode when
 * patches are collinear or residual is too high (classic W/G/B greyscale trap).
 */
export function calculateAdvancedMatrix(points: ColorPoint[]): ColorMatrix {
  return calculateAdvancedMatrixDetailed(points).matrix;
}

export function calculateAdvancedMatrixDetailed(points: ColorPoint[]): MatrixFitResult {
  if (points.length < 3) {
    const matrix = calculateSimpleMatrix(points);
    return {
      matrix,
      meanResidual: meanAbsoluteResidual(points, matrix),
      fellBackToSimple: true,
      warning: 'Need at least 3 color patches for multi-point mode.',
    };
  }

  // Greyscale-only patches can't constrain a full 3×3 — fall back early
  if (rgbVolumeHeuristic(points) < 1e-4 && points.length <= 4) {
    const matrix = calculateSimpleMatrix(points);
    return {
      matrix,
      meanResidual: meanAbsoluteResidual(points, matrix),
      fellBackToSimple: true,
      warning:
        'Calibration points are nearly collinear (e.g. only neutrals). Using 3-point diagonal correction instead.',
    };
  }

  const useOffset = points.length >= 4;
  const linearSamples = points.map((p) => rgbToLinear(p.sampledColor));
  const linearTargets = points.map((p) => rgbToLinear(p.targetColor));

  const A: number[][] = linearSamples.map((s) =>
    useOffset ? [s.r, s.g, s.b, 1] : [s.r, s.g, s.b]
  );

  const solveForChannel = (targetValues: number[]): number[] => {
    const AT = transpose(A);
    const ATA = multiply(AT, A);
    // Tikhonov: ATA + λI
    for (let i = 0; i < ATA.length; i++) {
      ATA[i][i] += REGULARIZATION;
    }
    const ATb = multiplyVector(AT, targetValues);
    return solveLinear(ATA, ATb);
  };

  const coeffR = solveForChannel(linearTargets.map((t) => t.r));
  const coeffG = solveForChannel(linearTargets.map((t) => t.g));
  const coeffB = solveForChannel(linearTargets.map((t) => t.b));

  if (!isFiniteVector(coeffR) || !isFiniteVector(coeffG) || !isFiniteVector(coeffB)) {
    const matrix = calculateSimpleMatrix(points);
    return {
      matrix,
      meanResidual: meanAbsoluteResidual(points, matrix),
      fellBackToSimple: true,
      warning: 'Multi-point solve failed numerically. Using 3-point correction.',
    };
  }

  const matrix: ColorMatrix = {
    matrix: [
      [coeffR[0], coeffR[1], coeffR[2]],
      [coeffG[0], coeffG[1], coeffG[2]],
      [coeffB[0], coeffB[1], coeffB[2]],
    ],
    offset: useOffset
      ? {
          r: coeffR[3] ?? 0,
          g: coeffG[3] ?? 0,
          b: coeffB[3] ?? 0,
        }
      : { r: 0, g: 0, b: 0 },
  };

  const residual = meanAbsoluteResidual(points, matrix);
  if (residual > MAX_MEAN_RESIDUAL) {
    const fallback = calculateSimpleMatrix(points);
    return {
      matrix: fallback,
      meanResidual: meanAbsoluteResidual(points, fallback),
      fellBackToSimple: true,
      warning: `Multi-point fit residual too high (${residual.toFixed(1)}). Using 3-point correction.`,
    };
  }

  return {
    matrix,
    meanResidual: residual,
    fellBackToSimple: false,
  };
}

export function calculateMatrix(
  points: ColorPoint[],
  mode: 'simple' | 'advanced'
): ColorMatrix {
  return mode === 'advanced'
    ? calculateAdvancedMatrix(points)
    : calculateSimpleMatrix(points);
}

export function calculateMatrixDetailed(
  points: ColorPoint[],
  mode: 'simple' | 'advanced'
): MatrixFitResult {
  if (mode === 'advanced') {
    return calculateAdvancedMatrixDetailed(points);
  }
  const matrix = calculateSimpleMatrix(points);
  return {
    matrix,
    meanResidual: meanAbsoluteResidual(points, matrix),
    fellBackToSimple: false,
  };
}

function isFiniteVector(values: number[]): boolean {
  return values.length > 0 && values.every((v) => Number.isFinite(v));
}

function transpose(m: number[][]): number[][] {
  if (m.length === 0) return [];
  return m[0].map((_, i) => m.map((row) => row[i]));
}

function multiply(a: number[][], b: number[][]): number[][] {
  const result: number[][] = [];
  for (let i = 0; i < a.length; i++) {
    result[i] = [];
    for (let j = 0; j < b[0].length; j++) {
      let sum = 0;
      for (let k = 0; k < a[0].length; k++) {
        sum += a[i][k] * b[k][j];
      }
      result[i][j] = sum;
    }
  }
  return result;
}

function multiplyVector(m: number[][], v: number[]): number[] {
  return m.map((row) => row.reduce((sum, val, i) => sum + val * (v[i] ?? 0), 0));
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    if (Math.abs(aug[col][col]) < 1e-12) continue;

    // Normalize pivot row for stability
    const pivot = aug[col][col];
    for (let j = col; j <= n; j++) {
      aug[col][j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  return aug.map((row) => (Math.abs(row[n]) < 1e-12 ? 0 : row[n]));
}

/** Apply matrix in linear light, return display-referred 8-bit RGB */
export function applyColorMatrix(color: RGB, matrix: ColorMatrix): RGB {
  const linear = applyMatrixLinear(rgbToLinear(color), matrix);
  return {
    r: clampChannel(linearToSrgb(linear.r)),
    g: clampChannel(linearToSrgb(linear.g)),
    b: clampChannel(linearToSrgb(linear.b)),
  };
}

export function applyColorCorrectionToImage(
  sourceCanvas: HTMLCanvasElement,
  matrix: ColorMatrix
): HTMLCanvasElement {
  const destCanvas = document.createElement('canvas');
  destCanvas.width = sourceCanvas.width;
  destCanvas.height = sourceCanvas.height;

  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const destCtx = destCanvas.getContext('2d');

  if (!sourceCtx || !destCtx) return destCanvas;

  const imageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const data = imageData.data;
  const { matrix: m, offset } = matrix;

  // Precompute LUTs for sRGB ↔ linear to speed up large batches
  const toLinear = new Float32Array(256);
  const toSrgb = new Uint8ClampedArray(4096); // quantized linear 0..1 → sRGB
  for (let i = 0; i < 256; i++) {
    toLinear[i] = srgbToLinear(i);
  }
  for (let i = 0; i < 4096; i++) {
    toSrgb[i] = clampChannel(linearToSrgb(i / 4095));
  }
  const encode = (v: number) => {
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    return toSrgb[(v * 4095) | 0];
  };

  for (let i = 0; i < data.length; i += 4) {
    const r = toLinear[data[i]];
    const g = toLinear[data[i + 1]];
    const b = toLinear[data[i + 2]];

    data[i] = encode(m[0][0] * r + m[0][1] * g + m[0][2] * b + offset.r);
    data[i + 1] = encode(m[1][0] * r + m[1][1] * g + m[1][2] * b + offset.g);
    data[i + 2] = encode(m[2][0] * r + m[2][1] * g + m[2][2] * b + offset.b);
  }

  destCtx.putImageData(imageData, 0, 0);
  return destCanvas;
}

function drawBitmapToCanvas(
  bitmap: ImageBitmap,
  maxDimension = MAX_IMAGE_DIMENSION
): HTMLCanvasElement {
  let width = bitmap.width;
  let height = bitmap.height;

  const longest = Math.max(width, height);
  if (longest > maxDimension) {
    const scale = maxDimension / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.drawImage(bitmap, 0, 0, width, height);
  }
  bitmap.close();
  return canvas;
}

/**
 * Load an image file onto a canvas, respecting EXIF orientation and
 * optionally downsampling extremely large images.
 */
export async function loadImageToCanvas(
  file: File,
  maxDimension = MAX_IMAGE_DIMENSION
): Promise<HTMLCanvasElement> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error('Unsupported image type');
  }

  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth: undefined,
      resizeHeight: undefined,
    });
    return drawBitmapToCanvas(bitmap, maxDimension);
  } catch {
    // Fallback for environments without createImageBitmap options support
    return loadImageToCanvasLegacy(file, maxDimension);
  }
}

function loadImageToCanvasLegacy(
  file: File,
  maxDimension: number
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;
      const longest = Math.max(width, height);
      if (longest > maxDimension) {
        const scale = maxDimension / longest;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };

    img.src = url;
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: 'jpeg' | 'png',
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Failed to create blob'));
        }
      },
      format === 'jpeg' ? 'image/jpeg' : 'image/png',
      format === 'jpeg' ? Math.max(0, Math.min(1, quality)) : undefined
    );
  });
}

export function extensionForFormat(format: 'jpeg' | 'png'): string {
  return format === 'jpeg' ? 'jpg' : 'png';
}

export function formatFromMime(mime: string | undefined, fallback: 'jpeg' | 'png'): 'jpeg' | 'png' {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  return fallback;
}

export function isValidColorMatrix(value: unknown): value is ColorMatrix {
  if (!value || typeof value !== 'object') return false;
  const m = value as ColorMatrix;
  return (
    Array.isArray(m.matrix) &&
    m.matrix.length === 3 &&
    m.matrix.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) &&
    !!m.offset &&
    typeof m.offset.r === 'number' &&
    typeof m.offset.g === 'number' &&
    typeof m.offset.b === 'number'
  );
}

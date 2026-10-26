import type {
  RGB,
  ColorPoint,
  ColorMatrix,
  ColorPointRole,
  MatrixFitResult,
  FitDiagnostics,
} from '@/types/colorCorrector';
import {
  ALGORITHM_VERSION,
  FIT_THRESHOLDS,
  IMAGE_LIMITS,
} from './calibrationLimits';
import {
  applyMatrixToRgba8,
  clampChannel,
  encodeLinear8,
  linearToSrgb,
  rgbToLinear,
  srgbToLinear,
} from './colorMath';
import { assessMatrix, isValidColorMatrix, validateColorMatrix } from './matrixValidation';

export { clampChannel, linearToSrgb, rgbToLinear, srgbToLinear, isValidColorMatrix };
export { validateColorMatrix };

const IDENTITY_MATRIX: ColorMatrix = {
  matrix: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  offset: { r: 0, g: 0, b: 0 },
};

/** Longest edge cap to avoid tab OOM on huge camera files */
export const MAX_IMAGE_DIMENSION = IMAGE_LIMITS.maxDimension;

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

/**
 * Explicit roles always win — including `custom`, which must be able to
 * override an exact label such as "White" (audit C14).
 */
export function inferPointRole(label: string, explicit?: ColorPointRole): ColorPointRole {
  if (explicit) return explicit;
  const normalized = label.trim().toLowerCase();
  if (normalized === 'white') return 'white';
  if (normalized === 'grey' || normalized === 'gray') return 'grey';
  if (normalized === 'black') return 'black';
  return 'custom';
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Duplicate role points are collapsed to the per-channel median of their
 * samples and targets instead of silently using the first point (audit C15).
 */
function resolveRolePoint(points: ColorPoint[], role: ColorPointRole): ColorPoint | undefined {
  const matches = points.filter((p) => inferPointRole(p.label, p.role) === role);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return {
    ...matches[0],
    x: median(matches.map((p) => p.x)),
    y: median(matches.map((p) => p.y)),
    sampledColor: {
      r: median(matches.map((p) => p.sampledColor.r)),
      g: median(matches.map((p) => p.sampledColor.g)),
      b: median(matches.map((p) => p.sampledColor.b)),
    },
    targetColor: {
      r: median(matches.map((p) => p.targetColor.r)),
      g: median(matches.map((p) => p.targetColor.g)),
      b: median(matches.map((p) => p.targetColor.b)),
    },
  };
}

function duplicateRoles(points: ColorPoint[]): ColorPointRole[] {
  const counts = new Map<ColorPointRole, number>();
  for (const p of points) {
    const role = inferPointRole(p.label, p.role);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return (['white', 'grey', 'black'] as ColorPointRole[]).filter((role) => (counts.get(role) ?? 0) > 1);
}

function chromaOf(rgb: RGB): number {
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
}

function countChromaticSamples(points: ColorPoint[]): number {
  return points.filter((p) => chromaOf(p.sampledColor) >= FIT_THRESHOLDS.chromaticChroma).length;
}

function finiteRgb(rgb: RGB): boolean {
  return Number.isFinite(rgb.r) && Number.isFinite(rgb.g) && Number.isFinite(rgb.b);
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

function toMatrix(scales: RGB, offsets: RGB): ColorMatrix {
  return {
    matrix: [
      [scales.r, 0, 0],
      [0, scales.g, 0],
      [0, 0, scales.b],
    ],
    offset: { ...offsets },
  };
}

function identityWithDiagnostics(
  points: ColorPoint[],
  mode: 'simple' | 'advanced',
  warnings: string[],
  extra: Partial<FitDiagnostics> = {}
): MatrixFitResult {
  const matrix = cloneIdentityMatrix();
  return {
    matrix,
    meanResidual: meanAbsoluteResidual(points, matrix),
    fellBackToSimple: false,
    warning: warnings[0],
    warnings,
    diagnostics: {
      mode,
      algorithmVersion: ALGORITHM_VERSION,
      sampleCount: points.length,
      chromaticSamples: countChromaticSamples(points),
      conditioningRatio: null,
      minAnchorSeparation: null,
      clippingForecast: 0,
      saturationRetention: 1,
      duplicateRoles: duplicateRoles(points),
      destructiveFallback: true,
      ...extra,
    },
  };
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
export function calculateSimpleMatrixDetailed(points: ColorPoint[]): MatrixFitResult {
  if (points.length === 0) {
    return {
      matrix: cloneIdentityMatrix(),
      meanResidual: 0,
      fellBackToSimple: false,
      warnings: [],
      diagnostics: {
        mode: 'simple',
        algorithmVersion: ALGORITHM_VERSION,
        sampleCount: 0,
        chromaticSamples: 0,
        conditioningRatio: null,
        minAnchorSeparation: null,
        clippingForecast: 0,
        saturationRetention: 1,
        duplicateRoles: [],
        destructiveFallback: false,
      },
    };
  }

  const warnings: string[] = [];
  const duplicates = duplicateRoles(points);
  if (duplicates.length > 0) {
    warnings.push(
      `Duplicate ${duplicates.join('/')} points found; their samples were merged by median.`
    );
  }
  if (points.some((p) => !finiteRgb(p.sampledColor) || !finiteRgb(p.targetColor))) {
    return identityWithDiagnostics(points, 'simple', ['Calibration point colours are not finite.']);
  }

  const whitePoint = resolveRolePoint(points, 'white');
  const greyPoint = resolveRolePoint(points, 'grey');
  const blackPoint = resolveRolePoint(points, 'black');

  let matrix: ColorMatrix;
  let minAnchorSeparation: number | null = null;

  if (whitePoint && blackPoint) {
    // Exact black→white linear stretch in linear light — locks the range
    const scales = { r: 1, g: 1, b: 1 };
    const offsets = { r: 0, g: 0, b: 0 };
    let inverted = false;
    let lowContrast = false;

    (['r', 'g', 'b'] as const).forEach((channel) => {
      const sampleLow = rgbToLinear(blackPoint.sampledColor)[channel];
      const sampleHigh = rgbToLinear(whitePoint.sampledColor)[channel];
      const targetLow = rgbToLinear(blackPoint.targetColor)[channel];
      const targetHigh = rgbToLinear(whitePoint.targetColor)[channel];
      const delta = sampleHigh - sampleLow;

      if (minAnchorSeparation === null || delta < minAnchorSeparation) {
        minAnchorSeparation = delta;
      }

      if (delta <= 0) {
        inverted = true;
        scales[channel] = 1;
        offsets[channel] = 0;
      } else if (delta < FIT_THRESHOLDS.minAnchorSeparationLinear) {
        lowContrast = true;
        scales[channel] = (targetHigh - targetLow) / delta;
        offsets[channel] = targetLow - sampleLow * scales[channel];
      } else {
        scales[channel] = (targetHigh - targetLow) / delta;
        offsets[channel] = targetLow - sampleLow * scales[channel];
      }
    });

    if (inverted) {
      warnings.push(
        'The Black anchor is brighter than the White anchor on at least one channel; correction was disabled.'
      );
      return identityWithDiagnostics(points, 'simple', warnings, { minAnchorSeparation });
    }
    if (lowContrast) {
      warnings.push(
        'Black and White samples are very close (<2% linear). Corrections will amplify noise and may clip; use a cleaner chart shot.'
      );
    }
    matrix = toMatrix(scales, offsets);
  } else {
    const fitPoints = [whitePoint, greyPoint, blackPoint].filter(
      (p): p is ColorPoint => !!p
    );
    let fitSamples: ColorPoint[];
    if (fitPoints.length > 0) {
      fitSamples = fitPoints;
    } else if (points.length === 1) {
      // A single custom target is a legitimate simple-mode calibration:
      // per-channel scale with no offset.
      warnings.push('Only one calibration point: correction is a per-channel scale with no offset.');
      fitSamples = points;
    } else {
      // No White/Grey/Black anchor resolved. Never silently discard the
      // remaining patches: fit every point diagonally and say so.
      warnings.push(
        `No White, Grey or Black anchor resolved; all ${points.length} points were used as independent samples for a per-channel diagonal fit. Add role-labelled anchors for a more predictable result.`
      );
      fitSamples = points;
    }
    const { scales, offsets } = fitDiagonalAffine(fitSamples);
    matrix = toMatrix(scales, offsets);
  }

  const assessment = assessMatrix(matrix);
  if (assessment.destructive) {
    warnings.push(
      `Calibration would destroy image data (${assessment.reasons.join('; ')}). An uncorrected identity matrix is used instead.`
    );
    return identityWithDiagnostics(points, 'simple', warnings, {
      minAnchorSeparation,
      clippingForecast: assessment.clippingFraction,
      saturationRetention: assessment.saturationRetention,
    });
  }

  if (assessment.clippingFraction > FIT_THRESHOLDS.clipWarnFraction) {
    warnings.push(
      `This calibration clips about ${(assessment.clippingFraction * 100).toFixed(0)}% of typical colour channels; check the reference shot exposure.`
    );
  }
  const residual = meanAbsoluteResidual(points, matrix);
  if (residual > MAX_MEAN_RESIDUAL) {
    warnings.push(
      `This calibration does not reproduce its own samples (mean residual ${residual.toFixed(1)} DN). The correction may be inaccurate; check the patch samples or use Multi-Point mode.`
    );
  }
  const minLinear = minAnchorSeparation;
  return {
    matrix,
    meanResidual: residual,
    fellBackToSimple: false,
    warning: warnings[0],
    warnings,
    diagnostics: {
      mode: 'simple',
      algorithmVersion: ALGORITHM_VERSION,
      sampleCount: points.length,
      chromaticSamples: countChromaticSamples(points),
      conditioningRatio: null,
      minAnchorSeparation: minLinear,
      clippingForecast: assessment.clippingFraction,
      saturationRetention: assessment.saturationRetention,
      duplicateRoles: duplicates,
      destructiveFallback: false,
    },
  };
}

export function calculateSimpleMatrix(points: ColorPoint[]): ColorMatrix {
  return calculateSimpleMatrixDetailed(points).matrix;
}

function applyMatrixLinearLocal(colorLinear: RGB, matrix: ColorMatrix): RGB {
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
    const linear = applyMatrixLinearLocal(rgbToLinear(p.sampledColor), matrix);
    const out = {
      r: clampChannel(linearToSrgb(linear.r)),
      g: clampChannel(linearToSrgb(linear.g)),
      b: clampChannel(linearToSrgb(linear.b)),
    };
    total +=
      Math.abs(out.r - p.targetColor.r) +
      Math.abs(out.g - p.targetColor.g) +
      Math.abs(out.b - p.targetColor.b);
  }
  return total / (points.length * 3);
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

/**
 * Jacobi eigenvalues of a symmetric matrix. Used to measure how well the
 * calibration samples constrain a full 3x3/affine fit (audit C1).
 */
function symmetricEigenvalues(input: number[][]): number[] {
  const n = input.length;
  const a = input.map((row) => [...row]);
  for (let sweep = 0; sweep < 50; sweep++) {
    let offDiagonal = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) offDiagonal += a[i][j] * a[i][j];
    }
    if (offDiagonal < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return a.map((row, i) => row[i]);
}

/** min/max eigenvalue ratio of A^T A; 0 means rank-deficient. */
function conditioningRatio(A: number[][]): number {
  const AT = transpose(A);
  const ATA = multiply(AT, A);
  const eigenvalues = symmetricEigenvalues(ATA).map((v) => Math.abs(v));
  const max = Math.max(...eigenvalues);
  if (!(max > 1e-18)) return 0;
  return Math.min(...eigenvalues) / max;
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);
  let scale = 0;
  for (const row of A) for (const v of row) scale = Math.max(scale, Math.abs(v));
  if (!(scale > 0)) return null;
  const tolerance = 1e-12 * scale;

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    if (Math.abs(aug[col][col]) < tolerance) return null;

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

  const solution = aug.map((row) => (Math.abs(row[n]) < 1e-12 ? 0 : row[n]));
  return solution.every((v) => Number.isFinite(v)) ? solution : null;
}

function singularFallback(
  points: ColorPoint[],
  warnings: string[],
  extra: Partial<FitDiagnostics> = {}
): MatrixFitResult {
  const simple = calculateSimpleMatrixDetailed(points);
  return {
    ...simple,
    fellBackToSimple: true,
    warning: warnings[0] ?? simple.warning,
    warnings: [...warnings, ...simple.warnings],
    diagnostics: { ...simple.diagnostics, mode: 'advanced', ...extra },
  };
}

/**
 * Multi-point least-squares color correction in linear sRGB.
 *
 * A full 3x3/affine fit is only used when the samples actually constrain it:
 * rank/condition test over ALL samples plus chromatic evidence. Otherwise the
 * deterministic simple fit is used with an explicit warning. This closes the
 * near-neutral rank-1 desaturation trap (audit C1).
 */
export function calculateAdvancedMatrix(points: ColorPoint[]): ColorMatrix {
  return calculateAdvancedMatrixDetailed(points).matrix;
}

export function calculateAdvancedMatrixDetailed(points: ColorPoint[]): MatrixFitResult {
  if (points.length < 3) {
    const simple = calculateSimpleMatrixDetailed(points);
    return {
      ...simple,
      fellBackToSimple: true,
      warning: 'Need at least 3 color patches for multi-point mode.',
      warnings: ['Need at least 3 color patches for multi-point mode.', ...simple.warnings],
      diagnostics: { ...simple.diagnostics, mode: 'advanced' },
    };
  }

  if (points.some((p) => !finiteRgb(p.sampledColor) || !finiteRgb(p.targetColor))) {
    return identityWithDiagnostics(points, 'advanced', ['Calibration point colours are not finite.']);
  }

  const chromaticSamples = countChromaticSamples(points);
  if (chromaticSamples < FIT_THRESHOLDS.minChromaticSamples) {
    return singularFallback(
      points,
      [
        `Only ${chromaticSamples} chromatic patch(es) present; a full 3×3 fit needs at least ${FIT_THRESHOLDS.minChromaticSamples} non-collinear colour patches. Using the 3-point diagonal correction.`,
      ],
      { chromaticSamples }
    );
  }

  const useOffset = points.length >= 4;
  const linearSamples = points.map((p) => rgbToLinear(p.sampledColor));
  const linearTargets = points.map((p) => rgbToLinear(p.targetColor));

  const A: number[][] = linearSamples.map((s) =>
    useOffset ? [s.r, s.g, s.b, 1] : [s.r, s.g, s.b]
  );

  const condition = conditioningRatio(A);
  if (condition < FIT_THRESHOLDS.minConditionRatio) {
    return singularFallback(
      points,
      [
        'Calibration samples are rank-deficient (near-collinear), so a full 3×3 fit would be unstable. Using the 3-point diagonal correction.',
      ],
      { chromaticSamples, conditioningRatio: condition }
    );
  }

  const solveForChannel = (targetValues: number[]): number[] | null => {
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

  if (!coeffR || !coeffG || !coeffB) {
    return singularFallback(
      points,
      ['Multi-point solve failed numerically (singular system). Using 3-point correction.'],
      { chromaticSamples, conditioningRatio: condition }
    );
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

  const validation = validateColorMatrix(matrix);
  if (!validation.ok) {
    return singularFallback(
      points,
      [
        `Multi-point fit produced coefficients outside the supported bounds (${validation.errors[0]}). Using 3-point correction.`,
      ],
      { chromaticSamples, conditioningRatio: condition }
    );
  }

  const assessment = assessMatrix(matrix);
  if (assessment.destructive) {
    return singularFallback(
      points,
      [
        `Multi-point fit was rejected by the colour guardrail (${assessment.reasons.join('; ')}). Using 3-point correction.`,
      ],
      {
        chromaticSamples,
        conditioningRatio: condition,
        clippingForecast: assessment.clippingFraction,
        saturationRetention: assessment.saturationRetention,
      }
    );
  }

  const residual = meanAbsoluteResidual(points, matrix);
  if (residual > MAX_MEAN_RESIDUAL) {
    return singularFallback(
      points,
      [
        `Multi-point fit residual too high (${residual.toFixed(1)} DN). Using 3-point correction.`,
      ],
      {
        chromaticSamples,
        conditioningRatio: condition,
        clippingForecast: assessment.clippingFraction,
        saturationRetention: assessment.saturationRetention,
      }
    );
  }

  const warnings: string[] = [];
  if (assessment.clippingFraction > FIT_THRESHOLDS.clipWarnFraction) {
    warnings.push(
      `This calibration clips about ${(assessment.clippingFraction * 100).toFixed(0)}% of typical colour channels.`
    );
  }
  if (duplicateRoles(points).length > 0) {
    warnings.push('Duplicate role labels were used as independent samples; verify point roles.');
  }

  return {
    matrix,
    meanResidual: residual,
    fellBackToSimple: false,
    warning: warnings[0],
    warnings,
    diagnostics: {
      mode: 'advanced',
      algorithmVersion: ALGORITHM_VERSION,
      sampleCount: points.length,
      chromaticSamples,
      conditioningRatio: condition,
      minAnchorSeparation: null,
      clippingForecast: assessment.clippingFraction,
      saturationRetention: assessment.saturationRetention,
      duplicateRoles: duplicateRoles(points),
      destructiveFallback: false,
    },
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
  return mode === 'advanced'
    ? calculateAdvancedMatrixDetailed(points)
    : calculateSimpleMatrixDetailed(points);
}

/** Apply matrix in linear light, return display-referred 8-bit RGB. */
export function applyColorMatrix(color: RGB, matrix: ColorMatrix): RGB {
  const linear = applyMatrixLinearLocal(rgbToLinear(color), matrix);
  return {
    r: encodeLinear8(linear.r),
    g: encodeLinear8(linear.g),
    b: encodeLinear8(linear.b),
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
  applyMatrixToRgba8(imageData.data, matrix);
  destCtx.putImageData(imageData, 0, 0);
  return destCanvas;
}

/**
 * Fit an image inside a longest-edge and total-pixel budget. Pure function so
 * the calibration canvas cap is unit-testable without a DOM (audit C10).
 */
export function computeFittedSize(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels: number
): { width: number; height: number; scale: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: 1, height: 1, scale: 0 };
  }
  const edgeScale = Math.min(1, maxEdge / Math.max(width, height));
  const pixelScale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const scale = Math.min(edgeScale, pixelScale, 1);
  let outWidth = Math.max(1, Math.floor(width * scale));
  let outHeight = Math.max(1, Math.floor(height * scale));
  // Integer rounding can leave the product a few pixels over budget.
  while (outWidth * outHeight > maxPixels) {
    if (outWidth >= outHeight && outWidth > 1) outWidth -= 1;
    else if (outHeight > 1) outHeight -= 1;
    else break;
  }
  return {
    width: outWidth,
    height: outHeight,
    scale,
  };
}

function drawBitmapToCanvas(
  bitmap: ImageBitmap,
  maxDimension = MAX_IMAGE_DIMENSION,
  maxPixels = IMAGE_LIMITS.maxPixels
): HTMLCanvasElement {
  const { width, height } = computeFittedSize(bitmap.width, bitmap.height, maxDimension, maxPixels);

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
 * downsampling to the shared edge/pixel limits.
 */
export async function loadImageToCanvas(
  file: File,
  maxDimension = MAX_IMAGE_DIMENSION,
  maxPixels = IMAGE_LIMITS.maxPixels
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
    return drawBitmapToCanvas(bitmap, maxDimension, maxPixels);
  } catch {
    // Fallback for environments without createImageBitmap options support
    return loadImageToCanvasLegacy(file, maxDimension, maxPixels);
  }
}

function loadImageToCanvasLegacy(
  file: File,
  maxDimension: number,
  maxPixels: number
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const fitted = computeFittedSize(width, height, maxDimension, maxPixels);

      const canvas = document.createElement('canvas');
      canvas.width = fitted.width;
      canvas.height = fitted.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0, fitted.width, fitted.height);
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

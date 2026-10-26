import type { ColorMatrix } from '@/types/colorCorrector';
import { applyMatrixLinear, encodeLinear8, rgbToLinear } from './colorMath';
import { FIT_THRESHOLDS, MATRIX_LIMITS } from './calibrationLimits';

export interface MatrixValidationResult {
  ok: boolean;
  errors: string[];
}

export interface MatrixAssessment {
  maxAbsCoefficient: number;
  maxAbsOffset: number;
  withinLimits: boolean;
  rank1: boolean;
  midtoneCrush: boolean;
  clippingFraction: number;
  saturationRetention: number | null;
  destructive: boolean;
  reasons: string[];
}

/**
 * Deterministic probe set used to judge whether a matrix will visibly destroy
 * colours. This is a plausibility/guardrail check over synthetic probes — it is
 * NOT colour-accuracy evidence and makes no ΔE claim.
 */
const PROBES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [16, 16, 16],
  [32, 32, 32],
  [48, 48, 48],
  [64, 64, 64],
  [80, 80, 80],
  [96, 96, 96],
  [112, 112, 112],
  [128, 128, 128],
  [144, 144, 144],
  [160, 160, 160],
  [176, 176, 176],
  [192, 192, 192],
  [208, 208, 208],
  [224, 224, 224],
  [240, 240, 240],
  [255, 255, 255],
  [255, 0, 0],
  [200, 60, 55],
  [0, 255, 0],
  [60, 160, 80],
  [0, 0, 255],
  [40, 90, 200],
  [255, 255, 0],
  [0, 255, 255],
  [255, 0, 255],
  [200, 150, 130],
  [120, 80, 60],
  [90, 70, 50],
  [35, 45, 60],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strict matrix validator. Rejects unknown keys, non-finite numbers (including
 * JSON `1e400` → Infinity), malformed rows, and — unless disabled — entries
 * outside the shared UI/API bounds.
 */
export function validateColorMatrix(
  value: unknown,
  options: { enforceBounds?: boolean } = {}
): MatrixValidationResult {
  const enforceBounds = options.enforceBounds !== false;
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['matrix must be an object'] };
  }

  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'matrix,offset') {
    errors.push('matrix must contain exactly "matrix" and "offset"');
  }

  const matrix = value.matrix;
  if (!Array.isArray(matrix) || matrix.length !== 3) {
    errors.push('matrix.matrix must be a 3x3 array');
  } else {
    matrix.forEach((row, r) => {
      if (!Array.isArray(row) || row.length !== 3) {
        errors.push(`matrix.matrix[${r}] must be a 3-element array`);
        return;
      }
      row.forEach((n, c) => {
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          errors.push(`matrix.matrix[${r}][${c}] must be a finite number`);
        } else if (enforceBounds && Math.abs(n) > MATRIX_LIMITS.maxAbsCoefficient) {
          errors.push(
            `matrix.matrix[${r}][${c}] exceeds the ${MATRIX_LIMITS.maxAbsCoefficient} coefficient limit`
          );
        }
      });
    });
  }

  const offset = value.offset;
  if (!isPlainObject(offset)) {
    errors.push('matrix.offset must be an object');
  } else {
    const offsetKeys = Object.keys(offset).sort().join(',');
    if (offsetKeys !== 'b,g,r') {
      errors.push('matrix.offset must contain exactly "r", "g" and "b"');
    }
    for (const channel of ['r', 'g', 'b'] as const) {
      const n = offset[channel];
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        errors.push(`matrix.offset.${channel} must be a finite number`);
      } else if (enforceBounds && Math.abs(n) > MATRIX_LIMITS.maxAbsOffset) {
        errors.push(`matrix.offset.${channel} exceeds the ${MATRIX_LIMITS.maxAbsOffset} offset limit`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function isValidColorMatrix(value: unknown): value is ColorMatrix {
  return validateColorMatrix(value).ok;
}

export function matrixIsWithinLimits(matrix: ColorMatrix): boolean {
  return validateColorMatrix(matrix).ok;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < 1e-18 || nb < 1e-18) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Guardrail assessment of a matrix. Detects rank-1 (whole image becomes
 * monochrome), severe clipping, and desaturation on a synthetic probe set.
 */
export function assessMatrix(matrix: ColorMatrix): MatrixAssessment {
  const reasons: string[] = [];
  let maxAbsCoefficient = 0;
  let maxAbsOffset = 0;

  for (const row of matrix.matrix) {
    for (const n of row) maxAbsCoefficient = Math.max(maxAbsCoefficient, Math.abs(n));
  }
  for (const n of [matrix.offset.r, matrix.offset.g, matrix.offset.b]) {
    maxAbsOffset = Math.max(maxAbsOffset, Math.abs(n));
  }

  const withinLimits =
    maxAbsCoefficient <= MATRIX_LIMITS.maxAbsCoefficient &&
    maxAbsOffset <= MATRIX_LIMITS.maxAbsOffset;
  if (!withinLimits) reasons.push('matrix exceeds shared coefficient/offset limits');

  // Rank-1 test: every output channel is the same linear combination of input.
  const rowPairs: Array<[number[], number[]]> = [
    [matrix.matrix[0], matrix.matrix[1]],
    [matrix.matrix[0], matrix.matrix[2]],
    [matrix.matrix[1], matrix.matrix[2]],
  ];
  const rowNorms = matrix.matrix.map((row) => Math.hypot(row[0], row[1], row[2]));
  const allZeroRows = rowNorms.every((n) => n < 1e-9);
  const rank1 =
    allZeroRows ||
    rowPairs.every(([a, b]) => Math.abs(cosine(a, b)) >= FIT_THRESHOLDS.rank1RowCosine);
  if (rank1) reasons.push('matrix is rank-1 (all channels collapse together)');

  let clippedChannels = 0;
  let totalChannels = 0;
  let chromaIn = 0;
  let chromaOut = 0;
  let chromaticProbes = 0;

  for (const probe of PROBES) {
    const input: ColorMatrix['offset'] = { r: probe[0], g: probe[1], b: probe[2] };
    const out = applyMatrixLinear(rgbToLinear(input), matrix);
    for (const channel of ['r', 'g', 'b'] as const) {
      totalChannels += 1;
      if (out[channel] < -1e-9 || out[channel] > 1 + 1e-9) clippedChannels += 1;
    }
    const inChroma = Math.max(...probe) - Math.min(...probe);
    if (inChroma >= 30) {
      const outRgb = {
        r: Math.max(0, Math.min(1, out.r)),
        g: Math.max(0, Math.min(1, out.g)),
        b: Math.max(0, Math.min(1, out.b)),
      };
      // Compare in approximately display-referred units (linear→gamma-ish is
      // monotonic; use gamma 2.2 for a stable saturation ratio).
      const gamma = (v: number) => Math.pow(v, 1 / 2.2) * 255;
      const outChroma = Math.max(gamma(outRgb.r), gamma(outRgb.g), gamma(outRgb.b)) -
        Math.min(gamma(outRgb.r), gamma(outRgb.g), gamma(outRgb.b));
      chromaIn += inChroma;
      chromaOut += outChroma;
      chromaticProbes += 1;
    }
  }

  const clippingFraction = totalChannels === 0 ? 0 : clippedChannels / totalChannels;
  const saturationRetention = chromaIn > 0 ? chromaOut / chromaIn : null;

  // Mid-grey → near black means the correction crushes an entire tone range
  // (e.g. a glossy black patch sampled at 200/255). Identity maps 128 → 128.
  const midLinear = applyMatrixLinear(rgbToLinear({ r: 128, g: 128, b: 128 }), matrix);
  const midLuma =
    (encodeLinear8(midLinear.r) + encodeLinear8(midLinear.g) + encodeLinear8(midLinear.b)) / 3;
  const midtoneCrush = midLuma < FIT_THRESHOLDS.midtoneCrushOutput;
  if (midtoneCrush) {
    reasons.push('mid-grey is crushed to near black');
  }

  if (clippingFraction > FIT_THRESHOLDS.clipRejectFraction) {
    reasons.push(`matrix clips ${(clippingFraction * 100).toFixed(0)}% of probe channels`);
  }
  if (saturationRetention !== null && saturationRetention < FIT_THRESHOLDS.minSaturationRetention) {
    reasons.push('matrix destroys most colour saturation');
  }

  return {
    maxAbsCoefficient,
    maxAbsOffset,
    withinLimits,
    rank1,
    midtoneCrush,
    clippingFraction,
    saturationRetention: chromaticProbes > 0 ? saturationRetention : null,
    destructive: reasons.length > 0,
    reasons,
  };
}

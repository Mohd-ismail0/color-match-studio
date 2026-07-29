import { RGB, ColorPoint, ColorMatrix } from '@/types/colorCorrector';

const IDENTITY_MATRIX: ColorMatrix = {
  matrix: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  offset: { r: 0, g: 0, b: 0 },
};

export function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!result) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
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
  const pixelCount = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    totalR += data[i];
    totalG += data[i + 1];
    totalB += data[i + 2];
  }

  return {
    r: Math.round(totalR / pixelCount),
    g: Math.round(totalG / pixelCount),
    b: Math.round(totalB / pixelCount),
  };
}

function findPoint(
  points: ColorPoint[],
  ...labels: string[]
): ColorPoint | undefined {
  return points.find((p) => {
    const label = p.label.toLowerCase();
    return labels.some((candidate) => label.includes(candidate));
  });
}

function channelScale(target: number, sampled: number): number {
  if (Math.abs(sampled) < 1e-6) {
    return target === 0 ? 1 : 0;
  }
  return target / sampled;
}

function channelStretch(
  sampleLow: number,
  sampleHigh: number,
  targetLow: number,
  targetHigh: number
): { scale: number; offset: number } {
  const sampleDelta = sampleHigh - sampleLow;
  if (Math.abs(sampleDelta) < 1e-6) {
    return {
      scale: 1,
      offset: targetLow - sampleLow,
    };
  }

  const scale = (targetHigh - targetLow) / sampleDelta;
  const offset = targetLow - sampleLow * scale;
  return { scale, offset };
}

/**
 * Diagonal affine correction using white / grey / black reference points.
 * Model per channel: out = sample * scale + offset
 */
export function calculateSimpleMatrix(points: ColorPoint[]): ColorMatrix {
  if (points.length === 0) {
    return {
      matrix: IDENTITY_MATRIX.matrix.map((row) => [...row]),
      offset: { ...IDENTITY_MATRIX.offset },
    };
  }

  const whitePoint = findPoint(points, 'white');
  const greyPoint = findPoint(points, 'grey', 'gray');
  const blackPoint = findPoint(points, 'black');

  const scales = { r: 1, g: 1, b: 1 };
  const offsets = { r: 0, g: 0, b: 0 };

  if (whitePoint && blackPoint) {
    // Full black→white linear stretch per channel
    (['r', 'g', 'b'] as const).forEach((channel) => {
      const { scale, offset } = channelStretch(
        blackPoint.sampledColor[channel],
        whitePoint.sampledColor[channel],
        blackPoint.targetColor[channel],
        whitePoint.targetColor[channel]
      );
      scales[channel] = scale;
      offsets[channel] = offset;
    });
  } else if (whitePoint) {
    // White balance + exposure from white point
    scales.r = channelScale(whitePoint.targetColor.r, whitePoint.sampledColor.r);
    scales.g = channelScale(whitePoint.targetColor.g, whitePoint.sampledColor.g);
    scales.b = channelScale(whitePoint.targetColor.b, whitePoint.sampledColor.b);

    if (greyPoint) {
      // Soft midtone neutrality nudge using grey, preserving white lock
      const greyScales = {
        r: channelScale(greyPoint.targetColor.r, greyPoint.sampledColor.r),
        g: channelScale(greyPoint.targetColor.g, greyPoint.sampledColor.g),
        b: channelScale(greyPoint.targetColor.b, greyPoint.sampledColor.b),
      };
      const blend = 0.35;
      scales.r = scales.r * (1 - blend) + greyScales.r * blend;
      scales.g = scales.g * (1 - blend) + greyScales.g * blend;
      scales.b = scales.b * (1 - blend) + greyScales.b * blend;
    }
  } else if (greyPoint) {
    // Classic grey-card white balance: map sampled grey → target grey
    scales.r = channelScale(greyPoint.targetColor.r, greyPoint.sampledColor.r);
    scales.g = channelScale(greyPoint.targetColor.g, greyPoint.sampledColor.g);
    scales.b = channelScale(greyPoint.targetColor.b, greyPoint.sampledColor.b);
  } else if (blackPoint) {
    offsets.r = blackPoint.targetColor.r - blackPoint.sampledColor.r;
    offsets.g = blackPoint.targetColor.g - blackPoint.sampledColor.g;
    offsets.b = blackPoint.targetColor.b - blackPoint.sampledColor.b;
  } else {
    // Unlabeled custom points: average per-channel scales toward first point
    const primary = points[0];
    scales.r = channelScale(primary.targetColor.r, primary.sampledColor.r);
    scales.g = channelScale(primary.targetColor.g, primary.sampledColor.g);
    scales.b = channelScale(primary.targetColor.b, primary.sampledColor.b);
  }

  return {
    matrix: [
      [scales.r, 0, 0],
      [0, scales.g, 0],
      [0, 0, scales.b],
    ],
    offset: offsets,
  };
}

/**
 * Multi-point least-squares color correction.
 * - 4+ points: full 3×3 matrix + offset (affine)
 * - 3 points: 3×3 matrix only (homogeneous)
 * - <3 points: fall back to simple diagonal correction
 */
export function calculateAdvancedMatrix(points: ColorPoint[]): ColorMatrix {
  if (points.length < 3) {
    return calculateSimpleMatrix(points);
  }

  const useOffset = points.length >= 4;

  const A: number[][] = points.map((p) =>
    useOffset
      ? [p.sampledColor.r, p.sampledColor.g, p.sampledColor.b, 1]
      : [p.sampledColor.r, p.sampledColor.g, p.sampledColor.b]
  );

  const solveForChannel = (targetValues: number[]): number[] => {
    const AT = transpose(A);
    const ATA = multiply(AT, A);
    const ATb = multiplyVector(AT, targetValues);
    return solveLinear(ATA, ATb);
  };

  const coeffR = solveForChannel(points.map((p) => p.targetColor.r));
  const coeffG = solveForChannel(points.map((p) => p.targetColor.g));
  const coeffB = solveForChannel(points.map((p) => p.targetColor.b));

  // Guard against singular / degenerate solutions
  if (
    !isFiniteVector(coeffR) ||
    !isFiniteVector(coeffG) ||
    !isFiniteVector(coeffB)
  ) {
    return calculateSimpleMatrix(points);
  }

  return {
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
}

export function calculateMatrix(
  points: ColorPoint[],
  mode: 'simple' | 'advanced'
): ColorMatrix {
  return mode === 'advanced'
    ? calculateAdvancedMatrix(points)
    : calculateSimpleMatrix(points);
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

    if (Math.abs(aug[col][col]) < 1e-10) continue;

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    if (Math.abs(aug[i][i]) < 1e-10) {
      x[i] = 0;
      continue;
    }
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = sum / aug[i][i];
  }

  return x;
}

export function applyColorMatrix(color: RGB, matrix: ColorMatrix): RGB {
  const { matrix: m, offset } = matrix;
  return {
    r: clampChannel(m[0][0] * color.r + m[0][1] * color.g + m[0][2] * color.b + offset.r),
    g: clampChannel(m[1][0] * color.r + m[1][1] * color.g + m[1][2] * color.b + offset.g),
    b: clampChannel(m[2][0] * color.r + m[2][1] * color.g + m[2][2] * color.b + offset.b),
  };
}

export function applyColorCorrectionToImage(
  sourceCanvas: HTMLCanvasElement,
  matrix: ColorMatrix
): HTMLCanvasElement {
  const destCanvas = document.createElement('canvas');
  destCanvas.width = sourceCanvas.width;
  destCanvas.height = sourceCanvas.height;

  const sourceCtx = sourceCanvas.getContext('2d');
  const destCtx = destCanvas.getContext('2d');

  if (!sourceCtx || !destCtx) return destCanvas;

  const imageData = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const data = imageData.data;
  const { matrix: m, offset } = matrix;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    data[i] = clampChannel(m[0][0] * r + m[0][1] * g + m[0][2] * b + offset.r);
    data[i + 1] = clampChannel(m[1][0] * r + m[1][1] * g + m[1][2] * b + offset.g);
    data[i + 2] = clampChannel(m[2][0] * r + m[2][1] * g + m[2][2] * b + offset.b);
  }

  destCtx.putImageData(imageData, 0, 0);
  return destCanvas;
}

export function loadImageToCanvas(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
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

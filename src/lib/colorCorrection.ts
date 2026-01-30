import { RGB, ColorPoint, ColorMatrix } from '@/types/colorCorrector';

export function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
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

export function sampleColorFromCanvas(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  sampleSize: number = 5
): RGB {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { r: 0, g: 0, b: 0 };

  const halfSize = Math.floor(sampleSize / 2);
  const startX = Math.max(0, Math.floor(x) - halfSize);
  const startY = Math.max(0, Math.floor(y) - halfSize);
  const endX = Math.min(canvas.width, startX + sampleSize);
  const endY = Math.min(canvas.height, startY + sampleSize);

  const imageData = ctx.getImageData(startX, startY, endX - startX, endY - startY);
  const data = imageData.data;

  let totalR = 0, totalG = 0, totalB = 0;
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

// Calculate simple 3-point color correction matrix (white balance + exposure)
export function calculateSimpleMatrix(points: ColorPoint[]): ColorMatrix {
  // Find white, grey, and black points or use available points
  const whitePoint = points.find(p => p.label.toLowerCase().includes('white'));
  const greyPoint = points.find(p => p.label.toLowerCase().includes('grey') || p.label.toLowerCase().includes('gray'));
  const blackPoint = points.find(p => p.label.toLowerCase().includes('black'));

  // Default identity matrix
  let matrix: number[][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let offset: RGB = { r: 0, g: 0, b: 0 };

  if (points.length === 0) {
    return { matrix, offset };
  }

  // Calculate scale factors from available points
  const scales = { r: 1, g: 1, b: 1 };
  const offsets = { r: 0, g: 0, b: 0 };

  if (whitePoint) {
    // Scale to make sampled white match target white
    scales.r = whitePoint.targetColor.r / Math.max(1, whitePoint.sampledColor.r);
    scales.g = whitePoint.targetColor.g / Math.max(1, whitePoint.sampledColor.g);
    scales.b = whitePoint.targetColor.b / Math.max(1, whitePoint.sampledColor.b);
  }

  if (blackPoint) {
    // Offset to make sampled black match target black
    offsets.r = blackPoint.targetColor.r - blackPoint.sampledColor.r * scales.r;
    offsets.g = blackPoint.targetColor.g - blackPoint.sampledColor.g * scales.g;
    offsets.b = blackPoint.targetColor.b - blackPoint.sampledColor.b * scales.b;
  }

  // If we only have grey point, use it for white balance
  if (!whitePoint && !blackPoint && greyPoint) {
    const avgSampled = (greyPoint.sampledColor.r + greyPoint.sampledColor.g + greyPoint.sampledColor.b) / 3;
    const avgTarget = (greyPoint.targetColor.r + greyPoint.targetColor.g + greyPoint.targetColor.b) / 3;
    const baseScale = avgTarget / Math.max(1, avgSampled);
    
    scales.r = (greyPoint.targetColor.r / Math.max(1, greyPoint.sampledColor.r)) * baseScale / Math.max(1, baseScale);
    scales.g = (greyPoint.targetColor.g / Math.max(1, greyPoint.sampledColor.g)) * baseScale / Math.max(1, baseScale);
    scales.b = (greyPoint.targetColor.b / Math.max(1, greyPoint.sampledColor.b)) * baseScale / Math.max(1, baseScale);
  }

  matrix = [
    [scales.r, 0, 0],
    [0, scales.g, 0],
    [0, 0, scales.b],
  ];

  offset = offsets;

  return { matrix, offset };
}

// Calculate advanced multi-point color correction using least squares
export function calculateAdvancedMatrix(points: ColorPoint[]): ColorMatrix {
  if (points.length < 3) {
    return calculateSimpleMatrix(points);
  }

  // Use least squares to find the best fit 3x3 matrix
  // For each channel, solve: target = matrix * sampled + offset
  
  const n = points.length;
  
  // Build matrices for least squares solution
  // We solve for each output channel separately
  const A: number[][] = points.map(p => [p.sampledColor.r, p.sampledColor.g, p.sampledColor.b, 1]);
  
  const solveForChannel = (targetValues: number[]): number[] => {
    // Solve A * x = b using normal equations: (A^T * A) * x = A^T * b
    const AT = transpose(A);
    const ATA = multiply(AT, A);
    const ATb = multiplyVector(AT, targetValues);
    
    // Solve using simple Gaussian elimination
    return solveLinear(ATA, ATb);
  };

  const targetR = points.map(p => p.targetColor.r);
  const targetG = points.map(p => p.targetColor.g);
  const targetB = points.map(p => p.targetColor.b);

  const coeffR = solveForChannel(targetR);
  const coeffG = solveForChannel(targetG);
  const coeffB = solveForChannel(targetB);

  return {
    matrix: [
      [coeffR[0], coeffR[1], coeffR[2]],
      [coeffG[0], coeffG[1], coeffG[2]],
      [coeffB[0], coeffB[1], coeffB[2]],
    ],
    offset: {
      r: coeffR[3] || 0,
      g: coeffG[3] || 0,
      b: coeffB[3] || 0,
    },
  };
}

function transpose(m: number[][]): number[][] {
  return m[0].map((_, i) => m.map(row => row[i]));
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
  return m.map(row => row.reduce((sum, val, i) => sum + val * v[i], 0));
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  // Forward elimination
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    if (Math.abs(aug[col][col]) < 1e-10) continue;

    // Eliminate column
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = Math.abs(aug[i][i]) > 1e-10 ? sum / aug[i][i] : 0;
  }

  return x;
}

// Apply color correction matrix to RGB value
export function applyColorMatrix(color: RGB, matrix: ColorMatrix): RGB {
  const { matrix: m, offset } = matrix;
  return {
    r: Math.max(0, Math.min(255, m[0][0] * color.r + m[0][1] * color.g + m[0][2] * color.b + offset.r)),
    g: Math.max(0, Math.min(255, m[1][0] * color.r + m[1][1] * color.g + m[1][2] * color.b + offset.g)),
    b: Math.max(0, Math.min(255, m[2][0] * color.r + m[2][1] * color.g + m[2][2] * color.b + offset.b)),
  };
}

// Apply color correction to entire image
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

    data[i] = Math.max(0, Math.min(255, m[0][0] * r + m[0][1] * g + m[0][2] * b + offset.r));
    data[i + 1] = Math.max(0, Math.min(255, m[1][0] * r + m[1][1] * g + m[1][2] * b + offset.g));
    data[i + 2] = Math.max(0, Math.min(255, m[2][0] * r + m[2][1] * g + m[2][2] * b + offset.b));
    // Alpha channel (data[i + 3]) remains unchanged
  }

  destCtx.putImageData(imageData, 0, 0);
  return destCanvas;
}

// Load image file to canvas
export function loadImageToCanvas(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
      }
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

// Convert canvas to blob
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
      format === 'jpeg' ? quality : undefined
    );
  });
}

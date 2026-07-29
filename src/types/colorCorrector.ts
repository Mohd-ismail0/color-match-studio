export type ColorPointRole = 'white' | 'grey' | 'black' | 'custom';

export interface ColorPoint {
  id: string;
  x: number; // 0-1 relative position
  y: number; // 0-1 relative position
  sampledColor: RGB;
  targetColor: RGB;
  label: string;
  /** Preferred over label substring matching for simple-mode roles */
  role?: ColorPointRole;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorMatrix {
  // 3x3 transformation matrix + offset (applied in linear sRGB)
  matrix: number[][];
  offset: RGB;
}

export interface CalibrationPreset {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  points: ColorPoint[];
  matrix: ColorMatrix | null;
  mode: 'simple' | 'advanced';
}

export interface BatchImage {
  id: string;
  file: File;
  originalUrl: string;
  correctedUrl: string | null;
  status: 'pending' | 'processing' | 'completed' | 'error';
  excluded: boolean;
  error?: string;
  /** Snapshot of preset/export used when this result was produced */
  processedWith?: {
    presetId: string;
    format: 'jpeg' | 'png';
    quality: number;
  };
}

export interface ExportSettings {
  format: 'jpeg' | 'png';
  quality: number; // 0-1 for JPEG
  suffix: string;
}

export interface ProcessingProgress {
  current: number;
  total: number;
  percentage: number;
}

export interface MatrixFitResult {
  matrix: ColorMatrix;
  /** Mean absolute residual in 8-bit display RGB across training points */
  meanResidual: number;
  /** True when advanced fit was rejected and simple mode was used instead */
  fellBackToSimple: boolean;
  warning?: string;
}

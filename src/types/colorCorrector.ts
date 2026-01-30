export interface ColorPoint {
  id: string;
  x: number; // 0-1 relative position
  y: number; // 0-1 relative position
  sampledColor: RGB;
  targetColor: RGB;
  label: string;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorMatrix {
  // 3x3 transformation matrix + offset
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

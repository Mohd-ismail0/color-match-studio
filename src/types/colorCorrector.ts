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

/** Diagnostics captured with a fit (stored in calibration provenance). */
export interface FitDiagnostics {
  mode: 'simple' | 'advanced';
  algorithmVersion: string;
  sampleCount: number;
  chromaticSamples: number;
  /** min/max eigenvalue ratio of A^T A; null for simple fits. */
  conditioningRatio: number | null;
  /** Smallest per-channel linear black↔white separation; null if N/A. */
  minAnchorSeparation: number | null;
  /** Fraction of synthetic probe channels that clip. Guardrail only. */
  clippingForecast: number;
  /** Synthetic probe saturation retention; 1 = preserved. Guardrail only. */
  saturationRetention: number | null;
  duplicateRoles: ColorPointRole[];
  destructiveFallback: boolean;
}

export interface MatrixFitResult {
  matrix: ColorMatrix;
  /** Mean absolute residual in 8-bit display RGB across training points */
  meanResidual: number;
  /** True when advanced fit was rejected and simple mode was used instead */
  fellBackToSimple: boolean;
  /** First warning, kept for existing UI call sites */
  warning?: string;
  warnings: string[];
  diagnostics: FitDiagnostics;
}

/** Provenance recorded with every immutable calibration revision. */
export interface CalibrationProvenance {
  source: 'browser' | 'api' | 'import';
  algorithmVersion: string;
  engineVersion: string;
  warnings: string[];
  diagnostics: FitDiagnostics;
  notes?: string[];
  /** SHA-256 of the canonical revision payload (server-computed). */
  contentHash?: string;
  /** Server-assigned immutable revision number. */
  revision?: number;
  /** Server-assigned profile id (when loaded from the API). */
  profileId?: string;
  createdAt?: number;
}

/** A single immutable calibration revision. */
export interface CalibrationRevision {
  revision: number;
  createdAt: number;
  points: ColorPoint[];
  matrix: ColorMatrix;
  mode: 'simple' | 'advanced';
  algorithmVersion: string;
  /** FNV-1a content fingerprint (fast stale detection). */
  fingerprint: string;
  /** Server SHA-256 content hash, when persisted through the API. */
  contentHash?: string;
  provenance: CalibrationProvenance;
}

export interface CalibrationPreset {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  points: ColorPoint[];
  matrix: ColorMatrix | null;
  mode: 'simple' | 'advanced';
  schemaVersion?: number;
  /** Explicitly selected revision for this preset (never implicit "latest"). */
  currentRevision?: number;
  revisions?: CalibrationRevision[];
}

/** Explicit workflow selection: a preset/profile AND a revision number. */
export interface CalibrationSelection {
  presetId: string;
  presetName: string;
  revision: CalibrationRevision;
}

export interface BatchImage {
  id: string;
  file: File;
  originalUrl: string;
  correctedUrl: string | null;
  status: 'pending' | 'processing' | 'completed' | 'error';
  excluded: boolean;
  error?: string;
  /** Snapshot of the exact revision/export used when this result was produced */
  processedWith?: {
    presetId: string;
    revision: number;
    fingerprint: string;
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

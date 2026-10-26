/**
 * Single source of truth for correction/calibration limits.
 * Imported by BOTH the browser app and the Node API so that a preset the UI
 * produces can always be replayed by the API (audit C5/C17).
 */

/** Algorithm/provenance version stored with every calibration revision. */
export const ALGORITHM_VERSION = '2.0.0';

/** Bump when the on-disk revision schema changes. */
export const REVISION_SCHEMA_VERSION = 2;

export const MATRIX_LIMITS = {
  /** Linear-light offset accepted from clients. */
  maxAbsOffset: 8,
  /** Linear-light matrix coefficient accepted from clients. */
  maxAbsCoefficient: 24,
} as const;

export const IMAGE_LIMITS = {
  /** Longest edge accepted anywhere (browser decode + API). */
  maxDimension: 8192,
  /** Pixel budget for browser decode / API processing. */
  maxPixels: 24_000_000,
  /** Calibration sampling canvas is deliberately smaller (audit C10). */
  calibrationMaxEdge: 4096,
  calibrationMaxPixels: 12_000_000,
  /** Decoded image bytes accepted by the API. */
  maxInputBytes: 20_000_000,
  /** JSON body bytes accepted by the API (base64 inflates ~4/3). */
  maxBodyBytes: 30_000_000,
  /** 16-bit processing doubles buffers, so cap it lower. */
  max16BitPixels: 12_000_000,
} as const;

export const CALIBRATION_LIMITS = {
  maxPoints: 64,
  maxNameLength: 120,
  maxLabelLength: 64,
  maxIdLength: 64,
  maxNotes: 20,
  maxNoteLength: 500,
  maxRevisionsPerProfile: 500,
  maxProfilesPerStore: 10_000,
} as const;

export const FIT_THRESHOLDS = {
  /** Full 3x3 fits need at least this many chromatically distinct patches. */
  minChromaticSamples: 2,
  /** sRGB max-min above this counts as chromatic evidence. */
  chromaticChroma: 10,
  /** Smallest / largest eigenvalue of A^T A (normalised) accepted. */
  minConditionRatio: 1e-6,
  /** Per-channel linear separation required between black and white anchors. */
  minAnchorSeparationLinear: 0.02,
  /** Probe-set clipping fraction that triggers a warning. */
  clipWarnFraction: 0.25,
  /** Probe-set clipping fraction that makes a matrix unusable. */
  clipRejectFraction: 0.85,
  /** 8-bit mid-grey output below this means shadows/mids are crushed. */
  midtoneCrushOutput: 12,
  /** Output/input chroma ratio below which a matrix is deemed desaturating. */
  minSaturationRetention: 0.35,
  /** Row cosine similarity above which a 3x3 is treated as rank-1. */
  rank1RowCosine: 0.9995,
} as const;

export const SERVER_LIMITS = {
  maxQueueDepth: 8,
  workerCount: 2,
  jobTimeoutMs: 30_000,
  queueTimeoutMs: 10_000,
  requestBodyTimeoutMs: 15_000,
  headersTimeoutMs: 20_000,
  keepAliveTimeoutMs: 5_000,
  authFailuresPerMinute: 20,
} as const;

/** Default durable store location. Deliberately outside the repository. */
export const DEFAULT_DB_RELATIVE_PATH = '.local/state/color-match-studio/calibrations.sqlite';

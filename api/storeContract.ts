import type {
  CalibrationProvenance,
  ColorMatrix,
  ColorPoint,
} from '../src/types/colorCorrector';

export interface RevisionDraft {
  points: ColorPoint[];
  matrix: ColorMatrix;
  mode: 'simple' | 'advanced';
  algorithmVersion: string;
  fingerprint: string;
  contentHash: string;
  provenance: CalibrationProvenance;
  meanResidual: number;
}

export interface StoredRevision extends RevisionDraft {
  profileId: string;
  revision: number;
  createdAt: number;
}

export interface RevisionSummary {
  revision: number;
  createdAt: number;
  mode: 'simple' | 'advanced';
  algorithmVersion: string;
  fingerprint: string;
  contentHash: string;
  meanResidual: number;
}

export interface ProfileSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Highest stored revision number; never used as an implicit selection. */
  latestRevision: number | null;
  revisionCount: number;
}

export interface ProfileDetail extends ProfileSummary {
  revisions: RevisionSummary[];
}

export type StoreErrorCode =
  | 'NOT_FOUND'
  | 'LIMIT'
  | 'CONFLICT'
  | 'INTEGRITY'
  | 'UNAVAILABLE';

export class StoreError extends Error {
  code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export interface StoreWriteOptions {
  /**
   * Optional caller-supplied idempotency key. Repeating a write with the same
   * key returns the originally stored revision instead of appending a new one.
   * Keys are namespaced per operation by the store, so a create key never
   * collides with an append key.
   */
  idempotencyKey?: string;
}

/**
 * Storage contract shared by the SQLite dev store and the PostgreSQL
 * production store. Every method is asynchronous: PostgreSQL access is
 * inherently asynchronous, so callers must await, and the SQLite adapter
 * presents the same shape instead of a second, synchronous interface.
 */
export interface CalibrationStoreAdapter {
  readonly kind: 'sqlite' | 'postgres';
  /** Non-secret description for startup logs (path or schema, never a URL). */
  readonly description: string;
  createProfile(
    name: string,
    draft: RevisionDraft,
    options?: StoreWriteOptions
  ): Promise<{ profile: ProfileSummary; revision: StoredRevision }>;
  appendRevision(
    profileId: string,
    draft: RevisionDraft,
    options?: StoreWriteOptions
  ): Promise<StoredRevision>;
  listProfiles(limit?: number): Promise<ProfileSummary[]>;
  getProfile(id: string): Promise<ProfileDetail | null>;
  /** Explicit revision lookup; no "latest" fallback exists by design. */
  getRevision(profileId: string, revision: number): Promise<StoredRevision | null>;
  countProfiles(): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Idempotency keys are opaque, printable and bound in length. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

export function scopeIdempotencyKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

/** JSON/JSONB columns are text on SQLite and parsed values on PostgreSQL. */
export function parseJsonColumn<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** BIGINT columns arrive as strings from `pg`; epoch millis stay exact. */
export function toEpochMillis(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new StoreError('INTEGRITY', 'Stored timestamp is not a finite number');
  }
  return n;
}

export function clampProfileLimit(limit = 50): number {
  return Math.max(1, Math.min(500, limit));
}

import { Pool, type PoolClient } from 'pg';
import { CALIBRATION_LIMITS } from '../../src/lib/calibrationLimits';
import type { CalibrationProvenance, ColorMatrix, ColorPoint } from '../../src/types/colorCorrector';
import { newProfileId } from '../store';
import {
  StoreError,
  clampProfileLimit,
  parseJsonColumn,
  scopeIdempotencyKey,
  toEpochMillis,
  type CalibrationStoreAdapter,
  type ProfileDetail,
  type ProfileSummary,
  type RevisionDraft,
  type RevisionSummary,
  type StoreWriteOptions,
  type StoredRevision,
} from '../storeContract';
import {
  describePgTarget,
  pgPoolConfig,
  quoteIdent,
  type PgConnectionSettings,
} from './config';
import {
  applyMigrations,
  loadMigrations,
  verifySchema,
  type Migration,
  type SchemaReport,
} from './migrate';

interface ProfileRow {
  id: string;
  name: string;
  created_at: unknown;
  updated_at: unknown;
  latest_revision: number | null;
  revision_count: number;
}

interface RevisionRow {
  profile_id: string;
  revision: number;
  points_json: unknown;
  matrix_json: unknown;
  mode: 'simple' | 'advanced';
  algorithm_version: string;
  fingerprint: string;
  content_hash: string;
  provenance_json: unknown;
  mean_residual: number;
  created_at: unknown;
}

const REVISION_SELECT = `
  profile_id, revision, points_json, matrix_json, mode, algorithm_version,
  fingerprint, content_hash, provenance_json, mean_residual, created_at
`;

function pgErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function pgErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map driver/SQL errors onto the store contract without leaking SQL. */
export function toStoreError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const code = pgErrorCode(error);
  switch (code) {
    case '23505':
      return new StoreError('CONFLICT', 'Calibration revision already exists');
    case '23503':
      return new StoreError('NOT_FOUND', 'Calibration profile not found');
    case '42P01':
      return new StoreError('UNAVAILABLE', 'Calibration schema is missing in PostgreSQL');
    case '42501':
      return new StoreError(
        'UNAVAILABLE',
        'Database role lacks the privileges required for the calibration store'
      );
    case '57014':
      return new StoreError('UNAVAILABLE', 'Database statement timed out');
    case '40001':
    case '40P01':
      return new StoreError('CONFLICT', 'Database transaction conflict; retry the request');
    case '53300':
      return new StoreError('UNAVAILABLE', 'Database connection limit reached');
    case '57P01':
    case '57P02':
    case '57P03':
      return new StoreError('UNAVAILABLE', 'Database is shutting down or unavailable');
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return new StoreError('UNAVAILABLE', 'Database is unreachable');
    default:
      return new StoreError('INTEGRITY', `PostgreSQL query failed${code ? ` (${code})` : ''}: ${pgErrorMessage(error)}`);
  }
}

function mapProfileRow(row: ProfileRow): ProfileSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: toEpochMillis(row.created_at),
    updatedAt: toEpochMillis(row.updated_at),
    latestRevision: row.latest_revision ?? null,
    revisionCount: row.revision_count,
  };
}

function mapRevisionRow(row: RevisionRow): StoredRevision {
  return {
    profileId: row.profile_id,
    revision: row.revision,
    points: parseJsonColumn<ColorPoint[]>(row.points_json),
    matrix: parseJsonColumn<ColorMatrix>(row.matrix_json),
    mode: row.mode,
    algorithmVersion: row.algorithm_version,
    fingerprint: row.fingerprint,
    contentHash: row.content_hash,
    provenance: parseJsonColumn<CalibrationProvenance>(row.provenance_json),
    meanResidual: row.mean_residual,
    createdAt: toEpochMillis(row.created_at),
  };
}

const PROFILE_SUMMARY_SELECT = `
  SELECT p.id, p.name, p.created_at, p.updated_at,
         MAX(r.revision)::int AS latest_revision,
         COUNT(r.revision)::int AS revision_count
    FROM %PROFILES% p
    LEFT JOIN %REVISIONS% r ON r.profile_id = p.id
`;

const RETRYABLE_CODES = new Set(['40001', '40P01']);

/**
 * PostgreSQL adapter used by the deployed API. Revisions are append-only and
 * addressed only by an explicit (profile_id, revision) pair. Writes that append
 * a revision take a row lock on the profile, so concurrent requests serialise
 * instead of allocating the same revision number.
 */
export class PgCalibrationStore implements CalibrationStoreAdapter {
  readonly kind = 'postgres' as const;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    readonly schema: string,
    private readonly label: string
  ) {}

  get description(): string {
    return this.label;
  }

  private get profiles(): string {
    return `${quoteIdent(this.schema)}.profiles`;
  }

  private get revisions(): string {
    return `${quoteIdent(this.schema)}.revisions`;
  }

  private get idempotency(): string {
    return `${quoteIdent(this.schema)}.idempotency_keys`;
  }

  private async connect(): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw toStoreError(error);
    }
  }

  private async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options: { retryOnUnique?: boolean } = {}
  ): Promise<T> {
    const attempts = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const client = await this.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // the connection may already be broken; nothing was committed
        }
        const code = pgErrorCode(error);
        const retryable =
          (code !== undefined && RETRYABLE_CODES.has(code)) ||
          (options.retryOnUnique === true && code === '23505');
        if (retryable && attempt < attempts - 1) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
          continue;
        }
        throw toStoreError(error);
      } finally {
        client.release();
      }
    }
    throw toStoreError(lastError);
  }

  private async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows as T[];
    } catch (error) {
      throw toStoreError(error);
    }
  }

  private async findByProfile(client: PoolClient, profileId: string): Promise<ProfileSummary> {
    const sql = PROFILE_SUMMARY_SELECT
      .replace('%PROFILES%', this.profiles)
      .replace('%REVISIONS%', this.revisions)
      .concat(' WHERE p.id = $1 GROUP BY p.id');
    const result = await client.query<ProfileRow>(sql, [profileId]);
    const row = result.rows[0];
    if (!row) throw new StoreError('NOT_FOUND', 'Calibration profile not found');
    return mapProfileRow(row);
  }

  private async findIdempotency(
    client: PoolClient,
    scopeKey: string
  ): Promise<{ profileId: string; revision: number } | null> {
    const result = await client.query<{ profile_id: string; revision: number }>(
      `SELECT profile_id, revision FROM ${this.idempotency} WHERE key = $1`,
      [scopeKey]
    );
    const row = result.rows[0];
    return row ? { profileId: row.profile_id, revision: row.revision } : null;
  }

  private async recordIdempotency(
    client: PoolClient,
    scopeKey: string,
    profileId: string,
    revision: number,
    now: number
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.idempotency} (key, profile_id, revision, created_at)
       VALUES ($1, $2, $3, $4)`,
      [scopeKey, profileId, revision, now]
    );
  }

  private async readRevision(
    client: PoolClient,
    profileId: string,
    revision: number
  ): Promise<StoredRevision | null> {
    const result = await client.query<RevisionRow>(
      `SELECT ${REVISION_SELECT} FROM ${this.revisions} WHERE profile_id = $1 AND revision = $2`,
      [profileId, revision]
    );
    const row = result.rows[0];
    return row ? mapRevisionRow(row) : null;
  }

  async createProfile(
    name: string,
    draft: RevisionDraft,
    options?: StoreWriteOptions
  ): Promise<{ profile: ProfileSummary; revision: StoredRevision }> {
    const idempotencyKey = options?.idempotencyKey
      ? scopeIdempotencyKey('create', options.idempotencyKey)
      : null;

    return this.transaction(
      async (client) => {
        if (idempotencyKey) {
          const replay = await this.findIdempotency(client, idempotencyKey);
          if (replay) {
            const profile = await this.findByProfile(client, replay.profileId);
            const revision = await this.readRevision(client, replay.profileId, replay.revision);
            if (!revision) {
              throw new StoreError(
                'INTEGRITY',
                'Idempotent create points at a revision that no longer exists'
              );
            }
            return { profile, revision };
          }
        }

        const now = Date.now();
        const id = newProfileId(now);
        await client.query(
          `INSERT INTO ${this.profiles} (id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $3)`,
          [id, name, now]
        );
        const revision = await this.insertRevision(client, id, 1, draft, now);
        if (idempotencyKey) {
          await this.recordIdempotency(client, idempotencyKey, id, 1, now);
        }
        return {
          profile: {
            id,
            name,
            createdAt: now,
            updatedAt: now,
            latestRevision: 1,
            revisionCount: 1,
          },
          revision,
        };
      },
      { retryOnUnique: idempotencyKey !== null }
    );
  }

  async appendRevision(
    profileId: string,
    draft: RevisionDraft,
    options?: StoreWriteOptions
  ): Promise<StoredRevision> {
    const idempotencyKey = options?.idempotencyKey
      ? scopeIdempotencyKey(`append:${profileId}`, options.idempotencyKey)
      : null;

    return this.transaction(
      async (client) => {
        // Serialise appenders per profile: the lock is held until commit, so
        // MAX(revision) is read against a stable, current row set.
        const profile = await client.query(
          `SELECT id FROM ${this.profiles} WHERE id = $1 FOR UPDATE`,
          [profileId]
        );
        if (profile.rowCount === 0) {
          throw new StoreError('NOT_FOUND', 'Calibration profile not found');
        }

        if (idempotencyKey) {
          const replay = await this.findIdempotency(client, idempotencyKey);
          if (replay) {
            if (replay.profileId !== profileId) {
              throw new StoreError(
                'INTEGRITY',
                'Idempotency key is bound to a different calibration profile'
              );
            }
            const revision = await this.readRevision(client, profileId, replay.revision);
            if (!revision) {
              throw new StoreError(
                'INTEGRITY',
                'Idempotent append points at a revision that no longer exists'
              );
            }
            return revision;
          }
        }

        const current = await client.query<{ max_revision: number | null; count: number }>(
          `SELECT MAX(revision)::int AS max_revision, COUNT(*)::int AS count
             FROM ${this.revisions} WHERE profile_id = $1`,
          [profileId]
        );
        const { max_revision: maxRevision, count } = current.rows[0] ?? {
          max_revision: null,
          count: 0,
        };
        if (count >= CALIBRATION_LIMITS.maxRevisionsPerProfile) {
          throw new StoreError('LIMIT', 'Revision limit reached for this profile');
        }

        const now = Date.now();
        const next = (maxRevision ?? 0) + 1;
        const revision = await this.insertRevision(client, profileId, next, draft, now);
        await client.query(`UPDATE ${this.profiles} SET updated_at = $1 WHERE id = $2`, [
          now,
          profileId,
        ]);
        if (idempotencyKey) {
          await this.recordIdempotency(client, idempotencyKey, profileId, next, now);
        }
        return revision;
      },
      { retryOnUnique: idempotencyKey !== null }
    );
  }

  private async insertRevision(
    client: PoolClient,
    profileId: string,
    revision: number,
    draft: RevisionDraft,
    createdAt: number
  ): Promise<StoredRevision> {
    const provenance: CalibrationProvenance = {
      ...draft.provenance,
      revision,
      profileId,
      contentHash: draft.contentHash,
      createdAt,
    };
    await client.query(
      `INSERT INTO ${this.revisions}
         (profile_id, revision, points_json, matrix_json, mode, algorithm_version,
          fingerprint, content_hash, provenance_json, mean_residual, created_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [
        profileId,
        revision,
        JSON.stringify(draft.points),
        JSON.stringify(draft.matrix),
        draft.mode,
        draft.algorithmVersion,
        draft.fingerprint,
        draft.contentHash,
        JSON.stringify(provenance),
        draft.meanResidual,
        createdAt,
      ]
    );
    return { ...draft, provenance, profileId, revision, createdAt };
  }

  async listProfiles(limit = 50): Promise<ProfileSummary[]> {
    const sql = PROFILE_SUMMARY_SELECT
      .replace('%PROFILES%', this.profiles)
      .replace('%REVISIONS%', this.revisions)
      .concat(' GROUP BY p.id ORDER BY p.updated_at DESC, p.id ASC LIMIT $1');
    const rows = await this.rows<ProfileRow>(sql, [clampProfileLimit(limit)]);
    return rows.map(mapProfileRow);
  }

  async getProfile(id: string): Promise<ProfileDetail | null> {
    const sql = PROFILE_SUMMARY_SELECT
      .replace('%PROFILES%', this.profiles)
      .replace('%REVISIONS%', this.revisions)
      .concat(' WHERE p.id = $1 GROUP BY p.id');
    const rows = await this.rows<ProfileRow>(sql, [id]);
    const row = rows[0];
    if (!row) return null;
    const revisions = await this.rows<{
      revision: number;
      created_at: unknown;
      mode: 'simple' | 'advanced';
      algorithm_version: string;
      fingerprint: string;
      content_hash: string;
      mean_residual: number;
    }>(
      `SELECT revision, created_at, mode, algorithm_version, fingerprint, content_hash, mean_residual
         FROM ${this.revisions} WHERE profile_id = $1 ORDER BY revision ASC`,
      [id]
    );
    return {
      ...mapProfileRow(row),
      revisions: revisions.map(
        (item): RevisionSummary => ({
          revision: item.revision,
          createdAt: toEpochMillis(item.created_at),
          mode: item.mode,
          algorithmVersion: item.algorithm_version,
          fingerprint: item.fingerprint,
          contentHash: item.content_hash,
          meanResidual: item.mean_residual,
        })
      ),
    };
  }

  async getRevision(profileId: string, revision: number): Promise<StoredRevision | null> {
    const rows = await this.rows<RevisionRow>(
      `SELECT ${REVISION_SELECT} FROM ${this.revisions} WHERE profile_id = $1 AND revision = $2`,
      [profileId, revision]
    );
    const row = rows[0];
    return row ? mapRevisionRow(row) : null;
  }

  async countProfiles(): Promise<number> {
    const rows = await this.rows<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${this.profiles}`
    );
    return rows[0]?.count ?? 0;
  }

  async ping(): Promise<void> {
    await this.rows('SELECT 1');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => undefined);
  }
}

export interface PgStoreSettings extends PgConnectionSettings {
  migrationMode?: 'verify' | 'apply';
  migrationsDir?: string;
  /** Structural/write probe at boot; disable only for diagnostic tooling. */
  verifyOnOpen?: boolean;
}

/**
 * Open the PostgreSQL store, optionally apply the checked-in migrations, then
 * refuse to proceed unless the schema matches this build exactly. The startup
 * path never falls back to SQLite.
 */
export async function openPgStore(
  settings: PgStoreSettings
): Promise<{ store: PgCalibrationStore; schemaReport: SchemaReport }> {
  const { schema } = settings;
  quoteIdent(schema); // validates before any SQL is built
  const migrations = await loadMigrations(settings.migrationsDir);
  const pool = new Pool(pgPoolConfig(settings));
  pool.on('error', (error: Error) => {
    // Idle-client errors are logged without connection details and never crash
    // the process; awaited queries report their own failures.
    console.error(
      JSON.stringify({ level: 'error', event: 'pg_pool_error', code: pgErrorCode(error) ?? null })
    );
  });

  try {
    if (settings.migrationMode === 'apply') {
      const applied = await applyMigrations(pool, schema, migrations);
      console.log(
        JSON.stringify({ event: 'migrations_applied', schema, applied: applied.applied })
      );
    }
    const schemaReport = await verifySchema(pool, schema, migrations, {
      probe: settings.verifyOnOpen !== false,
    });
    const store = new PgCalibrationStore(pool, schema, describePgTarget(settings));
    return { store, schemaReport };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

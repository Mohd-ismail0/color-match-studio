import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CalibrationProvenance,
  ColorMatrix,
  ColorPoint,
} from '../src/types/colorCorrector';
import {
  CALIBRATION_LIMITS,
  DEFAULT_DB_RELATIVE_PATH,
} from '../src/lib/calibrationLimits';

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

export class StoreError extends Error {
  code: 'NOT_FOUND' | 'LIMIT' | 'CONFLICT' | 'INTEGRITY';

  constructor(code: StoreError['code'], message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

interface RevisionRow {
  profile_id: string;
  revision: number;
  points_json: string;
  matrix_json: string;
  mode: 'simple' | 'advanced';
  algorithm_version: string;
  fingerprint: string;
  content_hash: string;
  provenance_json: string;
  mean_residual: number;
  created_at: number;
}

interface ProfileRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  latest_revision: number | null;
  revision_count: number;
}

function repoRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a durable store path. The default is deliberately outside the
 * repository; an explicit path inside the repo is rejected unless
 * COLOR_DB_ALLOW_REPO=1 (tests use scratch/temp paths).
 */
export function resolveDbPath(explicit?: string): string {
  const candidate =
    explicit || process.env.COLOR_DB_PATH || path.join(homedir(), DEFAULT_DB_RELATIVE_PATH);
  if (candidate === ':memory:') return candidate;

  const absolute = path.resolve(candidate);
  if (process.env.COLOR_DB_ALLOW_REPO !== '1') {
    const root = repoRoot(process.cwd());
    if (root && (absolute === root || absolute.startsWith(root + path.sep))) {
      throw new Error(
        'Refusing to store calibration data inside the repository. Set COLOR_DB_PATH to a persistent location outside the repo.'
      );
    }
  }
  mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  return absolute;
}

export class CalibrationStore {
  private db: DatabaseSync;
  readonly path: string;

  constructor(dbPath?: string) {
    this.path = resolveDbPath(dbPath);
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS revisions (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        points_json TEXT NOT NULL,
        matrix_json TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('simple', 'advanced')),
        algorithm_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        mean_residual REAL NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, revision)
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS revisions_immutable_update
      BEFORE UPDATE ON revisions
      BEGIN
        SELECT RAISE(ABORT, 'calibration revisions are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS revisions_immutable_delete
      BEFORE DELETE ON revisions
      BEGIN
        SELECT RAISE(ABORT, 'calibration revisions are immutable');
      END;
    `);
    if (this.path !== ':memory:') {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // best effort; the directory itself is 0700
      }
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw error;
    }
  }

  createProfile(name: string, draft: RevisionDraft): { profile: ProfileSummary; revision: StoredRevision } {
    const now = Date.now();
    const id = `cal_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return this.transaction(() => {
      this.db
        .prepare('INSERT INTO profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, name, now, now);
      const revision = this.insertRevision(id, 1, draft, now);
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
    });
  }

  appendRevision(profileId: string, draft: RevisionDraft): StoredRevision {
    return this.transaction(() => {
      const profile = this.db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as
        | { id: string }
        | undefined;
      if (!profile) throw new StoreError('NOT_FOUND', 'Calibration profile not found');

      const row = this.db
        .prepare('SELECT MAX(revision) AS max_revision, COUNT(*) AS count FROM revisions WHERE profile_id = ?')
        .get(profileId) as { max_revision: number | null; count: number };
      if (row.count >= CALIBRATION_LIMITS.maxRevisionsPerProfile) {
        throw new StoreError('LIMIT', 'Revision limit reached for this profile');
      }
      const next = (row.max_revision ?? 0) + 1;
      const now = Date.now();
      const revision = this.insertRevision(profileId, next, draft, now);
      this.db.prepare('UPDATE profiles SET updated_at = ? WHERE id = ?').run(now, profileId);
      return revision;
    });
  }

  private insertRevision(
    profileId: string,
    revision: number,
    draft: RevisionDraft,
    createdAt: number
  ): StoredRevision {
    const provenance: CalibrationProvenance = {
      ...draft.provenance,
      revision,
      profileId,
      contentHash: draft.contentHash,
      createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO revisions
         (profile_id, revision, points_json, matrix_json, mode, algorithm_version,
          fingerprint, content_hash, provenance_json, mean_residual, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
        createdAt
      );
    return { ...draft, provenance, profileId, revision, createdAt };
  }

  listProfiles(limit = 50): ProfileSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at, p.updated_at,
                MAX(r.revision) AS latest_revision, COUNT(r.revision) AS revision_count
         FROM profiles p
         LEFT JOIN revisions r ON r.profile_id = p.id
         GROUP BY p.id
         ORDER BY p.updated_at DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(500, limit))) as unknown as ProfileRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestRevision: row.latest_revision ?? null,
      revisionCount: row.revision_count,
    }));
  }

  getProfile(id: string): ProfileDetail | null {
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at, p.updated_at,
                MAX(r.revision) AS latest_revision, COUNT(r.revision) AS revision_count
         FROM profiles p LEFT JOIN revisions r ON r.profile_id = p.id
         WHERE p.id = ? GROUP BY p.id`
      )
      .get(id) as unknown as ProfileRow | undefined;
    if (!row) return null;
    const revisions = this.db
      .prepare(
        `SELECT revision, created_at, mode, algorithm_version, fingerprint, content_hash, mean_residual
         FROM revisions WHERE profile_id = ? ORDER BY revision ASC`
      )
      .all(id) as unknown as Array<{
      revision: number;
      created_at: number;
      mode: 'simple' | 'advanced';
      algorithm_version: string;
      fingerprint: string;
      content_hash: string;
      mean_residual: number;
    }>;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      latestRevision: row.latest_revision ?? null,
      revisionCount: row.revision_count,
      revisions: revisions.map((r) => ({
        revision: r.revision,
        createdAt: r.created_at,
        mode: r.mode,
        algorithmVersion: r.algorithm_version,
        fingerprint: r.fingerprint,
        contentHash: r.content_hash,
        meanResidual: r.mean_residual,
      })),
    };
  }

  /** Explicit revision lookup; no "latest" fallback exists by design. */
  getRevision(profileId: string, revision: number): StoredRevision | null {
    const row = this.db
      .prepare('SELECT * FROM revisions WHERE profile_id = ? AND revision = ?')
      .get(profileId, revision) as unknown as RevisionRow | undefined;
    if (!row) return null;
    const matrix = JSON.parse(row.matrix_json) as ColorMatrix;
    const points = JSON.parse(row.points_json) as ColorPoint[];
    const provenance = JSON.parse(row.provenance_json) as CalibrationProvenance;
    return {
      profileId: row.profile_id,
      revision: row.revision,
      points,
      matrix,
      mode: row.mode,
      algorithmVersion: row.algorithm_version,
      fingerprint: row.fingerprint,
      contentHash: row.content_hash,
      provenance,
      meanResidual: row.mean_residual,
      createdAt: row.created_at,
    };
  }

  countProfiles(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM profiles').get() as {
      count: number;
    };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}

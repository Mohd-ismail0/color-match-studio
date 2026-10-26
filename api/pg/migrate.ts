import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  assertValidSchemaName,
  describePgTarget,
  pgPoolConfig,
  pgSettingsFromEnv,
  quoteIdent,
  type PgConnectionSettings,
} from './config';

export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
);

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export type SchemaErrorCode = 'SCHEMA_MISSING' | 'SCHEMA_MISMATCH' | 'SCHEMA_UNVERIFIED';

export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly problems: string[];

  constructor(code: SchemaErrorCode, problems: string[]) {
    super(`${code}: ${problems.join('; ')}`);
    this.name = 'SchemaError';
    this.code = code;
    this.problems = problems;
  }
}

export interface Migration {
  id: string;
  checksum: string;
  sql: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => MIGRATION_FILE.test(name)).sort();
  if (files.length === 0) {
    throw new Error(`No SQL migrations found in ${dir}`);
  }

  const seen = new Set<string>();
  const migrations: Migration[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const prefix = MIGRATION_FILE.exec(file)?.[1];
    if (!prefix || seen.has(prefix)) {
      throw new Error(`Duplicate or malformed migration prefix for ${file}`);
    }
    seen.add(prefix);
    const sql = await readFile(path.join(dir, file), 'utf8');
    if (sql.trim() === '') throw new Error(`Migration ${file} is empty`);
    migrations.push({ id, checksum: sha256(sql), sql });
  }
  return migrations;
}

/** Substitute the validated schema identifier; refuse unrendered placeholders. */
export function renderMigration(sql: string, schema: string): string {
  const rendered = sql.split('{{schema}}').join(quoteIdent(schema));
  if (rendered.includes('{{')) {
    throw new Error('Migration contains an unknown placeholder');
  }
  return rendered;
}

export interface MigrationResult {
  schema: string;
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply pending migrations inside one transaction (including the CREATE SCHEMA
 * and the ledger rows), guarded by an advisory lock so two deployers cannot
 * race. A failure leaves the schema exactly as it was.
 */
export async function applyMigrations(
  pool: Pool,
  schema: string,
  migrations: Migration[]
): Promise<MigrationResult> {
  assertValidSchemaName(schema);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `color-match-studio:migrate:${schema}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.schema_migrations (
        id text NOT NULL PRIMARY KEY,
        checksum text NOT NULL,
        applied_at bigint NOT NULL
      )
    `);

    const ledger = await client.query<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM ${quoteIdent(schema)}.schema_migrations ORDER BY id`
    );
    const known = new Map(migrations.map((migration) => [migration.id, migration]));
    const problems: string[] = [];
    for (const row of ledger.rows) {
      const migration = known.get(row.id);
      if (!migration) {
        problems.push(`database has migration ${row.id}, which this build does not contain`);
      } else if (migration.checksum !== row.checksum) {
        problems.push(`migration ${row.id} was modified after it was applied`);
      }
    }
    if (problems.length > 0) throw new SchemaError('SCHEMA_MISMATCH', problems);

    const appliedIds = new Set(ledger.rows.map((row) => row.id));
    const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
    for (const migration of pending) {
      await client.query(renderMigration(migration.sql, schema));
      await client.query(
        `INSERT INTO ${quoteIdent(schema)}.schema_migrations (id, checksum, applied_at)
         VALUES ($1, $2, $3)`,
        [migration.id, migration.checksum, Date.now()]
      );
    }

    await client.query('COMMIT');
    return {
      schema,
      applied: pending.map((migration) => migration.id),
      alreadyApplied: [...appliedIds].sort(),
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the transaction is already gone; the original error is what matters
    }
    throw error;
  } finally {
    client.release();
  }
}

interface TableExpectation {
  columns: Record<string, string>;
  primaryKey: string[];
}

const REQUIRED_TABLES: Record<string, TableExpectation> = {
  profiles: {
    columns: { id: 'text', name: 'text', created_at: 'bigint', updated_at: 'bigint' },
    primaryKey: ['id'],
  },
  revisions: {
    columns: {
      profile_id: 'text',
      revision: 'integer',
      points_json: 'jsonb',
      matrix_json: 'jsonb',
      mode: 'text',
      algorithm_version: 'text',
      fingerprint: 'text',
      content_hash: 'text',
      provenance_json: 'jsonb',
      mean_residual: 'double precision',
      created_at: 'bigint',
    },
    primaryKey: ['profile_id', 'revision'],
  },
  idempotency_keys: {
    columns: {
      key: 'text',
      profile_id: 'text',
      revision: 'integer',
      created_at: 'bigint',
    },
    primaryKey: ['key'],
  },
  schema_migrations: {
    columns: { id: 'text', checksum: 'text', applied_at: 'bigint' },
    primaryKey: ['id'],
  },
};

const REQUIRED_TRIGGERS: Record<string, string[]> = {
  revisions: ['revisions_immutable', 'revisions_no_truncate'],
};

function pgErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function pgErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface VerifyOptions {
  /** Run a rolled-back write probe proving the immutability trigger fires. */
  probe?: boolean;
}

export interface SchemaReport {
  schema: string;
  migrations: string[];
  probeRun: boolean;
}

/**
 * Refuse to serve from a schema that is absent, of a different migration
 * version, structurally different, or whose immutability guard is inert.
 */
export async function verifySchema(
  pool: Pool,
  schema: string,
  migrations: Migration[],
  options: VerifyOptions = {}
): Promise<SchemaReport> {
  assertValidSchemaName(schema);
  const missing: string[] = [];
  const mismatch: string[] = [];
  const unverified: string[] = [];
  const rel = (table: string): string => `${quoteIdent(schema)}.${quoteIdent(table)}`;

  const schemaRow = await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
  if (schemaRow.rowCount === 0) {
    throw new SchemaError('SCHEMA_MISSING', [
      `schema "${schema}" does not exist; run the checked-in migrations first`,
    ]);
  }

  const ledger = await pool.query<{ id: string; checksum: string }>(
    `SELECT id, checksum FROM ${rel('schema_migrations')} ORDER BY id`
  ).catch(() => null);
  if (!ledger) {
    throw new SchemaError('SCHEMA_MISSING', [
      `schema "${schema}" has no schema_migrations ledger; it was not initialised by this API`,
    ]);
  }

  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  const appliedIds = new Set<string>();
  for (const row of ledger.rows) {
    appliedIds.add(row.id);
    const migration = known.get(row.id);
    if (!migration) {
      mismatch.push(`database has migration ${row.id}, which this build does not contain`);
    } else if (migration.checksum !== row.checksum) {
      mismatch.push(`migration ${row.id} was modified after it was applied`);
    }
  }
  for (const migration of migrations) {
    if (!appliedIds.has(migration.id)) {
      missing.push(`migration ${migration.id} has not been applied`);
    }
  }

  const columnRows = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [schema, Object.keys(REQUIRED_TABLES)]
  );
  const columnsByTable = new Map<string, Map<string, string>>();
  for (const row of columnRows.rows) {
    const table = columnsByTable.get(row.table_name) ?? new Map<string, string>();
    table.set(row.column_name, row.data_type);
    columnsByTable.set(row.table_name, table);
  }

  for (const [table, expectation] of Object.entries(REQUIRED_TABLES)) {
    const actual = columnsByTable.get(table);
    if (!actual) {
      missing.push(`table ${table} is missing`);
      continue;
    }
    for (const [column, type] of Object.entries(expectation.columns)) {
      const actualType = actual.get(column);
      if (!actualType) mismatch.push(`${table}.${column} is missing`);
      else if (actualType !== type) {
        mismatch.push(`${table}.${column} is ${actualType}, expected ${type}`);
      }
    }
    for (const column of actual.keys()) {
      if (!(column in expectation.columns)) {
        mismatch.push(`${table} has unexpected column ${column}`);
      }
    }
  }

  const keyRows = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE con.contype = 'p' AND ns.nspname = $1
      ORDER BY c.relname, k.position`,
    [schema]
  );
  const keysByTable = new Map<string, string[]>();
  for (const row of keyRows.rows) {
    keysByTable.set(row.table_name, [...(keysByTable.get(row.table_name) ?? []), row.column_name]);
  }
  for (const [table, expectation] of Object.entries(REQUIRED_TABLES)) {
    if (!columnsByTable.has(table)) continue;
    const actual = keysByTable.get(table) ?? [];
    if (actual.join(',') !== expectation.primaryKey.join(',')) {
      mismatch.push(
        `${table} primary key is (${actual.join(', ')}), expected (${expectation.primaryKey.join(', ')})`
      );
    }
  }

  if (columnsByTable.has('revisions')) {
    const fk = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = to_regclass($1) AND contype = 'f'`,
      [rel('revisions')]
    );
    const profileFk = fk.rows
      .map((row) => row.definition)
      .find((definition) => definition.includes('REFERENCES'));
    if (!profileFk) {
      mismatch.push('revisions.profile_id has no foreign key to profiles');
    } else {
      if (!profileFk.includes('profiles')) {
        mismatch.push('revisions foreign key does not reference profiles');
      }
      if (!/ON DELETE RESTRICT/.test(profileFk)) {
        mismatch.push('revisions foreign key does not use ON DELETE RESTRICT');
      }
    }
  }

  if (columnsByTable.has('revisions')) {
    const triggers = await pool.query<{ name: string; definition: string }>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgrelid = to_regclass($1) AND NOT tgisinternal`,
      [rel('revisions')]
    );
    const byName = new Map(triggers.rows.map((row) => [row.name, row.definition]));
    for (const name of REQUIRED_TRIGGERS.revisions) {
      const definition = byName.get(name);
      if (!definition) {
        mismatch.push(`revisions is missing the ${name} trigger`);
      } else if (name === 'revisions_immutable' && !/UPDATE|DELETE/.test(definition)) {
        mismatch.push('revisions_immutable trigger does not cover UPDATE/DELETE');
      } else if (name === 'revisions_no_truncate' && !/TRUNCATE/.test(definition)) {
        mismatch.push('revisions_no_truncate trigger does not cover TRUNCATE');
      }
    }
  }

  const fn = await pool.query(
    `SELECT 1
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = 'reject_revision_mutation'`,
    [schema]
  );
  if (fn.rowCount === 0) {
    mismatch.push('reject_revision_mutation() function is missing');
  }

  if (missing.length > 0) throw new SchemaError('SCHEMA_MISSING', [...missing, ...mismatch]);
  if (mismatch.length > 0) throw new SchemaError('SCHEMA_MISMATCH', mismatch);

  let probeRun = false;
  if (options.probe !== false) {
    const problems = await probeImmutability(pool, schema);
    probeRun = true;
    if (problems.length > 0) throw new SchemaError('SCHEMA_UNVERIFIED', problems);
  }

  return { schema, migrations: [...appliedIds].sort(), probeRun };
}

/**
 * Prove in a transaction that is always rolled back that revisions reject
 * UPDATE and DELETE. A privilege error is an acceptable alternative refusal:
 * the row still cannot be rewritten.
 */
async function probeImmutability(pool: Pool, schema: string): Promise<string[]> {
  const problems: string[] = [];
  const profiles = `${quoteIdent(schema)}.profiles`;
  const revisions = `${quoteIdent(schema)}.revisions`;
  const client = await pool.connect();
  const probeId = 'cal_schema_verify';
  try {
    await client.query('BEGIN');
    const now = Date.now();
    await client.query(
      `INSERT INTO ${profiles} (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [probeId, 'schema verification probe', now]
    );
    await client.query(
      `INSERT INTO ${revisions}
         (profile_id, revision, points_json, matrix_json, mode, algorithm_version,
          fingerprint, content_hash, provenance_json, mean_residual, created_at)
       VALUES ($1, 1, '[]'::jsonb, '{}'::jsonb, 'simple', 'verify', $2, $3, '{}'::jsonb, 0, $4)`,
      [probeId, 'a'.repeat(16), 'a'.repeat(64), now]
    );

    const expectRejected = async (
      sql: string,
      params: unknown[],
      label: string
    ): Promise<void> => {
      await client.query('SAVEPOINT probe');
      try {
        await client.query(sql, params);
        problems.push(`revisions accepted ${label}; the immutability guard is inert`);
      } catch (error) {
        const code = pgErrorCode(error);
        const message = pgErrorMessage(error);
        if (code === '42501') {
          // The runtime role cannot even attempt the mutation: still immutable.
        } else if (!/immutable/i.test(message)) {
          problems.push(`revisions ${label} failed for an unexpected reason: ${message}`);
        }
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT probe');
      }
    };

    await expectRejected(
      `UPDATE ${revisions} SET mean_residual = 1 WHERE profile_id = $1`,
      [probeId],
      'UPDATE'
    );
    await expectRejected(`DELETE FROM ${revisions} WHERE profile_id = $1`, [probeId], 'DELETE');
  } catch (error) {
    problems.push(
      `schema write probe could not run (check runtime grants on ${schema}.profiles/revisions): ${pgErrorMessage(error)}`
    );
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken; nothing was committed
    }
    client.release();
  }
  return problems;
}

/** Inspect a deployment without mutating it. */
export async function inspectSchema(
  settings: PgConnectionSettings,
  migrations: Migration[]
): Promise<{ report: SchemaReport; target: string }> {
  const pool = new Pool(pgPoolConfig(settings));
  pool.on('error', () => {
    // Failures surface on the awaited query; an idle client error must not crash.
  });
  try {
    const report = await verifySchema(pool, settings.schema, migrations, { probe: true });
    return { report, target: describePgTarget(settings) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const settings = pgSettingsFromEnv();
  const migrations = await loadMigrations();
  const pool = new Pool(pgPoolConfig(settings));
  pool.on('error', () => {
    // See inspectSchema: awaited queries surface their own errors.
  });

  try {
    const result = apply ? await applyMigrations(pool, settings.schema, migrations) : null;
    const report = await verifySchema(pool, settings.schema, migrations, { probe: true });
    console.log(
      JSON.stringify({
        event: 'schema_ready',
        target: describePgTarget(settings),
        schema: report.schema,
        migrations: report.migrations,
        applied: result?.applied ?? [],
        probe: report.probeRun,
      })
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const invokedDirectly =
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const payload =
      error instanceof SchemaError
        ? { level: 'fatal', event: 'schema_refused', code: error.code, problems: error.problems }
        : {
            level: 'fatal',
            event: 'schema_refused',
            message: pgErrorMessage(error),
            code: pgErrorCode(error) ?? null,
          };
    console.error(JSON.stringify(payload));
    process.exit(1);
  });
}

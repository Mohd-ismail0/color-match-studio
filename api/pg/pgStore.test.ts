// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  parseSslMode,
  pgPoolConfig,
  quoteIdent,
  resolveSslCa,
  type PgSslMode,
} from './config';
import { openPgStore, type PgStoreSettings } from './pgStore';
import {
  applyMigrations,
  loadMigrations,
  SchemaError,
  verifySchema,
  type Migration,
} from './migrate';
import { contractDraft, describeStoreContract } from '../testing/storeContract';
import type { CalibrationStoreAdapter } from '../storeContract';

const connectionString = process.env.COLOR_PG_TEST_URL;
const schema = process.env.COLOR_PG_TEST_SCHEMA ?? 'color_match_test';
const sslMode: PgSslMode = parseSslMode(process.env.COLOR_PG_TEST_SSL);

// Real-database tests only run against a dedicated namespace inside the
// application database that the parent supplies; they must never touch
// `public` or another application's schema.
const DEDICATED_TEST_SCHEMA = /^color_match_test[a-z0-9_]*$/;
if (connectionString && !DEDICATED_TEST_SCHEMA.test(schema)) {
  throw new Error(
    'COLOR_PG_TEST_SCHEMA must be a dedicated test schema matching ^color_match_test[a-z0-9_]*$'
  );
}

const enabled = Boolean(connectionString);

function settings(overrides: Partial<PgStoreSettings> = {}): PgStoreSettings {
  if (!connectionString) throw new Error('COLOR_PG_TEST_URL is not set');
  return {
    connectionString,
    schema,
    sslMode,
    sslCa: resolveSslCa(process.env.COLOR_PG_TEST_SSL_CA),
    sslServerName: process.env.COLOR_PG_TEST_SSL_SERVERNAME,
    maxConnections: 6,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    applicationName: 'color-match-studio-api-test',
    migrationMode: 'verify',
    ...overrides,
  };
}

describe.skipIf(!enabled)('postgres adapter', () => {
  let pool: Pool;
  let migrations: Migration[];

  beforeAll(async () => {
    pool = new Pool(pgPoolConfig(settings()));
    pool.on('error', () => {
      // Awaited queries report their own failures.
    });
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    migrations = await loadMigrations();
    await applyMigrations(pool, schema, migrations);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  describeStoreContract('postgres', async (): Promise<CalibrationStoreAdapter> => {
    const { store } = await openPgStore(settings());
    return store;
  });

  it('does not expose credentials in the startup description', async () => {
    const { store } = await openPgStore(settings());
    try {
      expect(store.description).not.toContain('@');
      expect(store.description).toMatch(/schema=/);
      expect(store.kind).toBe('postgres');
    } finally {
      await store.close();
    }
  });

  it('rejects UPDATE, DELETE and TRUNCATE of revisions in the database', async () => {
    const { store } = await openPgStore(settings());
    const revisions = `${quoteIdent(schema)}.revisions`;
    try {
      const created = await store.createProfile('Immutable studio', contractDraft());

      const outcomes: unknown[] = [];
      for (const statement of [
        `UPDATE ${revisions} SET mean_residual = 1`,
        `DELETE FROM ${revisions}`,
        `TRUNCATE ${revisions}`,
      ]) {
        await expect(pool.query(statement)).rejects.toMatchObject({ code: expect.any(String) });
        outcomes.push(statement);
      }
      expect(outcomes).toHaveLength(3);

      // The row is still exactly as written.
      const revision = await store.getRevision(created.profile.id, 1);
      expect(revision?.contentHash).toBe(created.revision.contentHash);
    } finally {
      await store.close();
    }
  });

  it('is idempotent when the migration ledger already matches', async () => {
    const again = await applyMigrations(pool, schema, migrations);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain('0001_calibration_store');
  });

  it('refuses an absent schema instead of initialising implicitly', async () => {
    const emptySchema = `${schema}_empty`;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(emptySchema)} CASCADE`);
    const report = verifySchema(pool, emptySchema, migrations);
    await expect(report).rejects.toMatchObject({ code: 'SCHEMA_MISSING' });
  });

  it('refuses a structurally incorrect schema', async () => {
    const brokenSchema = `${schema}_broken`;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(brokenSchema)} CASCADE`);
    try {
      await applyMigrations(pool, brokenSchema, migrations);
      await pool.query(`DROP TRIGGER revisions_immutable ON ${quoteIdent(brokenSchema)}.revisions`);
      await expect(
        verifySchema(pool, brokenSchema, migrations, { probe: false })
      ).rejects.toBeInstanceOf(SchemaError);
      await expect(
        verifySchema(pool, brokenSchema, migrations, { probe: false })
      ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(brokenSchema)} CASCADE`);
    }
  });

  it('refuses a ledger that no longer matches the checked-in migrations', async () => {
    const tamperedSchema = `${schema}_tampered`;
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(tamperedSchema)} CASCADE`);
    try {
      await applyMigrations(pool, tamperedSchema, migrations);
      await pool.query(
        `UPDATE ${quoteIdent(tamperedSchema)}.schema_migrations SET checksum = $1`,
        ['0'.repeat(64)]
      );
      await expect(
        verifySchema(pool, tamperedSchema, migrations, { probe: false })
      ).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(tamperedSchema)} CASCADE`);
    }
  });
});

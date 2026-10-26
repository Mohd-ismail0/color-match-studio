// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertValidSchemaName, quoteIdent } from './config';
import { loadMigrations, renderMigration } from './migrate';

describe('checked-in PostgreSQL migrations', () => {
  it('loads ordered, checksummed SQL files', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations.map((migration) => migration.id)).toEqual(
      [...migrations.map((migration) => migration.id)].sort()
    );
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.sql).toContain('{{schema}}');
    }
  });

  it('declares the append-only revision invariants', async () => {
    const [initial] = await loadMigrations();
    expect(initial.id).toBe('0001_calibration_store');
    expect(initial.sql).toMatch(/PRIMARY KEY \(profile_id, revision\)/);
    expect(initial.sql).toMatch(/REFERENCES \{\{schema\}\}\.profiles/);
    expect(initial.sql).toMatch(/ON DELETE RESTRICT/);
    expect(initial.sql).toMatch(/BEFORE UPDATE OR DELETE/);
    expect(initial.sql).toMatch(/BEFORE TRUNCATE/);
    expect(initial.sql).toMatch(/calibration revisions are immutable/);
    expect(initial.sql).toContain('points_json jsonb NOT NULL');
    expect(initial.sql).toContain('matrix_json jsonb NOT NULL');
    expect(initial.sql).toContain('CREATE TABLE IF NOT EXISTS {{schema}}.idempotency_keys');
  });

  it('renders every statement inside the configured schema', async () => {
    const migrations = await loadMigrations();
    const rendered = renderMigration(migrations[0].sql, 'color_calibration');
    expect(rendered).not.toContain('{{schema}}');
    expect(rendered).toContain('"color_calibration".profiles');
    expect(rendered).toContain('"color_calibration".revisions');
  });

  it('refuses an unsafe schema name before rendering', async () => {
    const migrations = await loadMigrations();
    expect(() => renderMigration(migrations[0].sql, 'public; DROP SCHEMA public CASCADE')).toThrow();
    expect(() => assertValidSchemaName('pg_catalog')).not.toThrow();
    expect(quoteIdent('color_match_test')).toBe('"color_match_test"');
  });
});

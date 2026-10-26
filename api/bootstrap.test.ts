// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  openStoreFromEnvironment,
  resolveDbBackend,
  resolveMigrationMode,
  runtimeHost,
  runtimePort,
} from './bootstrap';
import { assertValidSchemaName, parseSslMode, quoteIdent } from './pg/config';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

const dir = mkdtempSync(path.join(tmpdir(), 'color-bootstrap-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runtime host and port', () => {
  it('binds loopback unless an explicit host is configured', () => {
    expect(runtimeHost(env({}))).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(runtimeHost(env({ COLOR_API_HOST: '0.0.0.0' }))).toBe('0.0.0.0');
    expect(runtimeHost(env({ COLOR_API_HOST: '::' }))).toBe('::');
    expect(() => runtimeHost(env({ COLOR_API_HOST: 'http://0.0.0.0' }))).toThrow();
  });

  it('reads PORT with a bounded integer', () => {
    expect(runtimePort(env({}))).toBe(DEFAULT_PORT);
    expect(runtimePort(env({ PORT: '9000' }))).toBe(9000);
    expect(() => runtimePort(env({ PORT: '0' }))).toThrow();
    expect(() => runtimePort(env({ PORT: 'abc' }))).toThrow();
  });
});

describe('backend selection', () => {
  it('defaults to postgres only when DATABASE_URL is present', () => {
    expect(resolveDbBackend(env({}))).toBe('sqlite');
    expect(resolveDbBackend(env({ DATABASE_URL: 'postgres://u:p@db:5432/app' }))).toBe('postgres');
    expect(resolveDbBackend(env({ COLOR_DB_BACKEND: 'postgres' }))).toBe('postgres');
    expect(
      resolveDbBackend(env({ COLOR_DB_BACKEND: 'sqlite', DATABASE_URL: 'postgres://u:p@db/app' }))
    ).toBe('sqlite');
    expect(() => resolveDbBackend(env({ COLOR_DB_BACKEND: 'mysql' }))).toThrow();
  });

  it('defaults to verifying the schema rather than mutating it', () => {
    expect(resolveMigrationMode(env({}))).toBe('verify');
    expect(resolveMigrationMode(env({ COLOR_DB_MIGRATE: 'apply' }))).toBe('apply');
    expect(() => resolveMigrationMode(env({ COLOR_DB_MIGRATE: 'yolo' }))).toThrow();
  });

  it('refuses the SQLite dev store in production', async () => {
    await expect(
      openStoreFromEnvironment(
        env({ NODE_ENV: 'production', COLOR_DB_BACKEND: 'sqlite', COLOR_DB_PATH: path.join(dir, 'prod.sqlite') })
      )
    ).rejects.toThrow(/Refusing to start the SQLite dev store/i);

    const opened = await openStoreFromEnvironment(
      env({
        NODE_ENV: 'production',
        COLOR_DB_BACKEND: 'sqlite',
        COLOR_DB_ALLOW_SQLITE: '1',
        COLOR_DB_PATH: path.join(dir, 'explicit.sqlite'),
      })
    );
    try {
      expect(opened.backend).toBe('sqlite');
      expect(opened.store.kind).toBe('sqlite');
      await opened.store.ping();
    } finally {
      await opened.store.close();
    }
  });

  it('refuses postgres without DATABASE_URL', async () => {
    await expect(openStoreFromEnvironment(env({ COLOR_DB_BACKEND: 'postgres' }))).rejects.toThrow(
      /DATABASE_URL/
    );
  });
});

describe('postgres naming and TLS configuration', () => {
  it('accepts only plain lowercase schema identifiers', () => {
    expect(assertValidSchemaName('color_calibration')).toBe('color_calibration');
    expect(() => assertValidSchemaName('public; drop schema public cascade')).toThrow();
    expect(() => assertValidSchemaName('Public')).toThrow();
    expect(() => assertValidSchemaName('')).toThrow();
    expect(quoteIdent('color_calibration')).toBe('"color_calibration"');
    expect(() => quoteIdent('a"b')).toThrow();
  });

  it('defaults TLS off for the private LAN database and requires explicit opt-in', () => {
    expect(parseSslMode(undefined)).toBe('disable');
    expect(parseSslMode('require')).toBe('require');
    expect(parseSslMode('verify-full')).toBe('verify-full');
    expect(() => parseSslMode('insecure')).toThrow();
  });
});

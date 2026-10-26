import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

export type PgSslMode = 'disable' | 'require' | 'verify-full';

export interface PgConnectionSettings {
  /** Full URL; never logged, never persisted by the application. */
  connectionString: string;
  schema: string;
  sslMode: PgSslMode;
  sslCa?: string;
  /**
   * Certificate identity to verify when the connection is made to an IP but the
   * server certificate carries only a DNS SAN. Verification still uses the CA.
   */
  sslServerName?: string;
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  /** Applied as `statement_timeout` for every pooled connection when set. */
  statementTimeoutMs?: number;
  applicationName: string;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertValidSchemaName(value: unknown): string {
  if (typeof value !== 'string' || !SCHEMA_NAME.test(value)) {
    throw new Error(
      'COLOR_PG_SCHEMA must be a lowercase PostgreSQL identifier (letters, digits, underscore; max 63 chars)'
    );
  }
  return value;
}

export function quoteIdent(value: string): string {
  if (!SCHEMA_NAME.test(value)) {
    throw new Error(`Refusing to quote unexpected SQL identifier: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

/**
 * A CA may be supplied inline (PEM text) or as a mounted file path. Both are
 * common in container platforms; a path avoids multi-line env values.
 */
export function resolveSslCa(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN CERTIFICATE-----')) return trimmed;
  try {
    return readFileSync(trimmed, 'utf8');
  } catch {
    throw new Error('COLOR_PG_SSL_CA must be PEM text or a readable certificate file path');
  }
}

const SERVER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Optional TLS identity for `verify-full`; must be a bare hostname. */
export function parseServerName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const name = value.trim();
  if (!SERVER_NAME.test(name)) {
    throw new Error('COLOR_PG_SSL_SERVERNAME must be a bare hostname (no scheme, port or path)');
  }
  return name;
}

export function parseSslMode(value: string | undefined): PgSslMode {
  if (value === undefined || value.trim() === '') return 'disable';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'disable' || normalized === 'require' || normalized === 'verify-full') {
    return normalized;
  }
  throw new Error("COLOR_PG_SSL must be one of 'disable', 'require' or 'verify-full'");
}

function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function validateConnectionString(value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error('DATABASE_URL is required when COLOR_DB_BACKEND=postgres');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme');
  }
  if (!parsed.hostname) throw new Error('DATABASE_URL must include a host');
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('DATABASE_URL must include a database name');
  }
  return value;
}

export function pgSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PgConnectionSettings {
  const connectionString = validateConnectionString(env.DATABASE_URL);
  const sslMode = parseSslMode(env.COLOR_PG_SSL);
  const statementTimeout = env.COLOR_PG_STATEMENT_TIMEOUT_MS;
  return {
    connectionString,
    schema: assertValidSchemaName(env.COLOR_PG_SCHEMA ?? 'public'),
    sslMode,
    sslCa: resolveSslCa(env.COLOR_PG_SSL_CA),
    sslServerName: parseServerName(env.COLOR_PG_SSL_SERVERNAME),
    maxConnections: intFromEnv(env, 'COLOR_PG_POOL_MAX', 5, 1, 50),
    connectionTimeoutMs: intFromEnv(env, 'COLOR_PG_CONNECT_TIMEOUT_MS', 10_000, 500, 120_000),
    idleTimeoutMs: intFromEnv(env, 'COLOR_PG_IDLE_TIMEOUT_MS', 30_000, 1_000, 600_000),
    statementTimeoutMs:
      statementTimeout === undefined || statementTimeout.trim() === ''
        ? undefined
        : intFromEnv(env, 'COLOR_PG_STATEMENT_TIMEOUT_MS', 15_000, 1_000, 300_000),
    applicationName: env.COLOR_PG_APP_NAME?.trim() || 'color-match-studio-api',
  };
}

/** `sslmode` in the URL would otherwise fight the explicit TLS setting. */
function stripSslMode(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function pgPoolConfig(settings: PgConnectionSettings): PoolConfig {
  // `require` mirrors libpq's sslmode=require: encrypt the connection but do not
  // verify the certificate chain. It exists for the private LAN database that
  // ships with a self-signed cert; production should prefer `verify-full` (or
  // `require` plus a trusted CA via COLOR_PG_SSL_CA), which pins the chain.
  const ssl =
    settings.sslMode === 'disable'
      ? false
      : settings.sslMode === 'require'
        ? { rejectUnauthorized: false }
        : {
            rejectUnauthorized: true,
            ...(settings.sslCa ? { ca: settings.sslCa } : {}),
            ...(settings.sslServerName ? { servername: settings.sslServerName } : {}),
          };

  return {
    connectionString: stripSslMode(settings.connectionString),
    ssl,
    max: settings.maxConnections,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    application_name: settings.applicationName,
    ...(settings.statementTimeoutMs
      ? { options: `-c statement_timeout=${settings.statementTimeoutMs}` }
      : {}),
  };
}

/** Startup-safe description: schema, host, port and database only. */
export function describePgTarget(settings: PgConnectionSettings): string {
  const url = new URL(settings.connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return `postgres://${url.hostname}:${url.port || '5432'}/${database} schema=${settings.schema}`;
}

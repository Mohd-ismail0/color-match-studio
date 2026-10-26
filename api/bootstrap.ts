import { CalibrationStore } from './store';
import type { CalibrationStoreAdapter } from './storeContract';
import { pgSettingsFromEnv } from './pg/config';
import { openPgStore } from './pg/pgStore';

export type DbBackend = 'postgres' | 'sqlite';
export type MigrationMode = 'verify' | 'apply';

/** Loopback by default; containers must opt into 0.0.0.0 explicitly. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8081;

const HOST_PATTERN = /^[0-9A-Za-z.:[\]_-]+$/;

export function runtimeHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COLOR_API_HOST;
  const host = raw === undefined || raw.trim() === '' ? DEFAULT_HOST : raw.trim();
  if (!HOST_PATTERN.test(host)) {
    throw new Error('COLOR_API_HOST must be an IP address or hostname');
  }
  return host;
}

export function runtimePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function resolveDbBackend(env: NodeJS.ProcessEnv = process.env): DbBackend {
  const raw = env.COLOR_DB_BACKEND?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return env.DATABASE_URL && env.DATABASE_URL.trim() !== '' ? 'postgres' : 'sqlite';
  }
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
  if (raw === 'sqlite') return 'sqlite';
  throw new Error("COLOR_DB_BACKEND must be 'postgres' or 'sqlite'");
}

export function resolveMigrationMode(env: NodeJS.ProcessEnv = process.env): MigrationMode {
  const raw = env.COLOR_DB_MIGRATE?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'verify') return 'verify';
  if (raw === 'apply') return 'apply';
  throw new Error("COLOR_DB_MIGRATE must be 'verify' (default) or 'apply'");
}

export interface OpenedStore {
  store: CalibrationStoreAdapter;
  backend: DbBackend;
}

/**
 * Open the durable store for this process. PostgreSQL is the deployed backend;
 * SQLite remains a local-development convenience and is refused under
 * NODE_ENV=production unless explicitly allowed for a throwaway run.
 */
export async function openStoreFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenedStore> {
  const backend = resolveDbBackend(env);

  if (backend === 'postgres') {
    const settings = pgSettingsFromEnv(env);
    const { store } = await openPgStore({
      ...settings,
      migrationMode: resolveMigrationMode(env),
    });
    return { store, backend };
  }

  if (env.NODE_ENV === 'production' && env.COLOR_DB_ALLOW_SQLITE !== '1') {
    throw new Error(
      'Refusing to start the SQLite dev store with NODE_ENV=production. Provide DATABASE_URL (PostgreSQL); set COLOR_DB_ALLOW_SQLITE=1 only for a throwaway run.'
    );
  }
  return { store: new CalibrationStore(env.COLOR_DB_PATH), backend };
}

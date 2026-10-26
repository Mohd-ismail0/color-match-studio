import { colorApi } from './server';
import { openStoreFromEnvironment, runtimeHost, runtimePort } from './bootstrap';
import { SchemaError } from './pg/migrate';
import { StoreError } from './storeContract';

function fatal(event: string, error: unknown): never {
  const payload: Record<string, unknown> = { level: 'fatal', event };
  if (error instanceof SchemaError) {
    payload.code = error.code;
    payload.problems = error.problems;
  } else if (error instanceof StoreError) {
    payload.code = error.code;
    payload.message = error.message;
  } else {
    payload.message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string } | null)?.code;
    if (code) payload.code = code;
  }
  // Connection strings and API keys are never logged.
  console.error(JSON.stringify(payload));
  process.exit(1);
}

async function main(): Promise<void> {
  const key = process.env.COLOR_API_KEY;
  if (!key) throw new Error('COLOR_API_KEY is required');
  const host = runtimeHost();
  const port = runtimePort();
  const allowedOrigin = process.env.COLOR_API_ALLOWED_ORIGIN;

  const { store } = await openStoreFromEnvironment();
  const server = colorApi(key, { store, allowedOrigin });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  console.log(
    JSON.stringify({
      event: 'listening',
      host,
      port,
      backend: store.kind,
      // Non-secret location: SQLite path, or postgres host/db/schema.
      store: store.description,
      algorithm: 'calibration revisions v2',
    })
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ event: 'shutdown', signal }));
    const timer = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', event: 'shutdown_timeout' }));
      process.exit(1);
    }, 20_000);
    timer.unref();
    try {
      await server.shutdown();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => fatal('startup_failed', error));

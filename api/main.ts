import { colorApi } from './server';

const key = process.env.COLOR_API_KEY;
if (!key) throw new Error('COLOR_API_KEY is required');
const dbPath = process.env.COLOR_DB_PATH;
const port = Number(process.env.PORT || 8081);
const allowedOrigin = process.env.COLOR_API_ALLOWED_ORIGIN;
const server = colorApi(key, { dbPath, allowedOrigin });

server.listen(port, '127.0.0.1', () => {
  console.log(
    JSON.stringify({
      event: 'listening',
      host: '127.0.0.1',
      port,
      // Never log the key itself or its length.
      store: server.store.path,
      algorithm: 'calibration revisions v2',
    })
  );
});

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  try {
    await server.shutdown();
    process.exit(0);
  } catch {
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

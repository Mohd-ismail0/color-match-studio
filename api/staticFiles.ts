import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Serves the built single-page app from the same origin as the API, so one
 * container can both take a reference card in the browser and run the
 * correction. Only ever used when COLOR_API_WEB_ROOT points at a build output.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/** Vite fingerprints files under /assets/; everything else must revalidate. */
const IMMUTABLE_PREFIX = '/assets/';

export interface StaticFile {
  filePath: string;
  contentType: string;
  cacheControl: string;
  sizeBytes: number;
}

/**
 * Map a request path to a file inside `webRoot`, or to index.html when the
 * path looks like a client-side route (no file extension). Returns null when
 * nothing should be served (unknown extension, missing file, traversal).
 */
export async function resolveStaticFile(
  webRoot: string,
  requestPath: string,
  spaFallback = true
): Promise<StaticFile | null> {
  const root = path.resolve(webRoot);
  const decoded = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative === '' ? 'index.html' : relative);

  // Never leave the build directory.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;

  const found = await fileInfo(candidate);
  if (found) return found;

  if (!spaFallback) return null;
  if (path.extname(candidate) !== '') return null;
  return fileInfo(path.join(root, 'index.html'));
}

async function fileInfo(filePath: string): Promise<StaticFile | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) return null;
    const webPath = filePath.split(path.sep).join('/');
    return {
      filePath,
      contentType,
      cacheControl: webPath.includes(IMMUTABLE_PREFIX)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      sizeBytes: info.size,
    };
  } catch {
    return null;
  }
}

/**
 * Write the file when it exists. Returns true when the response was handled,
 * false when the caller should continue with its own routing (404 etc.).
 */
export async function serveStaticFile(
  res: ServerResponse,
  webRoot: string,
  requestPath: string,
  method: string,
  spaFallback = true
): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const file = await resolveStaticFile(webRoot, requestPath, spaFallback);
  if (!file) return false;

  res.writeHead(200, {
    'Content-Type': file.contentType,
    'Content-Length': method === 'HEAD' ? '0' : String(file.sizeBytes),
    'Cache-Control': file.cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file.filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { colorApi, type ColorApiServer } from './server';
import { CalibrationStore } from './store';
import { resolveStaticFile } from './staticFiles';

const KEY = 'vitest-web-4f1c9a7e2b8d6c0f3a5e1d9b7c4a2f6e';
const WORD = 'Saffron';
const INTERNAL = 'color-calibration-api';
const PUBLIC_HOST = 'colour.xsama.org';

let dir: string;
let webRoot: string;

/** The build output the container ships: hashed asset + entry document. */
function writeBuild(): void {
  webRoot = path.join(dir, 'web');
  mkdirSync(path.join(webRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>ColorFix</title><div id="root"></div>');
  writeFileSync(path.join(webRoot, 'favicon.ico'), 'ICO');
  writeFileSync(path.join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(webRoot, 'assets', 'index-abc123.css'), 'body{}');
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'color-api-web-'));
  writeBuild();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveStaticFile', () => {
  it('maps the root and extensionless client routes to index.html', async () => {
    const root = await resolveStaticFile(webRoot, '/');
    const route = await resolveStaticFile(webRoot, '/colour-code');
    expect(root?.filePath).toBe(path.join(webRoot, 'index.html'));
    expect(route?.filePath).toBe(path.join(webRoot, 'index.html'));
    expect(route?.contentType).toBe('text/html; charset=utf-8');
    expect(route?.cacheControl).toBe('no-cache');
  });

  it('marks fingerprinted assets immutable and revalidates everything else', async () => {
    const js = await resolveStaticFile(webRoot, '/assets/index-abc123.js');
    const icon = await resolveStaticFile(webRoot, '/favicon.ico');
    expect(js?.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(js?.contentType).toBe('text/javascript; charset=utf-8');
    expect(icon?.cacheControl).toBe('no-cache');
  });

  it('returns null for a missing file with an extension, so the API can answer', async () => {
    expect(await resolveStaticFile(webRoot, '/assets/gone-xyz.js')).toBeNull();
  });

  it('refuses to leave the build directory', async () => {
    const outside = await resolveStaticFile(webRoot, '/../../etc/passwd');
    expect(outside).toBeNull();
    // Normalised by path.resolve: must still land inside webRoot if it exists.
    const escaped = await resolveStaticFile(webRoot, '/%2e%2e/%2e%2e/etc/hosts');
    expect(escaped).toBeNull();
  });
});

interface RawResponse {
  status: number;
  body: string;
  contentType: string;
  cacheControl: string;
}

/** fetch() cannot set Host per-request; the gate keys on it, so use http. */
function raw(port: number, method: string, p: string, host: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { Host: host, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: String(res.headers['content-type'] ?? ''),
            cacheControl: String(res.headers['cache-control'] ?? ''),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('single-origin deployment (webRoot + managementHosts)', () => {
  let server: ColorApiServer;
  let port: number;

  beforeAll(async () => {
    server = colorApi(KEY, {
      store: new CalibrationStore(path.join(dir, 'split.sqlite')),
      publicPassphrase: WORD,
      webRoot: path.join(webRoot),
      managementHosts: [INTERNAL, '127.0.0.1'],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    port = address.port;
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it('serves the browser tool on the public hostname', async () => {
    const res = await raw(port, 'GET', '/colour-code', PUBLIC_HOST);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
    expect(res.body).toContain('id="root"');
  });

  it('does not let the public hostname reach stored calibrations', async () => {
    const auth = { Authorization: `Bearer ${KEY}` };
    const list = await raw(port, 'GET', '/v1/calibrations', PUBLIC_HOST, auth);
    const correct = await raw(port, 'POST', '/v1/correct', PUBLIC_HOST, auth);
    // 404 rather than 401: the admin surface is absent, not merely locked.
    expect(list.status).toBe(404);
    expect(correct.status).toBe(404);
    expect(JSON.parse(list.body).error.code).toBe('NOT_FOUND');
  });

  it('keeps the management routes answering on the internal host', async () => {
    const unauthed = await raw(port, 'GET', '/v1/calibrations', INTERNAL);
    const keyed = await raw(port, 'GET', '/v1/calibrations', INTERNAL, {
      Authorization: `Bearer ${KEY}`,
    });
    expect(unauthed.status).toBe(401);
    expect(keyed.status).toBe(200);
  });

  it('still serves the stateless public routes to the browser origin', async () => {
    const preset = await raw(port, 'POST', '/v1/public/preset', PUBLIC_HOST, {
      'Content-Type': 'application/json',
    });
    // Body is intentionally absent here; we only assert the route exists.
    expect([400, 413, 415]).toContain(preset.status);
    expect(preset.status).not.toBe(404);
  });

  it('leaves health answering on any host for the platform monitor', async () => {
    expect((await raw(port, 'GET', '/health', PUBLIC_HOST)).status).toBe(200);
  });

  it('answers JSON 404 for unknown API routes and static 200 for real assets', async () => {
    const api404 = await raw(port, 'GET', '/v1/public/nope', PUBLIC_HOST);
    expect(api404.status).toBe(404);
    const asset = await raw(port, 'GET', '/assets/index-abc123.js', PUBLIC_HOST);
    expect(asset.status).toBe(200);
    expect(asset.cacheControl).toContain('immutable');
    const head = await raw(port, 'HEAD', '/favicon.ico', PUBLIC_HOST);
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('reports the SPA as unknown route when no build is configured', async () => {
    const bare = colorApi(KEY, { store: new CalibrationStore(path.join(dir, 'bare.sqlite')) });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const address = bare.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const res = await raw(address.port, 'GET', '/colour-code', PUBLIC_HOST);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND');
    await bare.shutdown();
  });
});

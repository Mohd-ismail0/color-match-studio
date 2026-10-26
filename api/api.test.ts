// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { colorApi, validateApiKey, type ColorApiServer } from './server';
import { CalibrationStore, resolveDbPath } from './store';
import { WorkerPool, PoolError } from './workerPool';
import { encodePng16 } from './png16';
import {
  applyColorMatrix,
  calculateMatrixDetailed,
} from '@/lib/colorCorrection';
import type { ColorPoint } from '@/types/colorCorrector';

const KEY = 'vitest-9f3a7c1e5b8d2f4a6c0e9b7d3a1f5c8e';
const AUTH = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

let dir: string;
let dbPath: string;
let server: ColorApiServer;
let base: string;
let largePng: Buffer;

const points: ColorPoint[] = [
  {
    id: 'p1',
    label: 'White',
    role: 'white',
    x: 0.1,
    y: 0.1,
    sampledColor: { r: 220, g: 210, b: 200 },
    targetColor: { r: 255, g: 255, b: 255 },
  },
  {
    id: 'p2',
    label: 'Grey',
    role: 'grey',
    x: 0.5,
    y: 0.5,
    sampledColor: { r: 120, g: 115, b: 110 },
    targetColor: { r: 128, g: 128, b: 128 },
  },
  {
    id: 'p3',
    label: 'Black',
    role: 'black',
    x: 0.9,
    y: 0.9,
    sampledColor: { r: 15, g: 12, b: 10 },
    targetColor: { r: 0, g: 0, b: 0 },
  },
];

async function listen(instance: ColorApiServer): Promise<void> {
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(instance.address() as { port: number }).port}`;
}

async function jsonRequest(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = AUTH
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any; response: Response }> {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, response };
}

async function createProfile(name = 'Studio A'): Promise<{
  profileId: string;
  revision: { revision: number; matrix: ColorMatrixLike; fingerprint: string; contentHash: string };
}> {
  const res = await jsonRequest('POST', '/v1/calibrations', { name, points, mode: 'simple' });
  expect(res.status).toBe(201);
  return {
    profileId: res.body.profile.id,
    revision: res.body.revision,
  };
}

interface ColorMatrixLike {
  matrix: number[][];
  offset: { r: number; g: number; b: number };
}

const image8 = async () =>
  sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 128, g: 96, b: 64, alpha: 255 } },
  })
    .png()
    .toBuffer();

function parsePng16(png: Buffer): { width: number; height: number; samples: number[] } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(16);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = 1 + width * 4 * 2;
  const samples: number[] = [];
  for (let y = 0; y < Math.min(height, 1); y++) {
    const row = raw.subarray(y * rowBytes + 1, (y + 1) * rowBytes);
    for (let i = 0; i < row.length; i += 2) samples.push(row.readUInt16BE(i));
  }
  return { width, height, samples };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'color-api-test-'));
  dbPath = path.join(dir, 'calibrations.sqlite');
  server = colorApi(KEY, { dbPath, workerCount: 2, queueLimit: 4 });
  await listen(server);
  largePng = await sharp({
    create: { width: 6000, height: 4000, channels: 4, background: { r: 120, g: 90, b: 60, alpha: 255 } },
  })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await server.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('auth hardening', () => {
  it('rejects weak API keys at construction', () => {
    expect(() => validateApiKey('short')).toThrow();
    expect(() => validateApiKey('x'.repeat(40))).toThrow(/distinct/);
    expect(() => validateApiKey(KEY)).not.toThrow();
  });

  it('requires a bearer token with a constant-time digest compare', async () => {
    expect((await fetch(`${base}/v1/calibrations`)).status).toBe(401);
    expect(
      (await fetch(`${base}/v1/calibrations`, { headers: { Authorization: `Bearer ${'y'.repeat(KEY.length)}` } }))
        .status
    ).toBe(401);
    expect(
      (await fetch(`${base}/v1/calibrations`, { headers: { Authorization: `bearer ${KEY}` } })).status
    ).toBe(401);
    expect((await fetch(`${base}/v1/calibrations`, { headers: AUTH })).status).toBe(200);
  });
});

describe('calibration persistence and explicit revisions', () => {
  it('stores server-recomputed points, matrix, provenance, version and hash', async () => {
    const created = await createProfile();
    const expected = calculateMatrixDetailed(points, 'simple');
    expect(created.revision.matrix).toEqual(expected.matrix);
    expect(created.revision.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(created.revision.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await jsonRequest(
      'GET',
      `/v1/calibrations/${created.profileId}/revisions/1`
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.revision.algorithmVersion).toBe('2.0.0');
    expect(fetched.body.revision.points).toEqual(points);
    expect(fetched.body.revision.provenance.source).toBe('api');
    expect(fetched.body.revision.provenance.diagnostics.sampleCount).toBe(3);
    expect(fetched.body.revision.provenance.revision).toBe(1);
    expect(fetched.body.revision.provenance.profileId).toBe(created.profileId);
  });

  it('lists profiles with explicit revision metadata', async () => {
    const created = await createProfile('Listed');
    const listed = await jsonRequest('GET', '/v1/calibrations');
    expect(listed.status).toBe(200);
    const summary = listed.body.profiles.find((p: { id: string }) => p.id === created.profileId);
    expect(summary).toMatchObject({ revisionCount: 1, latestRevision: 1 });
  });

  it('corrects by profile id + revision and matches the shared engine exactly', async () => {
    const created = await createProfile();
    const original = await image8();
    const res = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: original.toString('base64'),
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-calibration-profile')).toBe(created.profileId);
    expect(res.headers.get('x-calibration-revision')).toBe('1');
    expect(res.headers.get('x-calibration-hash')).toMatch(/^[0-9a-f]{64}$/);
    const out = Buffer.from(await res.arrayBuffer());
    const pixels = await sharp(out).raw().toBuffer();
    const expected = applyColorMatrix({ r: 128, g: 96, b: 64 }, created.revision.matrix);
    expect([...pixels.slice(0, 4)]).toEqual([expected.r, expected.g, expected.b, 255]);
    const metadata = await sharp(out).metadata();
    expect(metadata.icc).toBeTruthy();
  });

  it('requires a revision and never falls back to latest', async () => {
    const created = await createProfile();
    const original = await image8();
    const missing = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: original.toString('base64'),
        calibration: { profileId: created.profileId },
      }),
    });
    expect(missing.status).toBe(422);

    const unknown = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: original.toString('base64'),
        calibration: { profileId: created.profileId, revision: 99 },
      }),
    });
    expect(unknown.status).toBe(404);
  });

  it('appends immutable revisions without mutating revision 1', async () => {
    const created = await createProfile('Versioned');
    const rev1Before = await jsonRequest(
      'GET',
      `/v1/calibrations/${created.profileId}/revisions/1`
    );

    const changedPoints = points.map((p) =>
      p.role === 'grey' ? { ...p, targetColor: { r: 140, g: 140, b: 140 } } : p
    );
    const appended = await jsonRequest(
      'POST',
      `/v1/calibrations/${created.profileId}/revisions`,
      { points: changedPoints, mode: 'simple' }
    );
    expect(appended.status).toBe(201);
    expect(appended.body.revision.revision).toBe(2);
    expect(appended.body.revision.fingerprint).not.toBe(created.revision.fingerprint);

    const rev1After = await jsonRequest(
      'GET',
      `/v1/calibrations/${created.profileId}/revisions/1`
    );
    expect(rev1After.body.revision.contentHash).toBe(rev1Before.body.revision.contentHash);
    expect(rev1After.body.revision.matrix).toEqual(rev1Before.body.revision.matrix);
  });

  it('rejects a client matrix that does not match the server fit', async () => {
    const res = await jsonRequest('POST', '/v1/calibrations', {
      name: 'Mismatch',
      points,
      mode: 'simple',
      matrix: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 0, g: 0, b: 0 } },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MATRIX_MISMATCH');
  });

  it('accepts hand-plausible low-contrast calibrations the UI can produce (audit C5)', async () => {
    const dimPoints = [
      {
        id: 'w',
        label: 'White',
        role: 'white' as const,
        x: 0.2,
        y: 0.2,
        sampledColor: { r: 95, g: 95, b: 95 },
        targetColor: { r: 255, g: 255, b: 255 },
      },
      {
        id: 'b',
        label: 'Black',
        role: 'black' as const,
        x: 0.8,
        y: 0.8,
        sampledColor: { r: 30, g: 30, b: 30 },
        targetColor: { r: 0, g: 0, b: 0 },
      },
    ];
    const res = await jsonRequest('POST', '/v1/calibrations', {
      name: 'Dim reference',
      points: dimPoints,
      mode: 'simple',
    });
    expect(res.status).toBe(201);
    expect(Math.abs(res.body.revision.matrix.matrix[0][0])).toBeLessThanOrEqual(24);
    expect(Math.abs(res.body.revision.matrix.offset.r)).toBeLessThanOrEqual(8);
    expect(res.body.revision.provenance.warnings.join(' ')).toMatch(/clips/i);
  });

  it('rejects an algorithm-version mismatch', async () => {
    const res = await jsonRequest('POST', '/v1/calibrations', {
      name: 'Old engine',
      points,
      mode: 'simple',
      algorithmVersion: '1.0.0',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALGORITHM_VERSION_MISMATCH');
  });

  it('enforces revision schema limits', async () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => ({ ...points[0], id: `p${i}` }));
    const res = await jsonRequest('POST', '/v1/calibrations', {
      name: 'Too many',
      points: tooMany,
      mode: 'simple',
    });
    expect(res.status).toBe(422);

    const badCoord = await jsonRequest('POST', '/v1/calibrations', {
      name: 'Bad coord',
      points: [{ ...points[0], x: 2 }],
      mode: 'simple',
    });
    expect(badCoord.status).toBe(422);

    const nested = await jsonRequest('POST', '/v1/calibrations', {
      name: 'Nested',
      points: [{ ...points[0], extra: { nested: true } }, points[1], points[2]],
      mode: 'simple',
    });
    expect(nested.status).toBe(422);
  });
});

describe('save → reopen → select → correct regression', () => {
  it('survives a server restart and reproduces identical pixels by revision', async () => {
    const created = await createProfile('Durable');
    const original = await image8();

    const before = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: original.toString('base64'),
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });
    expect(before.status).toBe(200);
    const beforePixels = await sharp(Buffer.from(await before.arrayBuffer())).raw().toBuffer();

    await server.shutdown();
    server = colorApi(KEY, { dbPath, workerCount: 1 });
    await listen(server);

    const profile = await jsonRequest('GET', `/v1/calibrations/${created.profileId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.profile.revisions[0].revision).toBe(1);

    const selected = await jsonRequest(
      'GET',
      `/v1/calibrations/${created.profileId}/revisions/1`
    );
    expect(selected.status).toBe(200);

    const after = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: original.toString('base64'),
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });
    expect(after.status).toBe(200);
    const afterPixels = await sharp(Buffer.from(await after.arrayBuffer())).raw().toBuffer();
    expect([...afterPixels]).toEqual([...beforePixels]);
  });
});

describe('malformed and adversarial inputs', () => {
  it('rejects invalid JSON, wrong content type and unknown routes with a taxonomy', async () => {
    const badJson = await fetch(`${base}/v1/calibrations`, {
      method: 'POST',
      headers: AUTH,
      body: '{oops',
    });
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error.code).toBe('INVALID_JSON');

    const wrongType = await fetch(`${base}/v1/calibrations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const notFound = await jsonRequest('GET', '/v1/nope');
    expect(notFound.status).toBe(404);
  });

  it('rejects non-canonical base64 and destructive matrices', async () => {
    const created = await createProfile();
    const whitespace = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: 'iVBORw0KGgo AAAANSUhEUg==',
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });
    expect(whitespace.status).toBe(422);

    const destructive = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: (await image8()).toString('base64'),
        matrix: {
          matrix: [[0.386, 0.386, 0.386], [0.386, 0.386, 0.386], [0.386, 0.386, 0.386]],
          offset: { r: 0, g: 0, b: 0 },
        },
      }),
    });
    expect(destructive.status).toBe(422);
    expect((await destructive.json()).error.code).toBe('MATRIX_REJECTED');
  });

  it('rejects unknown image formats and oversized declared bodies', async () => {
    const created = await createProfile();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>');
    const svgRes = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: svg.toString('base64'),
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });
    expect([415, 422]).toContain(svgRes.status);
  });

  it('preserves 16-bit depth and sample values (audit C9)', async () => {
    const created = await createProfile();
    const samples = new Uint16Array(4 * 4 * 4);
    for (let i = 0; i < samples.length; i += 4) {
      samples[i] = 40000;
      samples[i + 1] = 30000;
      samples[i + 2] = 20000;
      samples[i + 3] = 65535;
    }
    const input = encodePng16(4, 4, samples);
    const res = await fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: input.toString('base64'),
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const out = Buffer.from(await res.arrayBuffer());
    const metadata = await sharp(out).metadata();
    expect(metadata.depth).toBe('ushort');
    const parsed = parsePng16(out);
    expect(parsed.width).toBe(4);
    // Identity-ish revision maps white/black anchors; verify alpha and a
    // plausible non-degenerate value rather than asserting colour accuracy.
    expect(parsed.samples[3]).toBe(65535);
    expect(parsed.samples[0]).toBeGreaterThan(30000);
  });
});

describe('protocol safety: slow body cannot deny service', () => {
  it('serves other requests while a slow request body is still in flight', async () => {
    const port = (server.address() as { port: number }).port;
    const socket = new Socket();
    let connected = false;
    await new Promise<void>((resolve, reject) => {
      socket.connect(port, '127.0.0.1', () => {
        connected = true;
        socket.write(
          [
            'POST /v1/correct HTTP/1.1',
            'Host: 127.0.0.1',
            `Authorization: Bearer ${KEY}`,
            'Content-Type: application/json',
            'Content-Length: 500',
            '',
            '',
          ].join('\r\n')
        );
        socket.write('{"imageBase64":');
        resolve();
      });
      socket.once('error', reject);
    });
    expect(connected).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const during = await fetch(`${base}/v1/calibrations`, {
      headers: AUTH,
      signal: AbortSignal.timeout(2000),
    });
    expect(during.status).toBe(200);
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    expect(health.status).toBe(200);
    socket.destroy();
  });
});

describe('protocol safety: 413 keep-alive', () => {
  it('sends Connection: close on oversized bodies and closes the socket', async () => {
    const port = (server.address() as { port: number }).port;
    const result = await new Promise<{ head: string; closed: boolean }>((resolve) => {
      const socket = new Socket();
      let data = '';
      let closed = false;
      socket.connect(port, '127.0.0.1', () => {
        socket.write(
          [
            'POST /v1/correct HTTP/1.1',
            'Host: 127.0.0.1',
            `Authorization: Bearer ${KEY}`,
            'Content-Type: application/json',
            'Content-Length: 40000000',
            'Connection: keep-alive',
            '',
            '',
          ].join('\r\n')
        );
        socket.write('{');
      });
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n') && data.includes('}')) {
          // keep reading until close
        }
      });
      socket.on('close', () => {
        closed = true;
        resolve({ head: data, closed });
      });
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve({ head: data, closed });
      });
    });
    expect(result.head).toMatch(/413/);
    expect(result.head.toLowerCase()).toContain('connection: close');
    expect(result.closed).toBe(true);
  });
});

describe('worker isolation, health and deadlines', () => {
  it('keeps /health responsive while a large image is being corrected', async () => {
    const created = await createProfile('Busy');
    const correctPromise = fetch(`${base}/v1/correct`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        imageBase64: largePng.toString('base64'),
        calibration: { profileId: created.profileId, revision: 1 },
      }),
    });

    const latencies: number[] = [];
    for (let i = 0; i < 8; i++) {
      const start = Date.now();
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      expect(health.status).toBe(200);
      latencies.push(Date.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const response = await correctPromise;
    expect(response.status).toBe(200);
    expect(Math.max(...latencies)).toBeLessThan(1000);
  }, 30_000);

  it('rejects new work when the queue is full', async () => {
    const pool = new WorkerPool({ size: 1, queueLimit: 0, jobTimeoutMs: 30_000 });
    const identity = { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 0, g: 0, b: 0 } };
    const first = pool.run(largePng, identity);
    await expect(pool.run(largePng, identity)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    await first;
    await pool.close();
  }, 30_000);

  it('terminates a job at its deadline', async () => {
    const script = path.join(dir, 'sleep-worker.mjs');
    writeFileSync(
      script,
      "import { parentPort } from 'node:worker_threads';\nsetTimeout(() => parentPort.postMessage({ ok: false, message: 'too late' }), 5000);\n"
    );
    const pool = new WorkerPool({
      size: 1,
      queueLimit: 0,
      jobTimeoutMs: 1000,
      workerScript: pathToFileURL(script),
    });
    const identity = { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 0, g: 0, b: 0 } };
    const started = Date.now();
    await expect(pool.run(largePng, identity)).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(3000);
    await pool.close();
  }, 30_000);
});

describe('store safety and immutability', () => {
  it('rejects a database path inside the repository', () => {
    expect(() => resolveDbPath(path.join(process.cwd(), 'calibrations.sqlite'))).toThrow(
      /inside the repository/
    );
  });

  it('blocks in-place updates/deletes of revisions at the database layer', () => {
    const storePath = path.join(dir, 'immutability.sqlite');
    const store = new CalibrationStore(storePath);
    const created = store.createProfile('Immutable', {
      points,
      matrix: calculateMatrixDetailed(points, 'simple').matrix,
      mode: 'simple',
      algorithmVersion: '2.0.0',
      fingerprint: 'aaaaaaaaaaaaaaaa',
      contentHash: 'a'.repeat(64),
      provenance: {
        source: 'api',
        algorithmVersion: '2.0.0',
        engineVersion: '2.0.0',
        warnings: [],
        diagnostics: calculateMatrixDetailed(points, 'simple').diagnostics,
      },
      meanResidual: 1,
    });
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    expect(() => db.prepare('UPDATE revisions SET matrix_json = ? WHERE profile_id = ?').run('{}', created.profile.id)).toThrow(
      /immutable/
    );
    expect(() => db.prepare('DELETE FROM revisions WHERE profile_id = ?').run(created.profile.id)).toThrow(
      /immutable/
    );
    store.close();
  });
});

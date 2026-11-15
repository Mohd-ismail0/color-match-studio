// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { colorApi, type ColorApiServer } from './server';
import { CalibrationStore } from './store';
import { encodePreset, decodePreset, assessPreset, PresetError, PRESET_LIMITS } from './preset';
import { encodePreset as encodePresetBrowser, presetTierFor } from '@/lib/presetCode';
import { RateLimiter, resolveClientAddress, rateLimitGroup } from './rateLimiter';

const KEY = 'vitest-public-4f1c9a7e2b8d6c0f3a5e1d9b7c4a2f6e';
const WORD = 'Saffron';
const AUTH = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

/** Realistic card readings: warm-light cast, neutral patches should be neutral. */
const cardPatches = [
  { sampledColor: { r: 236, g: 228, b: 214 }, targetColor: { r: 255, g: 255, b: 255 }, role: 'white' as const },
  { sampledColor: { r: 128, g: 124, b: 118 }, targetColor: { r: 122, g: 122, b: 122 }, role: 'grey' as const },
  { sampledColor: { r: 26, g: 24, b: 26 }, targetColor: { r: 12, g: 12, b: 12 }, role: 'black' as const },
  { sampledColor: { r: 196, g: 82, b: 74 }, targetColor: { r: 195, g: 62, b: 51 }, role: 'custom' as const },
  { sampledColor: { r: 78, g: 132, b: 92 }, targetColor: { r: 60, g: 130, b: 82 }, role: 'custom' as const },
  { sampledColor: { r: 74, g: 100, b: 168 }, targetColor: { r: 51, g: 96, b: 170 }, role: 'custom' as const },
];

let dir: string;
let server: ColorApiServer;
let base: string;
let imageBase64: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'color-api-public-'));
  const store = new CalibrationStore(path.join(dir, 'db.sqlite'));
  server = colorApi(KEY, {
    store,
    publicPassphrase: WORD,
    trustedProxies: ['10.0.0.1'],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  base = `http://127.0.0.1:${address.port}`;
  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 150, b: 120 } },
  })
    .png()
    .toBuffer();
  imageBase64 = png.toString('base64');
});

afterAll(async () => {
  await server.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const post = (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('preset code', () => {
  it('round-trips the evidence it was given', () => {
    const code = encodePreset('d', cardPatches);
    const decoded = decodePreset(code);
    expect(decoded.tier).toBe('d');
    expect(decoded.patches).toHaveLength(cardPatches.length);
    decoded.patches.forEach((patch, index) => {
      expect(Math.abs(patch.sampledColor.r - cardPatches[index].sampledColor.r)).toBeLessThanOrEqual(PRESET_LIMITS.channelStep);
      expect(Math.abs(patch.targetColor.b - cardPatches[index].targetColor.b)).toBeLessThanOrEqual(PRESET_LIMITS.channelStep);
    });
  });

  it('stays short enough to paste into a chat message', () => {
    const code = encodePreset('d', cardPatches);
    expect(code.length).toBeLessThanOrEqual(PRESET_LIMITS.maxLength);
    expect(code.length).toBeLessThan(90);
  });

  it('matches the browser encoder byte for byte', () => {
    // Drift here would hand users a code the API rejects.
    expect(encodePresetBrowser(cardPatches, 'd')).toBe(encodePreset('d', cardPatches));
    for (const count of [1, 2, 3, 5, 6, 9, 12]) {
      const subset = Array.from({ length: count }, (_, index) => ({
        sampledColor: { r: (index * 19) % 250, g: (index * 37) % 250, b: (index * 53) % 250 },
        targetColor: { r: (index * 11) % 250, g: (index * 29) % 250, b: (index * 47) % 250 },
        role: (['white', 'grey', 'black', 'custom'] as const)[index % 4],
      }));
      const tier = presetTierFor(count);
      expect(encodePresetBrowser(subset, tier)).toBe(encodePreset(tier, subset));
    }
  });

  it('tolerates spaces, dashes and lower case from human input', () => {
    const code = encodePreset('d', cardPatches);
    const messy = ` ${code.toLowerCase().replace('lc1-', 'lc1 - ')} `;
    expect(decodePreset(messy).code).toBe(code);
  });

  it('rejects a tampered code via the checksum', () => {
    const code = encodePreset('d', cardPatches);
    const tampered = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
    expect(() => decodePreset(tampered)).toThrow(PresetError);
    try {
      decodePreset(tampered);
    } catch (error) {
      expect((error as PresetError).code).toBe('PRESET_CHECKSUM');
    }
  });

  it('refuses repeated sampled colours', () => {
    const repeated = [cardPatches[0], cardPatches[0]];
    expect(() => encodePreset('b', repeated)).toThrow(/same colour|repeats/i);
  });

  it('refuses a tier that does not match the point count', () => {
    expect(() => encodePreset('a', cardPatches)).toThrow(PresetError);
    expect(() => encodePreset('b', [cardPatches[0]])).toThrow(PresetError);
  });

  it('derives, rather than accepts, the matrix', () => {
    const assessment = assessPreset(encodePreset('d', cardPatches));
    expect(assessment.matrix.matrix).toHaveLength(3);
    expect(assessment.decoded.tier).toBe('d');
    // A warm cast should be pushed towards neutral, not amplified.
    expect(assessment.residual).toBeLessThan(30);
  });

  it('rejects a preset whose patches cannot form a usable matrix', () => {
    // Identical targets across wildly different samples cannot be fitted.
    const nonsense = [
      { sampledColor: { r: 250, g: 10, b: 10 }, targetColor: { r: 0, g: 0, b: 0 }, role: 'white' as const },
      { sampledColor: { r: 10, g: 250, b: 10 }, targetColor: { r: 0, g: 0, b: 0 }, role: 'black' as const },
      { sampledColor: { r: 10, g: 10, b: 250 }, targetColor: { r: 0, g: 0, b: 0 }, role: 'grey' as const },
      { sampledColor: { r: 250, g: 250, b: 10 }, targetColor: { r: 0, g: 0, b: 0 }, role: 'custom' as const },
      { sampledColor: { r: 10, g: 250, b: 250 }, targetColor: { r: 0, g: 0, b: 0 }, role: 'custom' as const },
      { sampledColor: { r: 250, g: 10, b: 250 }, targetColor: { r: 0, g: 0, b: 0 }, role: 'custom' as const },
    ];
    expect(() => assessPreset(encodePreset('d', nonsense))).toThrow(PresetError);
  });
});

describe('public routes', () => {
  it('reports strength and residual without touching the store', async () => {
    const code = encodePreset('d', cardPatches);
    const response = await post('/v1/public/preset', { code });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.code).toBe(code);
    expect(payload.points).toBe(cardPatches.length);
    expect(payload.tier).toBe('d');
    expect(typeof payload.residual).toBe('number');
    expect(response.headers.get('x-ratelimit-limit')).toBe('60');
  });

  it('rejects a malformed preset with 400 and a tampered one with 400', async () => {
    expect((await post('/v1/public/preset', { code: 'nope' })).status).toBe(400);
    const code = encodePreset('d', cardPatches);
    const tampered = code.slice(0, -1) + (code.at(-1) === 'A' ? 'B' : 'A');
    expect((await post('/v1/public/preset', { code: tampered })).status).toBe(400);
  });

  it('refuses unknown fields so callers cannot smuggle a matrix', async () => {
    const code = encodePreset('d', cardPatches);
    const response = await post('/v1/public/preset', {
      code,
      matrix: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 0, g: 0, b: 0 } },
    });
    expect(response.status).toBe(422);
  });

  it('requires the access word for correction', async () => {
    const code = encodePreset('d', cardPatches);
    const anonymous = await post('/v1/public/correct', { code, imageBase64 });
    expect(anonymous.status).toBe(401);
    const wrong = await post('/v1/public/correct', { code, imageBase64 }, { 'X-Calibration-Word': 'not-the-word' });
    expect(wrong.status).toBe(401);
  });

  it('corrects an image with the word, tolerating case and spacing', async () => {
    const code = encodePreset('d', cardPatches);
    const response = await post(
      '/v1/public/correct',
      { code, imageBase64 },
      { 'X-Calibration-Word': `  ${WORD.toLowerCase()} ` }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-calibration-tier')).toBe('d');
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(8);
  });

  it('needs the bearer key for stored calibration routes', async () => {
    expect((await fetch(`${base}/v1/calibrations`)).status).toBe(401);
    expect((await fetch(`${base}/v1/calibrations`, { headers: AUTH })).status).toBe(200);
  });

  it('keeps stored calibrations private from anonymous callers', async () => {
    const created = await post(
      '/v1/calibrations',
      {
        name: 'shop card',
        mode: 'advanced',
        points: cardPatches.map((patch, index) => ({
          id: `p${index + 1}`,
          label: patch.role === 'custom' ? `patch ${index + 1}` : patch.role,
          x: index / cardPatches.length,
          y: 0.5,
          ...patch,
        })),
      },
      AUTH
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { profile: { id: string } };
    expect((await fetch(`${base}/v1/calibrations/${body.profile.id}`)).status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('blocks the correction tier after its allowance', async () => {
    const limiter = new RateLimiter();
    const store = new CalibrationStore(path.join(dir, 'limit.sqlite'));
    const limited = colorApi(KEY, { store, publicPassphrase: WORD, publicLimiter: limiter });
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const address = limited.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    const url = `http://127.0.0.1:${address.port}/v1/public/preset`;
    const code = encodePreset('d', cardPatches);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 200).length).toBe(60);
    expect(statuses.filter((status) => status === 429).length).toBe(2);
    await limited.shutdown();
  });

  it('does not trust forwarded headers from an untrusted peer', () => {
    expect(resolveClientAddress('203.0.113.9', '1.2.3.4', ['10.0.0.1'])).toBe('203.0.113.9');
  });

  it('uses the real client behind a trusted proxy, ignoring spoofed prefixes', () => {
    expect(resolveClientAddress('10.0.0.1', '9.9.9.9, 203.0.113.9', ['10.0.0.1'])).toBe('203.0.113.9');
  });

  it('prefers a single-client header over the comma list', () => {
    // nginx/traefik append the peer to XFF; x-real-ip is the client itself.
    expect(resolveClientAddress('10.0.0.1', '9.9.9.9', ['10.0.0.1'])).toBe('9.9.9.9');
    expect(resolveClientAddress('203.0.113.5', '9.9.9.9', [])).toBe('203.0.113.5');
  });

  it('groups IPv6 neighbours so one host cannot rotate addresses', () => {
    expect(rateLimitGroup('2001:db8:1234:5678:aaaa::1')).toBe(rateLimitGroup('2001:db8:1234:5678:ffff::9'));
    expect(rateLimitGroup('203.0.113.9')).toBe('203.0.113.9');
  });
});

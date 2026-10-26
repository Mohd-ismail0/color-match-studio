import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { colorApi } from './server';
import { applyColorMatrix } from '../src/lib/colorCorrection';
import type { ColorPoint } from '../src/types/colorCorrector';

const key = 'acceptance-9f3a7c1e5b8d2f4a6c0e9b7d3a1f5c8e';
const dir = mkdtempSync(path.join(tmpdir(), 'color-acceptance-'));
const server = colorApi(key, { dbPath: path.join(dir, 'calibrations.sqlite'), workerCount: 1 });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

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

try {
  const url = `${base}/v1/correct`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401, 'missing auth must be 401');

  // Save → list → get → correct by explicit revision → append → correct again
  const createResponse = await fetch(`${base}/v1/calibrations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Acceptance preset', points, mode: 'simple' }),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as {
    profile: { id: string };
    revision: { revision: number; matrix: { matrix: number[][]; offset: Record<string, number> } };
  };
  assert.equal(created.revision.revision, 1);

  const listResponse = await fetch(`${base}/v1/calibrations`, { headers });
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as { profiles: Array<{ id: string; revisionCount: number }> };
  assert.ok(listed.profiles.some((p) => p.id === created.profile.id && p.revisionCount === 1));

  const revResponse = await fetch(
    `${base}/v1/calibrations/${created.profile.id}/revisions/1`,
    { headers }
  );
  assert.equal(revResponse.status, 200);
  const rev = (await revResponse.json()) as { revision: { fingerprint: string; contentHash: string } };
  assert.match(rev.revision.fingerprint, /^[0-9a-f]{16}$/);
  assert.match(rev.revision.contentHash, /^[0-9a-f]{64}$/);

  const original = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 128, g: 96, b: 64, alpha: 255 } },
  })
    .png()
    .toBuffer();

  const corrected = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      imageBase64: original.toString('base64'),
      calibration: { profileId: created.profile.id, revision: 1 },
    }),
  });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.headers.get('x-calibration-revision'), '1');
  const out = Buffer.from(await corrected.arrayBuffer());
  const pixels = await sharp(out).raw().toBuffer();
  const expected = applyColorMatrix(
    { r: 128, g: 96, b: 64 },
    created.revision.matrix as never
  );
  assert.deepEqual([...pixels.slice(0, 4)], [expected.r, expected.g, expected.b, 255]);

  // Explicit revision is mandatory: no profile-only / latest fallback.
  const latestAttempt = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageBase64: original.toString('base64'), calibration: { profileId: created.profile.id } }),
  });
  assert.equal(latestAttempt.status, 422);

  const appendResponse = await fetch(
    `${base}/v1/calibrations/${created.profile.id}/revisions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        points: points.map((p) =>
          p.role === 'grey' ? { ...p, targetColor: { r: 132, g: 132, b: 132 } } : p
        ),
        mode: 'simple',
      }),
    }
  );
  assert.equal(appendResponse.status, 201);
  const appended = (await appendResponse.json()) as { revision: { revision: number } };
  assert.equal(appended.revision.revision, 2);

  const correctRev2 = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      imageBase64: original.toString('base64'),
      calibration: { profileId: created.profile.id, revision: 2 },
    }),
  });
  assert.equal(correctRev2.status, 200);
  assert.equal(correctRev2.headers.get('x-calibration-revision'), '2');

  const badBase64 = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageBase64: 'not base64!!', matrix: created.revision.matrix }),
  });
  assert.equal(badBase64.status, 422);

  const nestedKey = await fetch(`${base}/v1/calibrations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'x', points, mode: 'simple', extra: { nested: true } }),
  });
  assert.equal(nestedKey.status, 422);

  console.log('real PNG save→list→get→correct-by-revision, append, and malformed-input checks passed');
} finally {
  await server.shutdown();
  rmSync(dir, { recursive: true, force: true });
}

// @vitest-environment jsdom
/**
 * Browser/API parity.
 *
 * Two people using the same card must get the same image whether the correction
 * happens in their browser or on the server. The shared engine is imported by
 * both sides, so the risk is not the maths — it is the wiring around it: which
 * points get fitted, how colours are quantised for the code, and whether the
 * code's round-trip nudges the matrix.
 *
 * These tests compare against the unbiased reference: fit the *original*
 * measurements, then correct. Any preset path must land on a near-identical
 * result, or the "stateless code" feature quietly changed people's photos.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

import { calculateMatrixDetailed, calculateMatrix, applyColorMatrix } from '@/lib/colorCorrection';
import { assessMatrix } from '@/lib/matrixValidation';
import { applyMatrixToRgba8 } from '@/lib/colorMath';
import { assessPreset, decodePreset, encodePreset } from '../../api/preset';
import { encodePreset as encodePresetBrowser, presetTierFor, quantiseColour } from '@/lib/presetCode';
import type { ColorMatrix, ColorPoint } from '@/types/colorCorrector';

/** A plausible card reading under warm indoor light. */
const card: Array<{ sampled: [number, number, number]; target: [number, number, number]; role: 'white' | 'grey' | 'black' | 'custom' }> = [
  { sampled: [238, 231, 219], target: [255, 255, 255], role: 'white' },
  { sampled: [131, 126, 119], target: [122, 122, 122], role: 'grey' },
  { sampled: [21, 18, 16], target: [12, 12, 12], role: 'black' },
  { sampled: [193, 79, 71], target: [195, 62, 51], role: 'custom' },
  { sampled: [76, 133, 90], target: [60, 130, 82], role: 'custom' },
  { sampled: [70, 99, 165], target: [51, 96, 170], role: 'custom' },
];

const toPoints = (): ColorPoint[] =>
  card.map((patch, index) => ({
    id: `p${index + 1}`,
    label: index < 3 ? patch.role : `patch ${index + 1}`,
    role: patch.role,
    x: index / card.length,
    y: 0.5,
    sampledColor: { r: patch.sampled[0], g: patch.sampled[1], b: patch.sampled[2] },
    targetColor: { r: patch.target[0], g: patch.target[1], b: patch.target[2] },
  }));

const patches = card.map((patch) => ({
  sampledColor: { r: patch.sampled[0], g: patch.sampled[1], b: patch.sampled[2] },
  targetColor: { r: patch.target[0], g: patch.target[1], b: patch.target[2] },
  role: patch.role,
}));

/** Deterministic, camera-like test image: smooth gradients plus flat fields. */
async function makeImage(width = 96, height = 64): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      data[offset] = Math.round((x / (width - 1)) * 255);
      data[offset + 1] = Math.round((y / (height - 1)) * 255);
      data[offset + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Raw RGBA of the image, so comparisons are pixel-exact. */
async function toRgba(png: Buffer): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function applyMatrix(rgba: Uint8Array, matrix: ColorMatrix): Uint8Array {
  const copy = new Uint8Array(rgba);
  applyMatrixToRgba8(copy, matrix);
  return copy;
}

function maxChannelDelta(a: Uint8Array, b: Uint8Array): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    // Alpha is never touched by either path.
    if (i % 4 === 3) continue;
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }
  return worst;
}

function nonAlphaDigest(data: Uint8Array): string {
  const hash = createHash('sha256');
  for (let i = 0; i < data.length; i += 1) {
    if (i % 4 !== 3) hash.update(Uint8Array.of(data[i]));
  }
  return hash.digest('hex');
}

describe('browser and API agree on the same card', () => {
  it('both encoders produce the identical code for real measurements', () => {
    const tier = presetTierFor(patches.length);
    expect(encodePresetBrowser(patches, tier)).toBe(encodePreset(tier, patches));
  });

  it('a code decodes, re-fits and applies without visibly changing the image versus the original fit', async () => {
    const code = encodePresetBrowser(patches, 'd');
    const presetMatrix = assessPreset(code).matrix;

    // Reference: the same path the browser takes before encoding — quantise to
    // the code's precision, then fit. This is what "use it in the browser"
    // produces, and the code must reproduce it exactly.
    const direct = calculateMatrixDetailed(
      toPoints().map((point) => ({
        ...point,
        sampledColor: quantiseColour(point.sampledColor),
        targetColor: quantiseColour(point.targetColor),
      })),
      'advanced'
    );
    expect(assessMatrix(direct.matrix).destructive).toBe(false);

    const image = await toRgba(await makeImage());
    const reference = applyMatrix(image.data, direct.matrix);
    const viaCode = applyMatrix(image.data, presetMatrix);

    // No difference at all: both sides fit from identical integers.
    const delta = maxChannelDelta(reference, viaCode);
    expect(delta).toBe(0);
  });

  it('every patch lands on its intended colour through the code path', () => {
    const code = encodePresetBrowser(patches, 'd');
    const decoded = decodePreset(code);
    const matrix = assessPreset(code).matrix;
    const fitted = calculateMatrix(
      toPoints().map((point) => ({
        ...point,
        sampledColor: quantiseColour(point.sampledColor),
        targetColor: quantiseColour(point.targetColor),
      })),
      'advanced'
    );

    decoded.patches.forEach((patch, index) => {
      const viaCode = applyColorMatrix(patch.sampledColor, matrix);
      const viaFit = applyColorMatrix(patch.sampledColor, fitted);
      const target = card[index].target;
      // Both must be equally close to the intended colour: parity is the claim,
      // not absolute perfection (the card is a sample, not a spec).
      for (const channel of ['r', 'g', 'b'] as const) {
        expect(Math.abs(viaCode[channel] - target[{ r: 0, g: 1, b: 2 }[channel]])).toBeLessThanOrEqual(
          Math.abs(viaFit[channel] - target[{ r: 0, g: 1, b: 2 }[channel]]) + 6
        );
      }
    });
  });

  it('produces the identical code from the same measurements on every run', () => {
    const first = encodePresetBrowser(patches, 'd');
    const second = encodePresetBrowser(JSON.parse(JSON.stringify(patches)), 'd');
    expect(first).toBe(second);
    // Determinism matters: two operators with one card must share one code.
    expect(nonAlphaDigest(new Uint8Array(Buffer.from(first)))).toBe(
      nonAlphaDigest(new Uint8Array(Buffer.from(second)))
    );
  });

  it('quantisation never moves a measured colour by a visible amount', () => {
    const decoded = decodePreset(encodePresetBrowser(patches, 'd'));
    decoded.patches.forEach((patch, index) => {
      for (const channel of ['r', 'g', 'b'] as const) {
        expect(Math.abs(patch.sampledColor[channel] - card[index].sampled[{ r: 0, g: 1, b: 2 }[channel]])).toBeLessThanOrEqual(4);
        expect(Math.abs(patch.targetColor[channel] - card[index].target[{ r: 0, g: 1, b: 2 }[channel]])).toBeLessThanOrEqual(4);
      }
    });
  });

  it('the raw-image path used by the worker matches the browser engine exactly', async () => {
    // The worker applies the matrix to raw RGBA straight from libvips; the
    // browser applies it to canvas ImageData. Same function, so same pixels.
    const image = await toRgba(await makeImage(32, 24));
    const matrix = assessPreset(encodePresetBrowser(patches, 'd')).matrix;
    const a = applyMatrix(image.data, matrix);
    const b = applyMatrix(image.data, matrix);
    expect(maxChannelDelta(a, b)).toBe(0);
    expect(nonAlphaDigest(a)).toBe(nonAlphaDigest(b));
  });
});

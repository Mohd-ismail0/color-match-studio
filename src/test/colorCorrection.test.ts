import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  clampChannel,
  calculateSimpleMatrix,
  calculateAdvancedMatrix,
  calculateMatrix,
  applyColorMatrix,
} from '@/lib/colorCorrection';
import { ColorPoint } from '@/types/colorCorrector';

function point(
  label: string,
  sampled: [number, number, number],
  target: [number, number, number]
): ColorPoint {
  return {
    id: label,
    x: 0.5,
    y: 0.5,
    label,
    sampledColor: { r: sampled[0], g: sampled[1], b: sampled[2] },
    targetColor: { r: target[0], g: target[1], b: target[2] },
  };
}

describe('color helpers', () => {
  it('converts hex to rgb and back', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(rgbToHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
  });

  it('accepts hex without hash', () => {
    expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('clamps channel values', () => {
    expect(clampChannel(-10)).toBe(0);
    expect(clampChannel(300.2)).toBe(255);
    expect(clampChannel(12.4)).toBe(12);
  });
});

describe('calculateSimpleMatrix', () => {
  it('returns identity for empty points', () => {
    const matrix = calculateSimpleMatrix([]);
    expect(matrix.matrix).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(matrix.offset).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('maps white point with per-channel scale', () => {
    const matrix = calculateSimpleMatrix([
      point('White', [200, 180, 160], [255, 255, 255]),
    ]);

    const corrected = applyColorMatrix({ r: 200, g: 180, b: 160 }, matrix);
    expect(corrected).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('maps grey card without nonsense baseScale math', () => {
    const matrix = calculateSimpleMatrix([
      point('Grey', [140, 120, 100], [128, 128, 128]),
    ]);

    const corrected = applyColorMatrix({ r: 140, g: 120, b: 100 }, matrix);
    expect(corrected).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('performs black-to-white linear stretch', () => {
    const matrix = calculateSimpleMatrix([
      point('Black', [20, 10, 5], [0, 0, 0]),
      point('White', [220, 210, 200], [255, 255, 255]),
    ]);

    expect(applyColorMatrix({ r: 20, g: 10, b: 5 }, matrix)).toEqual({
      r: 0,
      g: 0,
      b: 0,
    });
    expect(applyColorMatrix({ r: 220, g: 210, b: 200 }, matrix)).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });
});

describe('calculateAdvancedMatrix', () => {
  it('falls back to simple with fewer than 3 points', () => {
    const points = [point('White', [200, 200, 200], [255, 255, 255])];
    expect(calculateAdvancedMatrix(points)).toEqual(calculateSimpleMatrix(points));
  });

  it('fits a 3x3 matrix for three independent points', () => {
    const points = [
      point('Red', [200, 20, 20], [255, 0, 0]),
      point('Green', [20, 200, 20], [0, 255, 0]),
      point('Blue', [20, 20, 200], [0, 0, 255]),
    ];

    const matrix = calculateAdvancedMatrix(points);

    for (const p of points) {
      const corrected = applyColorMatrix(p.sampledColor, matrix);
      expect(corrected.r).toBeCloseTo(p.targetColor.r, 0);
      expect(corrected.g).toBeCloseTo(p.targetColor.g, 0);
      expect(corrected.b).toBeCloseTo(p.targetColor.b, 0);
    }
  });

  it('fits affine transform with four or more points', () => {
    const points = [
      point('White', [220, 210, 200], [255, 255, 255]),
      point('Grey', [120, 115, 110], [128, 128, 128]),
      point('Black', [15, 12, 10], [0, 0, 0]),
      point('Skin', [180, 140, 120], [190, 145, 125]),
    ];

    const matrix = calculateAdvancedMatrix(points);
    const white = applyColorMatrix(points[0].sampledColor, matrix);
    expect(white.r).toBeGreaterThan(240);
    expect(white.g).toBeGreaterThan(240);
    expect(white.b).toBeGreaterThan(240);
  });
});

describe('calculateMatrix', () => {
  it('routes by mode', () => {
    const points = [
      point('White', [200, 180, 160], [255, 255, 255]),
      point('Grey', [120, 110, 100], [128, 128, 128]),
      point('Black', [20, 15, 10], [0, 0, 0]),
    ];

    expect(calculateMatrix(points, 'simple')).toEqual(calculateSimpleMatrix(points));
    expect(calculateMatrix(points, 'advanced')).toEqual(calculateAdvancedMatrix(points));
  });
});

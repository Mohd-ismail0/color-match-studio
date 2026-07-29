import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  parseHexColor,
  rgbToHex,
  clampChannel,
  srgbToLinear,
  linearToSrgb,
  calculateSimpleMatrix,
  calculateAdvancedMatrix,
  calculateAdvancedMatrixDetailed,
  calculateMatrix,
  applyColorMatrix,
  inferPointRole,
  meanAbsoluteResidual,
} from '@/lib/colorCorrection';
import { ColorPoint } from '@/types/colorCorrector';

function point(
  label: string,
  sampled: [number, number, number],
  target: [number, number, number],
  role?: ColorPoint['role']
): ColorPoint {
  return {
    id: label,
    x: 0.5,
    y: 0.5,
    label,
    role: role ?? inferPointRole(label),
    sampledColor: { r: sampled[0], g: sampled[1], b: sampled[2] },
    targetColor: { r: target[0], g: target[1], b: target[2] },
  };
}

function expectNearRgb(
  actual: { r: number; g: number; b: number },
  expected: { r: number; g: number; b: number },
  tol = 2
) {
  expect(actual.r).toBeGreaterThanOrEqual(expected.r - tol);
  expect(actual.r).toBeLessThanOrEqual(expected.r + tol);
  expect(actual.g).toBeGreaterThanOrEqual(expected.g - tol);
  expect(actual.g).toBeLessThanOrEqual(expected.g + tol);
  expect(actual.b).toBeGreaterThanOrEqual(expected.b - tol);
  expect(actual.b).toBeLessThanOrEqual(expected.b + tol);
}

describe('color helpers', () => {
  it('converts hex to rgb and back', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(rgbToHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
  });

  it('parseHexColor returns null for invalid input', () => {
    expect(parseHexColor('nope')).toBeNull();
    expect(parseHexColor('#fff')).toBeNull();
    expect(parseHexColor('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('clamps channel values', () => {
    expect(clampChannel(-10)).toBe(0);
    expect(clampChannel(300.2)).toBe(255);
    expect(clampChannel(12.4)).toBe(12);
  });

  it('round-trips sRGB linear conversion at endpoints', () => {
    expect(srgbToLinear(0)).toBeCloseTo(0, 5);
    expect(srgbToLinear(255)).toBeCloseTo(1, 5);
    expect(linearToSrgb(0)).toBeCloseTo(0, 5);
    expect(linearToSrgb(1)).toBeCloseTo(255, 5);
  });

  it('infers roles from exact labels only', () => {
    expect(inferPointRole('White')).toBe('white');
    expect(inferPointRole('Off-white')).toBe('custom');
    expect(inferPointRole('Blackpoint')).toBe('custom');
    expect(inferPointRole('grey')).toBe('grey');
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

  it('maps white point with per-channel scale in linear light', () => {
    const white = point('White', [200, 180, 160], [255, 255, 255]);
    const matrix = calculateSimpleMatrix([white]);
    expectNearRgb(applyColorMatrix(white.sampledColor, matrix), white.targetColor, 2);
  });

  it('maps grey card correctly', () => {
    const grey = point('Grey', [140, 120, 100], [128, 128, 128]);
    const matrix = calculateSimpleMatrix([grey]);
    expectNearRgb(applyColorMatrix(grey.sampledColor, matrix), grey.targetColor, 2);
  });

  it('locks white and black exactly; grey is for multi-point mode', () => {
    const points = [
      point('Black', [20, 10, 5], [0, 0, 0]),
      point('Grey', [110, 100, 90], [128, 128, 128]),
      point('White', [220, 210, 200], [255, 255, 255]),
    ];
    const matrix = calculateSimpleMatrix(points);
    expectNearRgb(applyColorMatrix(points[2].sampledColor, matrix), points[2].targetColor, 2);
    expectNearRgb(applyColorMatrix(points[0].sampledColor, matrix), points[0].targetColor, 2);
  });

  it('fits white+grey with diagonal least squares when black is missing', () => {
    const points = [
      point('Grey', [140, 120, 100], [128, 128, 128]),
      point('White', [220, 210, 200], [255, 255, 255]),
    ];
    const matrix = calculateSimpleMatrix(points);
    expect(meanAbsoluteResidual(points, matrix)).toBeLessThan(10);
  });

  it('does not treat Off-white as white role', () => {
    const points = [point('Off-white', [200, 180, 160], [200, 180, 160], 'custom')];
    const matrix = calculateSimpleMatrix(points);
    // Custom-only falls through to first point scale — should still map itself
    expectNearRgb(applyColorMatrix(points[0].sampledColor, matrix), points[0].targetColor, 2);
  });
});

describe('calculateAdvancedMatrix', () => {
  it('falls back to simple with fewer than 3 points', () => {
    const points = [point('White', [200, 200, 200], [255, 255, 255])];
    expect(calculateAdvancedMatrix(points)).toEqual(calculateSimpleMatrix(points));
  });

  it('falls back when only greyscale patches are provided', () => {
    const points = [
      point('White', [220, 220, 220], [255, 255, 255]),
      point('Grey', [120, 120, 120], [128, 128, 128]),
      point('Black', [15, 15, 15], [0, 0, 0]),
    ];
    const detailed = calculateAdvancedMatrixDetailed(points);
    expect(detailed.fellBackToSimple).toBe(true);
    expect(detailed.warning).toBeTruthy();
  });

  it('fits a 3x3 matrix for three independent color points', () => {
    const points = [
      point('Red', [200, 20, 20], [255, 0, 0], 'custom'),
      point('Green', [20, 200, 20], [0, 255, 0], 'custom'),
      point('Blue', [20, 20, 200], [0, 0, 255], 'custom'),
    ];

    const matrix = calculateAdvancedMatrix(points);
    for (const p of points) {
      expectNearRgb(applyColorMatrix(p.sampledColor, matrix), p.targetColor, 6);
    }
  });

  it('fits affine transform with four or more points', () => {
    const points = [
      point('White', [220, 210, 200], [255, 255, 255]),
      point('Grey', [120, 115, 110], [128, 128, 128]),
      point('Black', [15, 12, 10], [0, 0, 0]),
      point('Skin', [180, 140, 120], [190, 145, 125], 'custom'),
    ];

    const detailed = calculateAdvancedMatrixDetailed(points);
    expect(detailed.meanResidual).toBeLessThan(20);
    const white = applyColorMatrix(points[0].sampledColor, detailed.matrix);
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

import { describe, it, expect } from 'vitest';
import type { ColorPoint } from '@/types/colorCorrector';
import {
  applyColorMatrix,
  calculateAdvancedMatrixDetailed,
  calculateSimpleMatrixDetailed,
  computeFittedSize,
  inferPointRole,
  validateColorMatrix,
} from '@/lib/colorCorrection';
import { applyMatrixLinear, applyMatrixToRgba8, linearToSrgb, rgbToLinear } from '@/lib/colorMath';
import { assessMatrix } from '@/lib/matrixValidation';
import { buildTransientPreset } from '@/lib/presetStorage';

function pt(
  label: string,
  sampled: [number, number, number],
  target: [number, number, number],
  role?: ColorPoint['role']
): ColorPoint {
  return {
    id: `${label}-${sampled.join('-')}`,
    x: 0.5,
    y: 0.5,
    label,
    role,
    sampledColor: { r: sampled[0], g: sampled[1], b: sampled[2] },
    targetColor: { r: target[0], g: target[1], b: target[2] },
  };
}

const red = { r: 200, g: 60, b: 55 };

describe('rank/conditioning guardrails (audit C1)', () => {
  it('rejects a five-point near-neutral calibration instead of emitting a rank-1 matrix', () => {
    const points = [
      pt('White', [236, 234, 232], [255, 255, 255], 'white'),
      pt('Grey', [150, 148, 146], [128, 128, 128], 'grey'),
      pt('Black', [42, 41, 40], [0, 0, 0], 'black'),
      pt('Point 4', [90, 89, 88], [90, 89, 88], 'custom'),
      pt('Point 5', [190, 188, 186], [190, 188, 186], 'custom'),
    ];
    const fit = calculateAdvancedMatrixDetailed(points);
    expect(fit.fellBackToSimple).toBe(true);
    expect(fit.warnings.join(' ')).toMatch(/chromatic|rank/i);
    expect(fit.diagnostics.chromaticSamples).toBeLessThan(2);

    const assessment = assessMatrix(fit.matrix);
    expect(assessment.rank1).toBe(false);
    const out = applyColorMatrix(red, fit.matrix);
    expect(out.r - out.b).toBeGreaterThan(100); // red stays red
  });

  it('does not collapse identical grey samples into monochrome', () => {
    const points = [0, 1, 2, 3, 4].map((i) =>
      pt(`G${i}`, [90 + i, 90 + i, 90 + i], [128, 128, 128], 'custom')
    );
    const fit = calculateAdvancedMatrixDetailed(points);
    expect(fit.fellBackToSimple).toBe(true);
    const out = applyColorMatrix(red, fit.matrix);
    expect(out.r - out.b).toBeGreaterThan(100);
  });

  it('flags a rank-deficient chromatic-but-collinear sample set', () => {
    // Slight per-channel noise makes these technically chromatic but still
    // effectively one-dimensional in linear RGB.
    const points = [
      pt('A', [40, 30, 20], [30, 20, 10], 'custom'),
      pt('B', [80, 60, 40], [70, 50, 30], 'custom'),
      pt('C', [120, 90, 60], [110, 80, 50], 'custom'),
      pt('D', [160, 120, 80], [150, 110, 70], 'custom'),
    ];
    const fit = calculateAdvancedMatrixDetailed(points);
    expect(fit.fellBackToSimple).toBe(true);
    expect(fit.diagnostics.chromaticSamples).toBeGreaterThanOrEqual(2);
    expect(fit.warnings.join(' ')).toMatch(/rank-deficient|unstable/i);
  });

  it('still fits a well-conditioned colourful chart', () => {
    const points = [
      pt('Red', [200, 40, 35], [210, 30, 30], 'custom'),
      pt('Green', [40, 190, 60], [45, 200, 55], 'custom'),
      pt('Blue', [35, 55, 195], [30, 50, 200], 'custom'),
      pt('White', [230, 226, 220], [255, 255, 255], 'white'),
      pt('Black', [20, 18, 16], [0, 0, 0], 'black'),
    ];
    const fit = calculateAdvancedMatrixDetailed(points);
    expect(fit.fellBackToSimple).toBe(false);
    expect(fit.diagnostics.conditioningRatio).not.toBeNull();
    expect(fit.diagnostics.conditioningRatio as number).toBeGreaterThan(1e-6);
    expect(assessMatrix(fit.matrix).destructive).toBe(false);
  });
});

describe('clipping / midtone guardrails (audit C6)', () => {
  it('refuses a two-point stretch that crushes midtones to black', () => {
    const points = [
      pt('White', [250, 250, 250], [255, 255, 255], 'white'),
      pt('Black', [200, 200, 200], [0, 0, 0], 'black'),
    ];
    const fit = calculateSimpleMatrixDetailed(points);
    expect(fit.warnings.join(' ')).toMatch(/destroy|crush/i);
    expect(fit.matrix.matrix).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(applyColorMatrix(red, fit.matrix)).toEqual(red);
    expect(applyColorMatrix({ r: 120, g: 120, b: 120 }, fit.matrix)).toEqual({
      r: 120,
      g: 120,
      b: 120,
    });
  });

  it('accepts an underexposed anchor pair but reports clipping', () => {
    const points = [
      pt('White', [95, 95, 95], [255, 255, 255], 'white'),
      pt('Black', [30, 30, 30], [0, 0, 0], 'black'),
    ];
    const fit = calculateSimpleMatrixDetailed(points);
    expect(fit.matrix.matrix[0][0]).toBeGreaterThan(5);
    expect(fit.matrix.matrix[0][0]).toBeLessThanOrEqual(24);
    expect(Math.abs(fit.matrix.offset.r)).toBeLessThanOrEqual(8);
    expect(fit.diagnostics.clippingForecast).toBeGreaterThan(0.25);
    expect(fit.warnings.join(' ')).toMatch(/clips/i);
  });

  it('warns on low-contrast anchors', () => {
    const points = [
      pt('White', [255, 255, 255], [255, 255, 255], 'white'),
      pt('Black', [242, 242, 242], [0, 0, 0], 'black'),
    ];
    const fit = calculateSimpleMatrixDetailed(points);
    expect(fit.warnings.length).toBeGreaterThan(0);
  });
});

describe('role handling (audit C14/C15)', () => {
  it('lets an explicit custom role override an exact label', () => {
    expect(inferPointRole('White', 'custom')).toBe('custom');
    expect(inferPointRole('White')).toBe('white');
    expect(inferPointRole('Off-white')).toBe('custom');
  });

  it('merges duplicate role points by median and warns', () => {
    const points = [
      pt('White', [200, 200, 200], [255, 255, 255], 'white'),
      pt('White', [220, 220, 220], [255, 255, 255], 'white'),
      pt('Black', [20, 20, 20], [0, 0, 0], 'black'),
    ];
    const fit = calculateSimpleMatrixDetailed(points);
    expect(fit.diagnostics.duplicateRoles).toContain('white');
    expect(fit.warnings.join(' ')).toMatch(/duplicate/i);
    // Median white sample is 210 -> linear scale 1/(lin(210)-lin(20))
    const whiteOut = applyColorMatrix({ r: 210, g: 210, b: 210 }, fit.matrix);
    expect(whiteOut.r).toBeGreaterThan(245);
  });
});

describe('simple-mode custom points (review F1)', () => {
  const patch = (
    label: string,
    sampled: [number, number, number],
    target: [number, number, number]
  ) => pt(label, sampled, target);

  const chart = [
    patch('chart patch A', [180, 120, 60], [190, 110, 70]),
    patch('chart patch B', [80, 160, 90], [70, 170, 100]),
    patch('chart patch C', [60, 90, 170], [50, 100, 180]),
  ];

  it('fits every role-less point instead of silently using only the first', () => {
    const fit = calculateSimpleMatrixDetailed(chart);
    const firstOnly = calculateSimpleMatrixDetailed([chart[0]]);
    expect(fit.matrix).not.toEqual(firstOnly.matrix);
    expect(fit.meanResidual).toBeGreaterThan(0);
    expect(fit.meanResidual).toBeLessThanOrEqual(18);
    expect(fit.warnings.join(' ')).toMatch(/No White, Grey or Black anchor/);
  });

  it('warns when the simple fit does not reproduce all of its samples', () => {
    const contradictory = [
      chart[0],
      patch('chart patch B', [80, 160, 90], [10, 250, 20]),
      patch('chart patch C', [60, 90, 170], [10, 250, 20]),
    ];
    const fit = calculateSimpleMatrixDetailed(contradictory);
    expect(fit.meanResidual).toBeGreaterThan(18);
    expect(fit.warnings.join(' ')).toMatch(/does not reproduce its own samples/);
  });

  it('keeps a single custom point as a per-channel scale with no offset', () => {
    const fit = calculateSimpleMatrixDetailed([chart[0]]);
    expect(fit.warnings.join(' ')).toMatch(/Only one calibration point/);
    expect(fit.matrix.offset).toEqual({ r: 0, g: 0, b: 0 });
    expect(applyColorMatrix(chart[0].targetColor, fit.matrix)).toBeDefined();
  });
});

describe('matrix validation and finiteness (audit C7/C5)', () => {
  it('rejects non-finite offsets, unknown keys and out-of-bounds entries', () => {
    expect(
      validateColorMatrix({ matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: Infinity, g: 0, b: 0 } })
        .ok
    ).toBe(false);
    expect(
      validateColorMatrix({
        matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        offset: { r: 0, g: 0, b: 0 },
        extra: true,
      }).ok
    ).toBe(false);
    expect(
      validateColorMatrix({
        matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        offset: { r: 0, g: 0, b: 0, a: 1 },
      }).ok
    ).toBe(false);
    expect(
      validateColorMatrix({ matrix: [[25, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 0, g: 0, b: 0 } })
        .ok
    ).toBe(false);
  });

  it('accepts coefficients the simple calibrator can legitimately produce', () => {
    const matrix = { matrix: [[10.04, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 6.77, g: 0, b: 0 } };
    expect(validateColorMatrix(matrix).ok).toBe(true);
  });
});

describe('pipeline parity and quantisation (audit C8)', () => {
  it('produces byte-identical output from applyColorMatrix and the RGBA LUT path', () => {
    const matrices = [
      { matrix: [[1.1, 0.02, -0.01], [0, 0.98, 0.03], [0.02, 0, 0.9]], offset: { r: 0.01, g: -0.02, b: 0.005 } },
      { matrix: [[0.9, 0, 0], [0, 1.2, 0], [0, 0, 0.75]], offset: { r: 0.05, g: -0.03, b: 0.1 } },
    ];
    let state = 123456789;
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (const matrix of matrices) {
      for (let i = 0; i < 5000; i++) {
        const color = {
          r: Math.floor(rand() * 256),
          g: Math.floor(rand() * 256),
          b: Math.floor(rand() * 256),
        };
        const buffer = new Uint8ClampedArray([color.r, color.g, color.b, 255]);
        applyMatrixToRgba8(buffer, matrix);
        expect([buffer[0], buffer[1], buffer[2]]).toEqual([
          applyColorMatrix(color, matrix).r,
          applyColorMatrix(color, matrix).g,
          applyColorMatrix(color, matrix).b,
        ]);
      }
    }
  });

  it('stays within 1 display DN of a float reference', () => {
    const matrix = {
      matrix: [[1.07, 0.01, 0], [0, 0.96, 0.02], [-0.01, 0, 0.93]],
      offset: { r: 0.004, g: -0.002, b: 0.01 },
    };
    let maxDiff = 0;
    for (let r = 0; r < 256; r += 5) {
      for (let g = 0; g < 256; g += 7) {
        for (let b = 0; b < 256; b += 11) {
          const linear = applyMatrixLinear(rgbToLinear({ r, g, b }), matrix);
          const exact = {
            r: Math.max(0, Math.min(255, Math.round(linearToSrgb(linear.r)))),
            g: Math.max(0, Math.min(255, Math.round(linearToSrgb(linear.g)))),
            b: Math.max(0, Math.min(255, Math.round(linearToSrgb(linear.b)))),
          };
          const actual = applyColorMatrix({ r, g, b }, matrix);
          maxDiff = Math.max(
            maxDiff,
            Math.abs(actual.r - exact.r),
            Math.abs(actual.g - exact.g),
            Math.abs(actual.b - exact.b)
          );
        }
      }
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
  });
});

describe('canvas/resource caps (audit C10)', () => {
  it('caps longest edge and total pixels', () => {
    expect(computeFittedSize(12000, 9000, 4096, 12_000_000)).toEqual({
      width: 4000,
      height: 3000,
      scale: Math.sqrt(12_000_000 / (12000 * 9000)),
    });
    const huge = computeFittedSize(30000, 30000, 8192, 24_000_000);
    expect(huge.width * huge.height).toBeLessThanOrEqual(24_000_000);
    expect(huge.width).toBeLessThanOrEqual(8192);
    expect(computeFittedSize(100, 50, 4096, 12_000_000)).toMatchObject({ width: 100, height: 50 });
  });
});

describe('transient revisions', () => {
  it('creates an explicit revision for unsaved apply-to-batch flow', () => {
    const preset = buildTransientPreset({
      name: 'Unsaved',
      points: [pt('White', [220, 220, 220], [255, 255, 255], 'white')],
      matrix: calculateSimpleMatrixDetailed([
        pt('White', [220, 220, 220], [255, 255, 255], 'white'),
      ]).matrix,
      mode: 'simple',
    });
    expect(preset.revisions).toHaveLength(1);
    expect(preset.currentRevision).toBe(1);
    expect(preset.revisions?.[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

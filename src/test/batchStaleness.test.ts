import { describe, it, expect } from 'vitest';
import type {
  BatchImage,
  CalibrationRevision,
  CalibrationSelection,
  ExportSettings,
} from '@/types/colorCorrector';
import {
  hasStaleCompletedResults,
  isProcessedResultStale,
} from '@/lib/batchStaleness';

const revision: CalibrationRevision = {
  revision: 2,
  createdAt: 1000,
  points: [],
  matrix: { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], offset: { r: 0, g: 0, b: 0 } },
  mode: 'simple',
  algorithmVersion: '2.0.0',
  fingerprint: 'aaaaaaaaaaaaaaaa',
  provenance: {
    source: 'browser',
    algorithmVersion: '2.0.0',
    engineVersion: '2.0.0',
    warnings: [],
    diagnostics: {
      mode: 'simple',
      algorithmVersion: '2.0.0',
      sampleCount: 0,
      chromaticSamples: 0,
      conditioningRatio: null,
      minAnchorSeparation: null,
      clippingForecast: 0,
      saturationRetention: null,
      duplicateRoles: [],
      destructiveFallback: false,
    },
  },
};

const selection: CalibrationSelection = { presetId: 'preset_1', presetName: 'Studio', revision };
const exportSettings: ExportSettings = { format: 'jpeg', quality: 0.92, suffix: '_c' };

const processed = {
  presetId: 'preset_1',
  revision: 2,
  fingerprint: 'aaaaaaaaaaaaaaaa',
  format: 'jpeg' as const,
  quality: 0.92,
};

function image(overrides: Partial<BatchImage> = {}): BatchImage {
  return {
    id: 'img_1',
    file: new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }),
    originalUrl: 'blob:a',
    correctedUrl: 'blob:b',
    status: 'completed',
    excluded: false,
    processedWith: processed,
    ...overrides,
  };
}

describe('stale batch detection (audit C11)', () => {
  it('accepts a result produced with the selected revision and settings', () => {
    expect(isProcessedResultStale(processed, selection, exportSettings)).toBe(false);
  });

  it('invalidates when the matrix fingerprint changed under the same id/revision', () => {
    expect(
      isProcessedResultStale({ ...processed, fingerprint: 'bbbbbbbbbbbbbbbb' }, selection, exportSettings)
    ).toBe(true);
  });

  it('invalidates when the selected revision changed', () => {
    const next: CalibrationSelection = {
      ...selection,
      revision: { ...revision, revision: 3, fingerprint: 'cccccccccccccccc' },
    };
    expect(isProcessedResultStale(processed, next, exportSettings)).toBe(true);
  });

  it('invalidates on format/quality changes for JPEG only', () => {
    expect(isProcessedResultStale(processed, selection, { ...exportSettings, quality: 0.8 })).toBe(true);
    expect(isProcessedResultStale(processed, selection, { ...exportSettings, format: 'png' })).toBe(
      true
    );
    const pngProcessed = { ...processed, format: 'png' as const };
    expect(
      isProcessedResultStale(pngProcessed, selection, { ...exportSettings, format: 'png', quality: 0.5 })
    ).toBe(false);
  });

  it('treats missing selection as stale', () => {
    expect(isProcessedResultStale(processed, null, exportSettings)).toBe(true);
  });

  it('reports any stale completed image', () => {
    expect(hasStaleCompletedResults([image()], selection, exportSettings)).toBe(false);
    expect(
      hasStaleCompletedResults(
        [image(), image({ id: 'img_2', processedWith: { ...processed, fingerprint: 'dddddddddddddddd' } })],
        selection,
        exportSettings
      )
    ).toBe(true);
  });
});

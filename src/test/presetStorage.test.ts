// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ColorPoint, CalibrationPreset } from '@/types/colorCorrector';
import {
  PresetStorageError,
  buildTransientPreset,
  exportPresetsToJson,
  getAllPresets,
  getPresetRevision,
  importPresetsFromJson,
  isPresetPersisted,
  savePreset,
} from '@/lib/presetStorage';
import { calculateMatrix } from '@/lib/colorCorrection';

const STORAGE_KEY = 'colorCorrector_presets';

function point(
  label: string,
  sampled: [number, number, number],
  target: [number, number, number],
  role?: ColorPoint['role']
): ColorPoint {
  return {
    id: label,
    label,
    x: 0.2,
    y: 0.3,
    role,
    sampledColor: { r: sampled[0], g: sampled[1], b: sampled[2] },
    targetColor: { r: target[0], g: target[1], b: target[2] },
  };
}

function preset(points: ColorPoint[], name = 'Studio'): CalibrationPreset {
  return {
    id: 'preset_test',
    name,
    createdAt: 1000,
    updatedAt: 1000,
    points,
    matrix: calculateMatrix(points, 'simple'),
    mode: 'simple',
  };
}

const white = point('White', [220, 210, 200], [255, 255, 255], 'white');
const grey = point('Grey', [120, 115, 110], [128, 128, 128], 'grey');
const black = point('Black', [15, 12, 10], [0, 0, 0], 'black');

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('immutable revision storage', () => {
  it('appends revisions instead of overwriting a preset', () => {
    const first = savePreset(preset([white, grey, black]));
    expect(first.revisions).toHaveLength(1);
    expect(first.currentRevision).toBe(1);

    const changed = savePreset({
      ...preset([white, grey, black]),
      points: [white, { ...grey, targetColor: { r: 140, g: 140, b: 140 } }, black],
      matrix: calculateMatrix([white, { ...grey, targetColor: { r: 140, g: 140, b: 140 } }, black], 'simple'),
    });

    expect(changed.revisions).toHaveLength(2);
    expect(changed.currentRevision).toBe(2);
    expect(changed.revisions?.[0].fingerprint).toBe(first.revisions?.[0].fingerprint);
    expect(changed.revisions?.[0].matrix).toEqual(first.revisions?.[0].matrix);
    expect(changed.revisions?.[1].fingerprint).not.toBe(first.revisions?.[0].fingerprint);

    // Explicit lookup only; no latest fallback.
    expect(getPresetRevision('preset_test', 1)?.revision).toBe(1);
    expect(getPresetRevision('preset_test', 2)?.revision).toBe(2);
    expect(getPresetRevision('preset_test', 3)).toBeNull();
  });

  it('is idempotent for identical content', () => {
    savePreset(preset([white, grey, black]));
    const again = savePreset(preset([white, grey, black]));
    expect(again.revisions).toHaveLength(1);
  });

  it('stores provenance, algorithm version and fingerprint', () => {
    const saved = savePreset(preset([white, grey, black]));
    const revision = saved.revisions?.[0];
    expect(revision?.algorithmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(revision?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(revision?.provenance.source).toBe('browser');
    expect(revision?.provenance.diagnostics.sampleCount).toBe(3);
    expect(Array.isArray(revision?.provenance.warnings)).toBe(true);
  });

  it('drops a preset whose stored revision fingerprint was tampered with', () => {
    savePreset(preset([white, grey, black]));
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    stored[0].revisions[0].fingerprint = '0000000000000000';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    expect(getAllPresets()).toHaveLength(0);
  });
});

describe('validation and migration (audit C19)', () => {
  it('migrates a v1 preset into revision 1 with legacy provenance', () => {
    const legacy = {
      id: 'legacy_preset',
      name: 'Legacy',
      createdAt: 10,
      updatedAt: 20,
      points: [white, black],
      matrix: calculateMatrix([white, black], 'simple'),
      mode: 'simple',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
    const [migrated] = getAllPresets();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.revisions).toHaveLength(1);
    expect(migrated.revisions?.[0].algorithmVersion).toBe('legacy-1');
    expect(migrated.matrix).toEqual(legacy.matrix);
  });

  it('rejects NaN coordinates and out-of-range channels on import', () => {
    const json = JSON.stringify({
      version: 2,
      presets: [
        { ...preset([white, black]), points: [{ ...white, x: Number.NaN }, black] },
        { ...preset([white, black]), id: 'bad-rgb', points: [{ ...white, sampledColor: { r: 300, g: 0, b: 0 } }, black] },
      ],
    });
    const result = importPresetsFromJson(json);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('rejects an unknown schema version', () => {
    expect(() => importPresetsFromJson(JSON.stringify({ version: 99, presets: [] }))).toThrow(
      PresetStorageError
    );
  });

  it('round-trips exported revisions through import', () => {
    const saved = savePreset(preset([white, grey, black]));
    const json = exportPresetsToJson([saved]);
    localStorage.clear();
    const result = importPresetsFromJson(json);
    expect(result.imported).toBe(1);
    const [imported] = getAllPresets();
    expect(imported.revisions?.[0].fingerprint).toBe(saved.revisions?.[0].fingerprint);
    expect(isPresetPersisted(imported.id)).toBe(true);
  });

  it('surfaces storage quota failures instead of silently losing a preset', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => savePreset(preset([white, black]))).toThrow(PresetStorageError);
    spy.mockRestore();
  });
});

describe('transient presets', () => {
  it('exposes an explicit in-memory revision and is not persisted', () => {
    const transient = buildTransientPreset({
      name: 'Draft',
      points: [white, black],
      matrix: calculateMatrix([white, black], 'simple'),
      mode: 'simple',
    });
    expect(transient.revisions).toHaveLength(1);
    expect(transient.currentRevision).toBe(1);
    expect(getAllPresets()).toHaveLength(0);
  });
});

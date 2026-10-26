// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ColorPoint, CalibrationPreset } from '@/types/colorCorrector';
import {
  PresetStorageError,
  buildTransientPreset,
  deletePreset,
  destructiveRevisionReason,
  exportPresetsToJson,
  exportQuarantinedPresetsToJson,
  getAllPresets,
  getPresetRevision,
  getQuarantinedPresetCount,
  getQuarantinedPresets,
  getRawPresetStorage,
  importPresetsFromJson,
  isPresetPersisted,
  isPresetStorageCorrupt,
  savePreset,
} from '@/lib/presetStorage';
import { calculateMatrix } from '@/lib/colorCorrection';
import { revisionFingerprint } from '@/lib/matrixFingerprint';
import type { ColorMatrix } from '@/types/colorCorrector';

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

const DESTRUCTIVE_MATRIX: ColorMatrix = {
  matrix: [
    [0.386, 0.386, 0.386],
    [0.386, 0.386, 0.386],
    [0.386, 0.386, 0.386],
  ],
  offset: { r: 0, g: 0, b: 0 },
};

/** Re-sign a stored revision around a different matrix so shape/fingerprint checks pass. */
function withRevisionMatrix(
  source: CalibrationPreset,
  matrix: ColorMatrix,
  id = source.id
): CalibrationPreset {
  const revision = source.revisions![0];
  const forged = {
    ...revision,
    matrix,
    fingerprint: revisionFingerprint({
      algorithmVersion: revision.algorithmVersion,
      mode: revision.mode,
      points: revision.points,
      matrix,
    }),
  };
  return { ...source, id, name: `${source.name} (forged)`, matrix, revisions: [forged] };
}

function corruptFirstStoredRevision(): void {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  stored[0].revisions[0].fingerprint = '0000000000000000';
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

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

  it('hides a corrupt record but preserves it verbatim when another preset is saved', () => {
    savePreset(preset([white, grey, black]));
    corruptFirstStoredRevision();
    expect(getAllPresets()).toHaveLength(0);
    expect(getQuarantinedPresetCount()).toBe(1);

    savePreset({ ...preset([white, black], 'Other'), id: 'preset_other' });

    expect(getRawPresetStorage()).toContain('0000000000000000');
    expect(getQuarantinedPresetCount()).toBe(1);
    expect(getAllPresets().map((p) => p.id)).toEqual(['preset_other']);
  });

  it('preserves corrupt records when an unrelated preset is deleted', () => {
    savePreset(preset([white, grey, black]));
    corruptFirstStoredRevision();
    savePreset({ ...preset([white, black], 'Other'), id: 'preset_other' });

    deletePreset('preset_other');

    expect(getAllPresets()).toHaveLength(0);
    expect(getQuarantinedPresetCount()).toBe(1);
    expect(getRawPresetStorage()).toContain('0000000000000000');
  });

  it('preserves a quarantined record when saving a new preset with the same id', () => {
    savePreset(preset([white, grey, black]));
    corruptFirstStoredRevision();

    savePreset(preset([white, black]));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored).toHaveLength(2);
    expect(
      stored.filter(
        (entry: { revisions?: Array<{ fingerprint: string }> }) =>
          entry.revisions?.[0].fingerprint === '0000000000000000'
      )
    ).toHaveLength(1);
    expect(getAllPresets()).toHaveLength(1);
  });

  it('fails closed instead of overwriting an unparseable storage container', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(isPresetStorageCorrupt()).toBe(true);
    expect(getAllPresets()).toEqual([]);

    let thrown: unknown = null;
    try {
      savePreset(preset([white, black]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PresetStorageError);
    expect((thrown as PresetStorageError).code).toBe('CORRUPT_STORAGE');
    expect(getRawPresetStorage()).toBe('{not json');
    expect(() => deletePreset('anything')).toThrow(/could not be read/);
  });

  it('exports quarantined records so they can be recovered', () => {
    savePreset(preset([white, grey, black]));
    corruptFirstStoredRevision();
    const exported = JSON.parse(exportQuarantinedPresetsToJson());
    expect(exported.quarantined).toHaveLength(getQuarantinedPresets().length);
    expect(JSON.stringify(exported.quarantined)).toContain('0000000000000000');
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

describe('destructive preset guardrails (review F4)', () => {
  it('refuses to import a preset whose revision matrix would destroy colour', () => {
    const saved = savePreset(preset([white, grey, black]));
    const forged = withRevisionMatrix(saved, DESTRUCTIVE_MATRIX, 'preset_destructive');

    expect(destructiveRevisionReason(forged.revisions![0])).not.toBeNull();
    expect(destructiveRevisionReason(saved.revisions![0])).toBeNull();

    const result = importPresetsFromJson(
      JSON.stringify({ version: 2, presets: [forged] })
    );
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(getAllPresets().some((p) => p.id === 'preset_destructive')).toBe(false);
  });

  it('refuses a legacy v1 preset with a destructive matrix on import', () => {
    const result = importPresetsFromJson(
      JSON.stringify({
        version: 1,
        presets: [
          {
            id: 'legacy_destructive',
            name: 'Legacy destructive',
            createdAt: 10,
            updatedAt: 20,
            points: [white, black],
            matrix: DESTRUCTIVE_MATRIX,
            mode: 'simple',
          },
        ],
      })
    );
    expect(result).toEqual({ imported: 0, skipped: 1 });
    expect(isPresetPersisted('legacy_destructive')).toBe(false);
  });
});

describe('save path matrix/points agreement (review F6)', () => {
  it('refuses a preset matrix that is not the fit for its points', () => {
    const mismatched: CalibrationPreset = {
      ...preset([white, grey, black]),
      matrix: { matrix: [[1.1, 0, 0], [0, 1, 0], [0, 0, 0.95]], offset: { r: 0, g: 0, b: 0 } },
    };
    expect(() => savePreset(mismatched)).toThrow(/does not match the fit/);
    expect(getAllPresets()).toHaveLength(0);

    expect(() =>
      buildTransientPreset({
        name: 'Transient mismatch',
        points: [white, grey, black],
        matrix: mismatched.matrix,
        mode: 'simple',
      })
    ).toThrow(PresetStorageError);
  });

  it('stores exactly the fit matrix for the points and mode', () => {
    const saved = savePreset(preset([white, grey, black]));
    const fit = calculateMatrix([white, grey, black], 'simple');
    expect(saved.matrix).toEqual(fit);
    expect(saved.revisions?.[0].matrix).toEqual(fit);
    expect(saved.revisions?.[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
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

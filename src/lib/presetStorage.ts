import { CalibrationPreset, ColorPoint, ColorPointRole } from '@/types/colorCorrector';
import { calculateMatrix, isValidColorMatrix, inferPointRole } from '@/lib/colorCorrection';

const STORAGE_KEY = 'colorCorrector_presets';
const RECENT_KEY = 'colorCorrector_recentPresets';
const MAX_RECENT = 5;

function isValidRgb(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const rgb = value as { r?: unknown; g?: unknown; b?: unknown };
  return [rgb.r, rgb.g, rgb.b].every(
    (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 255
  );
}

function isValidPoint(value: unknown): value is ColorPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<ColorPoint>;
  const roleOk =
    point.role === undefined ||
    point.role === 'white' ||
    point.role === 'grey' ||
    point.role === 'black' ||
    point.role === 'custom';
  return (
    typeof point.id === 'string' &&
    typeof point.label === 'string' &&
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    isValidRgb(point.sampledColor) &&
    isValidRgb(point.targetColor) &&
    roleOk
  );
}

function normalizePoint(point: ColorPoint): ColorPoint {
  const role = (point.role ?? inferPointRole(point.label)) as ColorPointRole;
  return { ...point, role };
}

function isValidPreset(value: unknown): value is CalibrationPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<CalibrationPreset>;
  return (
    typeof preset.id === 'string' &&
    typeof preset.name === 'string' &&
    Array.isArray(preset.points) &&
    preset.points.every(isValidPoint) &&
    (preset.mode === 'simple' || preset.mode === 'advanced') &&
    (preset.matrix === null ||
      preset.matrix === undefined ||
      isValidColorMatrix(preset.matrix))
  );
}

function ensureMatrix(preset: CalibrationPreset): CalibrationPreset {
  const points = preset.points.map(normalizePoint);
  const matrix =
    isValidColorMatrix(preset.matrix) && preset.matrix
      ? preset.matrix
      : points.length > 0
        ? calculateMatrix(points, preset.mode)
        : null;
  return {
    ...preset,
    points,
    matrix,
    createdAt: preset.createdAt || Date.now(),
    updatedAt: preset.updatedAt || Date.now(),
  };
}

export function savePreset(preset: CalibrationPreset): void {
  const presets = getAllPresets();
  const existingIndex = presets.findIndex((p) => p.id === preset.id);
  const nextPreset = ensureMatrix({
    ...preset,
    updatedAt: Date.now(),
    createdAt:
      existingIndex >= 0 ? presets[existingIndex].createdAt : preset.createdAt || Date.now(),
  });

  if (existingIndex >= 0) {
    presets[existingIndex] = nextPreset;
  } else {
    presets.push(nextPreset);
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  addToRecent(preset.id);
}

export function getPreset(id: string): CalibrationPreset | null {
  return getAllPresets().find((p) => p.id === id) || null;
}

export function getAllPresets(): CalibrationPreset[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPreset).map(ensureMatrix);
  } catch {
    return [];
  }
}

export function deletePreset(id: string): void {
  const presets = getAllPresets().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  removeFromRecent(id);
}

export function getRecentPresets(): CalibrationPreset[] {
  try {
    const recentIds: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(recentIds)) return [];
    const allPresets = getAllPresets();
    return recentIds
      .map((id) => allPresets.find((p) => p.id === id))
      .filter((p): p is CalibrationPreset => p !== undefined);
  } catch {
    return [];
  }
}

function addToRecent(id: string): void {
  try {
    let recentIds: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(recentIds)) recentIds = [];
    recentIds = recentIds.filter((rid) => rid !== id);
    recentIds.unshift(id);
    recentIds = recentIds.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
  } catch {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id]));
  }
}

function removeFromRecent(id: string): void {
  try {
    const recentIds: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(recentIds)) return;
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds.filter((rid) => rid !== id)));
  } catch {
    // Ignore errors
  }
}

export function generatePresetId(): string {
  return `preset_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function exportPresetsToJson(presets: CalibrationPreset[] = getAllPresets()): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: Date.now(),
      presets,
    },
    null,
    2
  );
}

export function importPresetsFromJson(json: string): { imported: number; skipped: number } {
  const parsed = JSON.parse(json);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.presets)
      ? parsed.presets
      : [];

  let imported = 0;
  let skipped = 0;
  const existing = getAllPresets();
  const byId = new Map(existing.map((p) => [p.id, p]));

  for (const item of list) {
    if (!isValidPreset(item)) {
      skipped += 1;
      continue;
    }
    const next = ensureMatrix(item);
    byId.set(next.id, next);
    imported += 1;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(byId.values())));
  return { imported, skipped };
}

export function isPresetPersisted(id: string): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.some((p) => p?.id === id);
  } catch {
    return false;
  }
}

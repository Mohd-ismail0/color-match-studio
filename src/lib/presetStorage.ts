import { CalibrationPreset } from '@/types/colorCorrector';

const STORAGE_KEY = 'colorCorrector_presets';
const RECENT_KEY = 'colorCorrector_recentPresets';
const MAX_RECENT = 5;

function isValidPreset(value: unknown): value is CalibrationPreset {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Partial<CalibrationPreset>;
  return (
    typeof preset.id === 'string' &&
    typeof preset.name === 'string' &&
    Array.isArray(preset.points) &&
    (preset.mode === 'simple' || preset.mode === 'advanced')
  );
}

export function savePreset(preset: CalibrationPreset): void {
  const presets = getAllPresets();
  const existingIndex = presets.findIndex((p) => p.id === preset.id);
  const nextPreset: CalibrationPreset = {
    ...preset,
    updatedAt: Date.now(),
    createdAt: existingIndex >= 0 ? presets[existingIndex].createdAt : preset.createdAt || Date.now(),
  };

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
    return parsed.filter(isValidPreset);
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

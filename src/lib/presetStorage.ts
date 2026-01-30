import { CalibrationPreset } from '@/types/colorCorrector';

const STORAGE_KEY = 'colorCorrector_presets';
const RECENT_KEY = 'colorCorrector_recentPresets';
const MAX_RECENT = 5;

export function savePreset(preset: CalibrationPreset): void {
  const presets = getAllPresets();
  const existingIndex = presets.findIndex(p => p.id === preset.id);
  
  if (existingIndex >= 0) {
    presets[existingIndex] = { ...preset, updatedAt: Date.now() };
  } else {
    presets.push({ ...preset, createdAt: Date.now(), updatedAt: Date.now() });
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  addToRecent(preset.id);
}

export function getPreset(id: string): CalibrationPreset | null {
  const presets = getAllPresets();
  return presets.find(p => p.id === id) || null;
}

export function getAllPresets(): CalibrationPreset[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function deletePreset(id: string): void {
  const presets = getAllPresets().filter(p => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  removeFromRecent(id);
}

export function getRecentPresets(): CalibrationPreset[] {
  try {
    const recentIds: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const allPresets = getAllPresets();
    return recentIds
      .map(id => allPresets.find(p => p.id === id))
      .filter((p): p is CalibrationPreset => p !== undefined);
  } catch {
    return [];
  }
}

function addToRecent(id: string): void {
  try {
    let recentIds: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recentIds = recentIds.filter(rid => rid !== id);
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
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds.filter(rid => rid !== id)));
  } catch {
    // Ignore errors
  }
}

export function generatePresetId(): string {
  return `preset_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

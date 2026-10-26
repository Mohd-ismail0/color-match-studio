import type {
  CalibrationPreset,
  CalibrationProvenance,
  CalibrationRevision,
  ColorPoint,
  ColorPointRole,
  MatrixFitResult,
} from '@/types/colorCorrector';
import {
  calculateMatrixDetailed,
  inferPointRole,
  isValidColorMatrix,
} from '@/lib/colorCorrection';
import {
  ALGORITHM_VERSION,
  CALIBRATION_LIMITS,
  REVISION_SCHEMA_VERSION,
} from '@/lib/calibrationLimits';
import { revisionFingerprint, matrixFingerprint } from '@/lib/matrixFingerprint';
import { assessMatrix } from '@/lib/matrixValidation';

const STORAGE_KEY = 'colorCorrector_presets';
const RECENT_KEY = 'colorCorrector_recentPresets';
const MAX_RECENT = 5;

export class PresetStorageError extends Error {
  code: 'INVALID_PRESET' | 'STORAGE_FULL' | 'REVISION_LIMIT' | 'NOT_FOUND' | 'CORRUPT_STORAGE';

  constructor(code: PresetStorageError['code'], message: string) {
    super(message);
    this.name = 'PresetStorageError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export function isValidRgb(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'b,g,r') return false;
  const rgb = value as { r?: unknown; g?: unknown; b?: unknown };
  return [rgb.r, rgb.g, rgb.b].every((n) => isFiniteInRange(n, 0, 255));
}

const ROLES: ColorPointRole[] = ['white', 'grey', 'black', 'custom'];

function isValidRole(value: unknown): value is ColorPointRole {
  return typeof value === 'string' && ROLES.includes(value as ColorPointRole);
}

export function isValidPoint(value: unknown): value is ColorPoint {
  if (!isPlainObject(value)) return false;
  const point = value as Partial<ColorPoint>;
  return (
    typeof point.id === 'string' &&
    point.id.length > 0 &&
    point.id.length <= CALIBRATION_LIMITS.maxIdLength &&
    typeof point.label === 'string' &&
    point.label.length <= CALIBRATION_LIMITS.maxLabelLength &&
    isFiniteInRange(point.x, 0, 1) &&
    isFiniteInRange(point.y, 0, 1) &&
    isValidRgb(point.sampledColor) &&
    isValidRgb(point.targetColor) &&
    (point.role === undefined || isValidRole(point.role))
  );
}

export function isValidPoints(value: unknown): value is ColorPoint[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CALIBRATION_LIMITS.maxPoints &&
    value.every(isValidPoint)
  );
}

function normalizePoint(point: ColorPoint): ColorPoint {
  const role = point.role ?? inferPointRole(point.label);
  return { ...point, role };
}

function fallbackDiagnostics(
  mode: 'simple' | 'advanced',
  points: ColorPoint[],
  algorithmVersion: string
): CalibrationProvenance['diagnostics'] {
  return {
    mode,
    algorithmVersion,
    sampleCount: points.length,
    chromaticSamples: 0,
    conditioningRatio: null,
    minAnchorSeparation: null,
    clippingForecast: 0,
    saturationRetention: null,
    duplicateRoles: [],
    destructiveFallback: false,
  };
}

function buildRevision(
  revision: number,
  createdAt: number,
  points: ColorPoint[],
  matrix: CalibrationPreset['matrix'],
  mode: 'simple' | 'advanced',
  options: {
    source: CalibrationProvenance['source'];
    algorithmVersion?: string;
    fit?: MatrixFitResult;
    notes?: string[];
    profileId?: string;
    contentHash?: string;
  }
): CalibrationRevision {
  if (!matrix || !isValidColorMatrix(matrix)) {
    throw new PresetStorageError('INVALID_PRESET', 'Calibration matrix is not valid');
  }
  const algorithmVersion = options.algorithmVersion ?? ALGORITHM_VERSION;
  const normalizedPoints = points.map(normalizePoint);
  const fit =
    options.fit ??
    calculateMatrixDetailed(normalizedPoints, mode);

  // A stored revision must agree with the fit it claims to represent. Legacy
  // revisions are preserved as-is (their matrix predates this engine).
  const useFit = algorithmVersion === ALGORITHM_VERSION;
  if (useFit && matrixFingerprint(matrix) !== matrixFingerprint(fit.matrix)) {
    throw new PresetStorageError(
      'INVALID_PRESET',
      'The calibration matrix does not match the fit for these points and mode; re-fit before saving.'
    );
  }
  const storedMatrix = useFit ? fit.matrix : matrix;

  const fingerprint = revisionFingerprint({
    algorithmVersion,
    mode,
    points: normalizedPoints,
    matrix: storedMatrix,
  });

  return {
    revision,
    createdAt,
    points: normalizedPoints,
    matrix: storedMatrix,
    mode,
    algorithmVersion,
    fingerprint,
    contentHash: options.contentHash,
    provenance: {
      source: options.source,
      algorithmVersion,
      engineVersion: ALGORITHM_VERSION,
      warnings: fit?.warnings ?? [],
      diagnostics: fit?.diagnostics ?? fallbackDiagnostics(mode, normalizedPoints, algorithmVersion),
      notes: options.notes,
      profileId: options.profileId,
      createdAt,
    },
  };
}

export function isRevisionContentIntact(revision: CalibrationRevision): boolean {
  try {
    const fingerprint = revisionFingerprint({
      algorithmVersion: revision.algorithmVersion,
      mode: revision.mode,
      points: revision.points,
      matrix: revision.matrix,
    });
    return fingerprint === revision.fingerprint;
  } catch {
    return false;
  }
}

function isValidRevision(value: unknown): value is CalibrationRevision {
  if (!isPlainObject(value)) return false;
  const revision = value as Partial<CalibrationRevision>;
  if (
    !Number.isInteger(revision.revision) ||
    (revision.revision as number) < 1 ||
    !isFiniteInRange(revision.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isValidPoints(revision.points) ||
    (revision.mode !== 'simple' && revision.mode !== 'advanced') ||
    typeof revision.algorithmVersion !== 'string' ||
    revision.algorithmVersion.length === 0 ||
    revision.algorithmVersion.length > 32 ||
    typeof revision.fingerprint !== 'string' ||
    !/^[0-9a-f]{16}$/.test(revision.fingerprint) ||
    !isValidColorMatrix(revision.matrix) ||
    !isPlainObject(revision.provenance)
  ) {
    return false;
  }
  const provenance = revision.provenance as unknown as CalibrationProvenance;
  if (
    provenance.source !== 'browser' &&
    provenance.source !== 'api' &&
    provenance.source !== 'import'
  ) {
    return false;
  }
  if (
    !Array.isArray(provenance.warnings) ||
    provenance.warnings.length > 100 ||
    !provenance.warnings.every((w) => typeof w === 'string' && w.length <= 500) ||
    !provenance.diagnostics
  ) {
    return false;
  }
  if (
    provenance.notes !== undefined &&
    (!Array.isArray(provenance.notes) ||
      provenance.notes.length > CALIBRATION_LIMITS.maxNotes ||
      !provenance.notes.every(
        (note) => typeof note === 'string' && note.length <= CALIBRATION_LIMITS.maxNoteLength
      ))
  ) {
    return false;
  }
  const typed = revision as CalibrationRevision;
  return typed.points.every(isValidPoint) && isRevisionContentIntact(typed);
}

function isValidPreset(value: unknown): value is CalibrationPreset {
  if (!isPlainObject(value)) return false;
  const preset = value as Partial<CalibrationPreset>;
  if (
    typeof preset.id !== 'string' ||
    preset.id.length === 0 ||
    preset.id.length > 128 ||
    typeof preset.name !== 'string' ||
    preset.name.length === 0 ||
    preset.name.length > CALIBRATION_LIMITS.maxNameLength ||
    !isFiniteInRange(preset.createdAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isFiniteInRange(preset.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isValidPoints(preset.points) ||
    (preset.mode !== 'simple' && preset.mode !== 'advanced') ||
    !(preset.matrix === null || preset.matrix === undefined || isValidColorMatrix(preset.matrix))
  ) {
    return false;
  }
  if (preset.revisions !== undefined) {
    if (!Array.isArray(preset.revisions) || preset.revisions.length > CALIBRATION_LIMITS.maxRevisionsPerProfile) {
      return false;
    }
    if (!preset.revisions.every(isValidRevision)) return false;
    const numbers = new Set<number>();
    for (const revision of preset.revisions) {
      if (numbers.has(revision.revision)) return false;
      numbers.add(revision.revision);
    }
  }
  return true;
}

function matrixDestructiveReason(matrix: CalibrationPreset['matrix']): string | null {
  if (!matrix || !isValidColorMatrix(matrix)) return null;
  const assessment = assessMatrix(matrix);
  return assessment.destructive ? assessment.reasons.join('; ') : null;
}

/**
 * Guardrail used by import and batch apply: a revision whose matrix would
 * destroy colour data must never be applied as a usable correction.
 */
export function destructiveRevisionReason(revision: CalibrationRevision): string | null {
  return matrixDestructiveReason(revision.matrix);
}

function destructivePresetReason(preset: CalibrationPreset): string | null {
  for (const revision of preset.revisions ?? []) {
    const reason = destructiveRevisionReason(revision);
    if (reason) return reason;
  }
  return matrixDestructiveReason(preset.matrix);
}

/** Migrate a v1 preset (matrix, no revisions) to an immutable revision. */
function migratePreset(input: CalibrationPreset): CalibrationPreset {
  const points = input.points.map(normalizePoint);
  const revisions = Array.isArray(input.revisions) ? [...input.revisions] : [];

  if (revisions.length === 0 && isValidColorMatrix(input.matrix)) {
    const createdAt = input.createdAt || Date.now();
    revisions.push(
      buildRevision(1, createdAt, points, input.matrix, input.mode, {
        source: 'import',
        algorithmVersion: 'legacy-1',
        notes: ['Migrated from an unversioned preset; matrix preserved as-is.'],
      })
    );
  }

  const sorted = revisions.sort((a, b) => a.revision - b.revision);
  const currentRevision =
    typeof input.currentRevision === 'number' &&
    sorted.some((r) => r.revision === input.currentRevision)
      ? input.currentRevision
      : sorted.length > 0
        ? sorted[sorted.length - 1].revision
        : undefined;
  const current = sorted.find((r) => r.revision === currentRevision);

  return {
    ...input,
    schemaVersion: REVISION_SCHEMA_VERSION,
    points,
    matrix: current?.matrix ?? (isValidColorMatrix(input.matrix) ? input.matrix : null),
    mode: current?.mode ?? input.mode,
    revisions: sorted,
    currentRevision,
    createdAt: input.createdAt || Date.now(),
    updatedAt: input.updatedAt || Date.now(),
  };
}

function persist(presets: unknown[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    throw new PresetStorageError(
      'STORAGE_FULL',
      'Browser storage is full. Delete unused presets or export a backup.'
    );
  }
}

function corruptStorageError(): PresetStorageError {
  return new PresetStorageError(
    'CORRUPT_STORAGE',
    'Saved presets could not be read. Nothing was overwritten; export the raw data or reset local storage before saving again.'
  );
}

function readRawPresets(options: { strict?: boolean } = {}): unknown[] {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    if (options.strict) throw corruptStorageError();
    return [];
  }
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed;
    if (options.strict) throw corruptStorageError();
    return [];
  } catch (error) {
    if (error instanceof PresetStorageError) throw error;
    if (options.strict) throw corruptStorageError();
    return [];
  }
}

/** Raw localStorage value, for recovery/export when records are unreadable. */
export function getRawPresetStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Records that exist in storage but no longer pass validation. */
export function getQuarantinedPresets(): unknown[] {
  return readRawPresets().filter((entry) => !isValidPreset(entry));
}

export function getQuarantinedPresetCount(): number {
  return getQuarantinedPresets().length;
}

/** True when the stored container itself is unreadable (writes fail closed). */
export function isPresetStorageCorrupt(): boolean {
  const stored = getRawPresetStorage();
  if (!stored) return false;
  try {
    return !Array.isArray(JSON.parse(stored));
  } catch {
    return true;
  }
}

export function exportQuarantinedPresetsToJson(): string {
  return JSON.stringify(
    {
      version: REVISION_SCHEMA_VERSION,
      exportedAt: Date.now(),
      quarantined: getQuarantinedPresets(),
    },
    null,
    2
  );
}

function validPresetsFrom(raw: unknown[]): CalibrationPreset[] {
  return raw.filter(isValidPreset).map(migratePreset);
}

export function getAllPresets(): CalibrationPreset[] {
  return validPresetsFrom(readRawPresets());
}

/**
 * Persist the valid preset list while keeping every unreadable raw record
 * verbatim. A read-filter-write cycle must never delete data it could not
 * parse; only records the caller deliberately removed are dropped.
 */
function writePresets(next: CalibrationPreset[], raw: unknown[]): void {
  const byId = new Map(next.map((preset) => [preset.id, preset]));
  const written = new Set<string>();
  const out: unknown[] = [];

  for (const entry of raw) {
    if (isValidPreset(entry)) {
      const replacement = byId.get(entry.id);
      if (replacement && !written.has(entry.id)) {
        out.push(replacement);
        written.add(entry.id);
      }
      continue;
    }
    out.push(entry);
  }

  for (const preset of next) {
    if (written.has(preset.id)) continue;
    out.push(preset);
    written.add(preset.id);
  }

  persist(out);
}

export function getPreset(id: string): CalibrationPreset | null {
  return getAllPresets().find((p) => p.id === id) || null;
}

/** Explicit revision lookup. There is no "latest" fallback. */
export function getPresetRevision(presetId: string, revision: number): CalibrationRevision | null {
  if (!Number.isInteger(revision) || revision < 1) return null;
  const preset = getPreset(presetId);
  return preset?.revisions?.find((r) => r.revision === revision) ?? null;
}

export function getLatestRevision(preset: CalibrationPreset): CalibrationRevision | null {
  const revisions = preset.revisions ?? [];
  return revisions.length === 0 ? null : revisions[revisions.length - 1];
}

function fitFor(points: ColorPoint[], mode: 'simple' | 'advanced'): MatrixFitResult {
  return calculateMatrixDetailed(points, mode);
}

/**
 * Append an immutable revision. Saving identical content returns the existing
 * preset unchanged (idempotent) instead of creating duplicate revisions.
 */
export function savePreset(preset: CalibrationPreset): CalibrationPreset {
  if (!presetNameIsValid(preset.name)) {
    throw new PresetStorageError('INVALID_PRESET', 'Preset name is required and must be ≤120 characters');
  }
  if (!isValidPoints(preset.points)) {
    throw new PresetStorageError(
      'INVALID_PRESET',
      `Presets need 1–${CALIBRATION_LIMITS.maxPoints} valid calibration points`
    );
  }
  if (!isValidColorMatrix(preset.matrix)) {
    throw new PresetStorageError('INVALID_PRESET', 'Calibration matrix is not valid');
  }

  const raw = readRawPresets({ strict: true });
  const presets = validPresetsFrom(raw);
  const existingIndex = presets.findIndex((p) => p.id === preset.id);
  const existing = existingIndex >= 0 ? presets[existingIndex] : null;
  const fit = fitFor(preset.points, preset.mode);
  const now = Date.now();

  const nextRevisionNumber =
    (existing?.revisions?.reduce((max, r) => Math.max(max, r.revision), 0) ?? 0) + 1;
  if (
    existing &&
    (existing.revisions?.length ?? 0) >= CALIBRATION_LIMITS.maxRevisionsPerProfile
  ) {
    throw new PresetStorageError(
      'REVISION_LIMIT',
      `This preset has reached the ${CALIBRATION_LIMITS.maxRevisionsPerProfile}-revision limit. Create a new preset.`
    );
  }

  const revision = buildRevision(
    nextRevisionNumber,
    now,
    preset.points,
    preset.matrix,
    preset.mode,
    { source: 'browser', fit }
  );

  const latest = existing?.revisions?.[existing.revisions.length - 1];
  if (latest && latest.fingerprint === revision.fingerprint) {
    const unchanged: CalibrationPreset = {
      ...(existing as CalibrationPreset),
      name: preset.name.trim(),
      currentRevision: latest.revision,
    };
    if (existingIndex >= 0) presets[existingIndex] = unchanged;
    writePresets(presets, raw);
    addToRecent(unchanged.id);
    return unchanged;
  }

  const next: CalibrationPreset = {
    id: preset.id,
    name: preset.name.trim(),
    createdAt: existing?.createdAt ?? preset.createdAt ?? now,
    updatedAt: now,
    points: revision.points,
    matrix: revision.matrix,
    mode: revision.mode,
    schemaVersion: REVISION_SCHEMA_VERSION,
    currentRevision: revision.revision,
    revisions: [...(existing?.revisions ?? []), revision],
  };

  if (existingIndex >= 0) presets[existingIndex] = next;
  else presets.push(next);

  writePresets(presets, raw);
  addToRecent(next.id);
  return next;
}

function presetNameIsValid(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.trim().length <= CALIBRATION_LIMITS.maxNameLength
  );
}

export function deletePreset(id: string): void {
  const raw = readRawPresets({ strict: true });
  writePresets(
    validPresetsFrom(raw).filter((p) => p.id !== id),
    raw
  );
  removeFromRecent(id);
}

export function getRecentPresets(): CalibrationPreset[] {
  try {
    const recentIds: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(recentIds)) return [];
    const allPresets = getAllPresets();
    return recentIds
      .filter((id): id is string => typeof id === 'string')
      .map((id) => allPresets.find((p) => p.id === id))
      .filter((p): p is CalibrationPreset => p !== undefined);
  } catch {
    return [];
  }
}

function addToRecent(id: string): void {
  try {
    let recentIds: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(recentIds)) recentIds = [];
    const ids = (recentIds as unknown[]).filter((rid): rid is string => typeof rid === 'string');
    const next = [id, ...ids.filter((rid) => rid !== id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([id]));
    } catch {
      // Recent list is non-critical; ignore quota failures.
    }
  }
}

function removeFromRecent(id: string): void {
  try {
    const recentIds: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(recentIds)) return;
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify((recentIds as unknown[]).filter((rid) => rid !== id))
    );
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
      version: REVISION_SCHEMA_VERSION,
      exportedAt: Date.now(),
      presets,
    },
    null,
    2
  );
}

export function importPresetsFromJson(json: string): { imported: number; skipped: number } {
  const parsed: unknown = JSON.parse(json);
  if (isPlainObject(parsed) && parsed.version !== undefined) {
    if (parsed.version !== 1 && parsed.version !== REVISION_SCHEMA_VERSION) {
      throw new PresetStorageError(
        'INVALID_PRESET',
        `Unsupported preset schema version: ${String(parsed.version)}`
      );
    }
  }

  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.presets)
      ? parsed.presets
      : [];

  if (list.length > CALIBRATION_LIMITS.maxProfilesPerStore) {
    throw new PresetStorageError('INVALID_PRESET', 'Preset file is too large');
  }

  let imported = 0;
  let skipped = 0;
  const raw = readRawPresets({ strict: true });
  const byId = new Map(validPresetsFrom(raw).map((p) => [p.id, p]));

  for (const item of list) {
    if (!isValidPreset(item)) {
      skipped += 1;
      continue;
    }
    // Imports bypass the save path, so apply the same colour guardrail here:
    // never store a preset whose revision would destroy image data.
    if (destructivePresetReason(item)) {
      skipped += 1;
      continue;
    }
    const next = migratePreset(item);
    byId.set(next.id, next);
    imported += 1;
  }

  writePresets(Array.from(byId.values()), raw);
  return { imported, skipped };
}

export function isPresetPersisted(id: string): boolean {
  return readRawPresets().some((p) => isPlainObject(p) && p.id === id);
}

/** Convert a server revision into a local preset-shaped selection. */
export function presetFromRemoteRevision(input: {
  profileId: string;
  profileName: string;
  updatedAt: number;
  revision: CalibrationRevision;
}): CalibrationPreset {
  return {
    id: `api:${input.profileId}`,
    name: input.profileName,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    points: input.revision.points,
    matrix: input.revision.matrix,
    mode: input.revision.mode,
    schemaVersion: REVISION_SCHEMA_VERSION,
    currentRevision: input.revision.revision,
    revisions: [input.revision],
  };
}

/**
 * Build an in-memory preset with one explicit revision for the
 * "preview → apply to batch" flow when the user has not saved yet.
 */
export function buildTransientPreset(input: {
  name: string;
  points: ColorPoint[];
  matrix: CalibrationPreset['matrix'];
  mode: 'simple' | 'advanced';
}): CalibrationPreset {
  const now = Date.now();
  const id = `transient_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const revision = buildRevision(1, now, input.points, input.matrix, input.mode, {
    source: 'browser',
    fit: fitFor(input.points, input.mode),
  });
  return {
    id,
    name: input.name.trim() || 'Unsaved Preset',
    createdAt: now,
    updatedAt: now,
    points: revision.points,
    matrix: revision.matrix,
    mode: revision.mode,
    schemaVersion: REVISION_SCHEMA_VERSION,
    currentRevision: revision.revision,
    revisions: [revision],
  };
}

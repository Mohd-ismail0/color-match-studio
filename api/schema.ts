import type { ColorMatrix, ColorPoint, ColorPointRole } from '../src/types/colorCorrector';
import { CALIBRATION_LIMITS, IMAGE_LIMITS, MATRIX_LIMITS } from '../src/lib/calibrationLimits';
import { ApiError } from './errors';
import { IDEMPOTENCY_KEY_PATTERN } from './storeContract';

export interface CreateCalibrationInput {
  name: string;
  points: ColorPoint[];
  mode: 'simple' | 'advanced';
  matrix?: ColorMatrix;
  algorithmVersion?: string;
  notes?: string[];
}

export interface AppendRevisionInput {
  points: ColorPoint[];
  mode: 'simple' | 'advanced';
  matrix?: ColorMatrix;
  algorithmVersion?: string;
  notes?: string[];
}

export interface CorrectInput {
  imageBase64: string;
  matrix?: ColorMatrix;
  calibration?: { profileId: string; revision: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ApiError(422, 'INVALID_REQUEST', message);
}

function expectExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  required: string[] = []
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) invalid(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  const missing = required.filter((k) => !(k in value));
  if (missing.length > 0) invalid(`${label} is missing: ${missing.join(', ')}`);
}

export function parseName(value: unknown): string {
  if (typeof value !== 'string') invalid('name must be a string');
  const name = value.trim();
  if (name.length === 0 || name.length > CALIBRATION_LIMITS.maxNameLength) {
    invalid(`name must be 1–${CALIBRATION_LIMITS.maxNameLength} characters`);
  }
  return name;
}

export function parseMode(value: unknown): 'simple' | 'advanced' {
  if (value !== 'simple' && value !== 'advanced') invalid('mode must be "simple" or "advanced"');
  return value;
}

export function parseRgb(value: unknown, label: string): { r: number; g: number; b: number } {
  if (!isPlainObject(value)) invalid(`${label} must be an object`);
  expectExactKeys(value, ['r', 'g', 'b'], label, ['r', 'g', 'b']);
  const out = { r: value.r, g: value.g, b: value.b };
  for (const channel of ['r', 'g', 'b'] as const) {
    const n = out[channel];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 255) {
      invalid(`${label}.${channel} must be an integer 0–255`);
    }
  }
  return out as { r: number; g: number; b: number };
}

const ROLES: ColorPointRole[] = ['white', 'grey', 'black', 'custom'];

export function parsePoints(value: unknown): ColorPoint[] {
  if (!Array.isArray(value)) invalid('points must be an array');
  if (value.length === 0 || value.length > CALIBRATION_LIMITS.maxPoints) {
    invalid(`points must contain 1–${CALIBRATION_LIMITS.maxPoints} entries`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) invalid(`points[${index}] must be an object`);
    expectExactKeys(
      item,
      ['id', 'label', 'role', 'x', 'y', 'sampledColor', 'targetColor'],
      `points[${index}]`,
      ['id', 'label', 'x', 'y', 'sampledColor', 'targetColor']
    );
    if (
      typeof item.id !== 'string' ||
      item.id.length === 0 ||
      item.id.length > CALIBRATION_LIMITS.maxIdLength
    ) {
      invalid(`points[${index}].id must be a 1–${CALIBRATION_LIMITS.maxIdLength} character string`);
    }
    if (
      typeof item.label !== 'string' ||
      item.label.trim().length === 0 ||
      item.label.length > CALIBRATION_LIMITS.maxLabelLength
    ) {
      invalid(`points[${index}].label must be 1–${CALIBRATION_LIMITS.maxLabelLength} characters`);
    }
    for (const coordinate of ['x', 'y'] as const) {
      const n = item[coordinate];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
        invalid(`points[${index}].${coordinate} must be a finite number in [0,1]`);
      }
    }
    let role: ColorPointRole | undefined;
    if (item.role !== undefined) {
      if (typeof item.role !== 'string' || !ROLES.includes(item.role as ColorPointRole)) {
        invalid(`points[${index}].role is invalid`);
      }
      role = item.role as ColorPointRole;
    }
    return {
      id: item.id,
      label: item.label,
      role,
      x: item.x as number,
      y: item.y as number,
      sampledColor: parseRgb(item.sampledColor, `points[${index}].sampledColor`),
      targetColor: parseRgb(item.targetColor, `points[${index}].targetColor`),
    };
  });
}

export function parseMatrix(value: unknown): ColorMatrix {
  if (!isPlainObject(value)) invalid('matrix must be an object');
  expectExactKeys(value, ['matrix', 'offset'], 'matrix', ['matrix', 'offset']);
  const rows = value.matrix;
  if (!Array.isArray(rows) || rows.length !== 3) invalid('matrix.matrix must be a 3x3 array');
  const parsedRows = rows.map((row, r) => {
    if (!Array.isArray(row) || row.length !== 3) invalid(`matrix.matrix[${r}] must have 3 entries`);
    return row.map((n, c) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        invalid(`matrix.matrix[${r}][${c}] must be a finite number`);
      }
      if (Math.abs(n) > MATRIX_LIMITS.maxAbsCoefficient) {
        invalid(`matrix.matrix[${r}][${c}] exceeds the coefficient limit`);
      }
      return n;
    });
  });
  if (!isPlainObject(value.offset)) invalid('matrix.offset must be an object');
  expectExactKeys(value.offset, ['r', 'g', 'b'], 'matrix.offset', ['r', 'g', 'b']);
  const offset = { r: value.offset.r, g: value.offset.g, b: value.offset.b };
  for (const channel of ['r', 'g', 'b'] as const) {
    const n = offset[channel];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      invalid(`matrix.offset.${channel} must be a finite number`);
    }
    if (Math.abs(n) > MATRIX_LIMITS.maxAbsOffset) {
      invalid(`matrix.offset.${channel} exceeds the offset limit`);
    }
  }
  return { matrix: parsedRows, offset: offset as { r: number; g: number; b: number } };
}

export function parseNotes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CALIBRATION_LIMITS.maxNotes) {
    invalid(`notes must be an array of at most ${CALIBRATION_LIMITS.maxNotes} strings`);
  }
  return value.map((note) => {
    if (typeof note !== 'string' || note.length > CALIBRATION_LIMITS.maxNoteLength) {
      invalid(`notes entries must be strings of at most ${CALIBRATION_LIMITS.maxNoteLength} characters`);
    }
    return note;
  });
}

export function parseAlgorithmVersion(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) {
    invalid('algorithmVersion must be a string of at most 32 characters');
  }
  return value;
}

/**
 * Optional `Idempotency-Key` header. Replaying a create/append with the same
 * key returns the originally stored revision instead of adding a new one.
 */
export function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const key = raw?.trim();
  if (!key) invalid('Idempotency-Key must not be empty');
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    invalid('Idempotency-Key must be 8–200 characters of A–Z, a–z, 0–9, ".", "_", ":" or "-"');
  }
  return key;
}

export function parseCreateCalibration(body: unknown): CreateCalibrationInput {
  if (!isPlainObject(body)) invalid('body must be a JSON object');
  expectExactKeys(
    body,
    ['name', 'points', 'mode', 'matrix', 'algorithmVersion', 'notes'],
    'body',
    ['name', 'points', 'mode']
  );
  return {
    name: parseName(body.name),
    points: parsePoints(body.points),
    mode: parseMode(body.mode),
    matrix: body.matrix === undefined ? undefined : parseMatrix(body.matrix),
    algorithmVersion: parseAlgorithmVersion(body.algorithmVersion),
    notes: parseNotes(body.notes),
  };
}

export function parseAppendRevision(body: unknown): AppendRevisionInput {
  if (!isPlainObject(body)) invalid('body must be a JSON object');
  expectExactKeys(
    body,
    ['points', 'mode', 'matrix', 'algorithmVersion', 'notes'],
    'body',
    ['points', 'mode']
  );
  return {
    points: parsePoints(body.points),
    mode: parseMode(body.mode),
    matrix: body.matrix === undefined ? undefined : parseMatrix(body.matrix),
    algorithmVersion: parseAlgorithmVersion(body.algorithmVersion),
    notes: parseNotes(body.notes),
  };
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseCorrect(body: unknown): CorrectInput {
  if (!isPlainObject(body)) invalid('body must be a JSON object');
  expectExactKeys(body, ['imageBase64', 'matrix', 'calibration'], 'body', ['imageBase64']);

  const imageBase64 = body.imageBase64;
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    invalid('imageBase64 must be a non-empty base64 string');
  }
  if (imageBase64.length > Math.ceil(IMAGE_LIMITS.maxInputBytes / 3) * 4 + 4) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'imageBase64 is too large');
  }
  if (imageBase64.length % 4 !== 0 || !BASE64_PATTERN.test(imageBase64)) {
    invalid('imageBase64 is not valid base64');
  }

  const hasMatrix = body.matrix !== undefined;
  const hasCalibration = body.calibration !== undefined;
  if (hasMatrix === hasCalibration) {
    invalid('provide exactly one of "matrix" or "calibration"');
  }

  if (hasMatrix) {
    return { imageBase64, matrix: parseMatrix(body.matrix) };
  }

  const calibration = body.calibration;
  if (!isPlainObject(calibration)) invalid('calibration must be an object');
  expectExactKeys(calibration, ['profileId', 'revision'], 'calibration', ['profileId', 'revision']);
  const profileId = calibration.profileId;
  if (typeof profileId !== 'string' || !/^cal_[a-z0-9_]{1,60}$/.test(profileId)) {
    invalid('calibration.profileId is invalid');
  }
  const revision = calibration.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > 1e9) {
    invalid('calibration.revision must be a positive integer');
  }
  return { imageBase64, calibration: { profileId, revision: revision as number } };
}

/** Canonical base64 check: libvips/Node silently drop invalid characters. */
export function decodeBase64Strict(value: string): Buffer {
  const buffer = Buffer.from(value, 'base64');
  const normalized = buffer.toString('base64').replace(/=+$/, '');
  if (normalized !== value.replace(/=+$/, '')) {
    invalid('imageBase64 is not canonical base64');
  }
  return buffer;
}

import type { ColorMatrix, ColorPoint } from '@/types/colorCorrector';
import { ALGORITHM_VERSION } from './calibrationLimits';

/**
 * Deterministic content fingerprints for calibration revisions.
 *
 * These are content-corruption / stale-cache detectors, not cryptographic
 * signatures. The API additionally stores a SHA-256 of the canonical revision
 * payload for integrity at rest.
 */

function normalizeNumber(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  if (Object.is(n, -0)) return 0;
  // 12 significant digits is far below 8-bit/16-bit quantisation but stable
  // across JS engines and JSON round-trips.
  return Number(n.toPrecision(12));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') return normalizeNumber(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const next = canonicalize((value as Record<string, unknown>)[key]);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return value;
}

/** Stable JSON: sorted keys, normalised numbers, no whitespace. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** FNV-1a 64-bit over UTF-8 bytes, rendered as 16 hex chars. */
export function fnv1a64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export interface RevisionContent {
  algorithmVersion: string;
  mode: 'simple' | 'advanced';
  points: ColorPoint[];
  matrix: ColorMatrix;
}

export function revisionContentFor(
  points: ColorPoint[],
  matrix: ColorMatrix,
  mode: 'simple' | 'advanced',
  algorithmVersion: string = ALGORITHM_VERSION
): RevisionContent {
  return { algorithmVersion, mode, points, matrix };
}

/** Canonical payload hashed by the server (SHA-256) and fingerprinted locally. */
export function canonicalRevisionPayload(content: RevisionContent): string {
  return stableStringify({
    algorithmVersion: content.algorithmVersion,
    mode: content.mode,
    matrix: {
      matrix: content.matrix.matrix,
      offset: { r: content.matrix.offset.r, g: content.matrix.offset.g, b: content.matrix.offset.b },
    },
    points: content.points.map((p) => ({
      id: p.id,
      label: p.label,
      role: p.role ?? null,
      x: p.x,
      y: p.y,
      sampledColor: { r: p.sampledColor.r, g: p.sampledColor.g, b: p.sampledColor.b },
      targetColor: { r: p.targetColor.r, g: p.targetColor.g, b: p.targetColor.b },
    })),
  });
}

export function revisionFingerprint(content: RevisionContent): string {
  return fnv1a64(canonicalRevisionPayload(content));
}

/** Short fingerprint of a matrix alone (used by stale batch detection). */
export function matrixFingerprint(
  matrix: ColorMatrix,
  algorithmVersion: string = ALGORITHM_VERSION
): string {
  return fnv1a64(
    stableStringify({
      algorithmVersion,
      matrix: matrix.matrix,
      offset: { r: matrix.offset.r, g: matrix.offset.g, b: matrix.offset.b },
    })
  );
}

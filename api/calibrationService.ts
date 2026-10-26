import { createHash } from 'node:crypto';
import type { CalibrationProvenance, ColorMatrix, ColorPoint } from '../src/types/colorCorrector';
import {
  ALGORITHM_VERSION,
} from '../src/lib/calibrationLimits';
import { calculateMatrixDetailed } from '../src/lib/colorCorrection';
import { matrixFingerprint, revisionFingerprint } from '../src/lib/matrixFingerprint';
import { assessMatrix, validateColorMatrix } from '../src/lib/matrixValidation';
import { canonicalRevisionPayload } from '../src/lib/matrixFingerprint';
import { ApiError } from './errors';
import type { RevisionDraft, StoredRevision } from './store';
import type { AppendRevisionInput, CreateCalibrationInput } from './schema';

export interface RevisionProvenanceInput {
  notes?: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Exact stored-vs-refit matrix comparison (SQLite REAL round-trips IEEE doubles). */
function matricesEqual(a: ColorMatrix, b: ColorMatrix): boolean {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (a.matrix[row][col] !== b.matrix[row][col]) return false;
    }
  }
  return (
    a.offset.r === b.offset.r &&
    a.offset.g === b.offset.g &&
    a.offset.b === b.offset.b
  );
}

export function buildRevisionDraft(
  input: {
    points: ColorPoint[];
    mode: 'simple' | 'advanced';
    matrix?: ColorMatrix;
    algorithmVersion?: string;
    notes?: string[];
  },
  source: CalibrationProvenance['source'] = 'api'
): RevisionDraft {
  if (input.algorithmVersion && input.algorithmVersion !== ALGORITHM_VERSION) {
    throw new ApiError(
      409,
      'ALGORITHM_VERSION_MISMATCH',
      `Server algorithm version is ${ALGORITHM_VERSION}; request specified ${input.algorithmVersion}`
    );
  }

  const fit = calculateMatrixDetailed(input.points, input.mode);
  const matrix = fit.matrix;
  const validation = validateColorMatrix(matrix);
  if (!validation.ok) {
    throw new ApiError(422, 'MATRIX_REJECTED', validation.errors.join('; '));
  }

  if (input.matrix) {
    const supplied = matrixFingerprint(input.matrix);
    const canonical = matrixFingerprint(matrix);
    if (supplied !== canonical) {
      throw new ApiError(
        409,
        'MATRIX_MISMATCH',
        'The supplied matrix does not match the server-side fit for these points, mode and algorithm version.'
      );
    }
  }

  const assessment = assessMatrix(matrix);
  if (assessment.destructive) {
    throw new ApiError(
      422,
      'MATRIX_REJECTED',
      `Calibration would destroy colour data (${assessment.reasons.join('; ')})`
    );
  }

  // The engine substitutes an identity matrix when the requested fit would
  // destroy data. That is a useful browser preview, but it is not a usable
  // correction: never persist it as one.
  if (fit.diagnostics.destructiveFallback) {
    throw new ApiError(
      422,
      'MATRIX_REJECTED',
      `No usable correction can be derived from these points without destroying colour data (${
        fit.warnings.join(' ') || 'engine used an identity fallback'
      })`
    );
  }

  const fingerprint = revisionFingerprint({
    algorithmVersion: ALGORITHM_VERSION,
    mode: input.mode,
    points: input.points,
    matrix,
  });
  const contentHash = sha256(
    canonicalRevisionPayload({
      algorithmVersion: ALGORITHM_VERSION,
      mode: input.mode,
      points: input.points,
      matrix,
    })
  );

  return {
    points: input.points,
    matrix,
    mode: input.mode,
    algorithmVersion: ALGORITHM_VERSION,
    fingerprint,
    contentHash,
    meanResidual: fit.meanResidual,
    provenance: {
      source,
      algorithmVersion: ALGORITHM_VERSION,
      engineVersion: ALGORITHM_VERSION,
      warnings: fit.warnings,
      diagnostics: fit.diagnostics,
      notes: input.notes,
    },
  };
}

export function draftFromCreate(input: CreateCalibrationInput): RevisionDraft {
  return buildRevisionDraft(input, 'api');
}

export function draftFromAppend(input: AppendRevisionInput): RevisionDraft {
  return buildRevisionDraft(input, 'api');
}

/**
 * Verify a revision read back from storage: content hash, matrix fingerprint
 * and guardrails. Detects tampering (the SQL triggers block updates, this is
 * defence in depth) and threshold regressions.
 */
export function verifyStoredRevision(revision: StoredRevision): void {
  const canonical = canonicalRevisionPayload({
    algorithmVersion: revision.algorithmVersion,
    mode: revision.mode,
    points: revision.points,
    matrix: revision.matrix,
  });
  const hash = sha256(canonical);
  if (hash !== revision.contentHash) {
    throw new ApiError(500, 'REVISION_INTEGRITY', 'Stored calibration revision failed its content hash check.');
  }

  const validation = validateColorMatrix(revision.matrix);
  if (!validation.ok) {
    throw new ApiError(500, 'REVISION_INTEGRITY', 'Stored calibration matrix is invalid.');
  }

  if (revision.algorithmVersion === ALGORITHM_VERSION) {
    const fit = calculateMatrixDetailed(revision.points, revision.mode);

    // Bind the stored matrix to the stored points. The content hash alone is
    // unkeyed, so a rewritten row can carry a recomputed hash; the matrix must
    // still be exactly the matrix this engine derives from these points.
    if (!matricesEqual(revision.matrix, fit.matrix)) {
      throw new ApiError(
        500,
        'REVISION_INTEGRITY',
        'Stored calibration matrix does not match the engine fit for its stored points.'
      );
    }

    // An identity fallback is a browser preview, never a usable correction.
    if (fit.diagnostics.destructiveFallback) {
      throw new ApiError(
        500,
        'REVISION_REJECTED',
        'Stored calibration has no usable correction: the engine fit would destroy colour data.'
      );
    }

    const fingerprint = revisionFingerprint({
      algorithmVersion: revision.algorithmVersion,
      mode: revision.mode,
      points: revision.points,
      matrix: fit.matrix,
    });
    if (fingerprint !== revision.fingerprint) {
      throw new ApiError(
        500,
        'REVISION_INTEGRITY',
        'Stored calibration revision no longer reproduces under this engine version.'
      );
    }
  }

  const assessment = assessMatrix(revision.matrix);
  if (assessment.destructive) {
    throw new ApiError(
      500,
      'REVISION_REJECTED',
      `Stored calibration fails the colour guardrail (${assessment.reasons.join('; ')})`
    );
  }
}

export function serializeRevision(revision: StoredRevision) {
  return {
    profileId: revision.profileId,
    revision: revision.revision,
    createdAt: revision.createdAt,
    points: revision.points,
    matrix: revision.matrix,
    mode: revision.mode,
    algorithmVersion: revision.algorithmVersion,
    fingerprint: revision.fingerprint,
    contentHash: revision.contentHash,
    meanResidual: revision.meanResidual,
    provenance: revision.provenance,
  };
}

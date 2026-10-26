import type {
  BatchImage,
  CalibrationSelection,
  ExportSettings,
} from '@/types/colorCorrector';

/**
 * Staleness is defined against the exact revision + matrix fingerprint that
 * produced a result (audit C11). A re-calibration saved under the same preset
 * id now invalidates old results.
 */
export function isProcessedResultStale(
  processedWith: NonNullable<BatchImage['processedWith']> | undefined,
  selection: CalibrationSelection | null,
  exportSettings: ExportSettings
): boolean {
  if (!processedWith) return true;
  if (!selection) return true;
  if (processedWith.presetId !== selection.presetId) return true;
  if (processedWith.revision !== selection.revision.revision) return true;
  if (processedWith.fingerprint !== selection.revision.fingerprint) return true;
  if (processedWith.format !== exportSettings.format) return true;
  if (
    exportSettings.format === 'jpeg' &&
    Math.abs(processedWith.quality - exportSettings.quality) > 0.001
  ) {
    return true;
  }
  return false;
}

export function hasStaleCompletedResults(
  images: BatchImage[],
  selection: CalibrationSelection | null,
  exportSettings: ExportSettings
): boolean {
  return images.some(
    (img) => img.status === 'completed' && isProcessedResultStale(img.processedWith, selection, exportSettings)
  );
}

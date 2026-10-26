import { useState, useCallback, useEffect, useRef } from 'react';
import {
  BatchImage,
  CalibrationSelection,
  ExportSettings,
  ProcessingProgress,
} from '@/types/colorCorrector';
import {
  loadImageToCanvas,
  applyColorCorrectionToImage,
  canvasToBlob,
  extensionForFormat,
  formatFromMime,
} from '@/lib/colorCorrection';
import {
  hasStaleCompletedResults,
  isProcessedResultStale,
} from '@/lib/batchStaleness';
import { destructiveRevisionReason } from '@/lib/presetStorage';
import { DropZone } from './DropZone';
import { ImageThumbnail } from './ImageThumbnail';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Download, Play, X, ImageIcon, RotateCcw, Square } from 'lucide-react';
import JSZip from 'jszip';
import { toast } from 'sonner';

const MAX_BATCH_FILES = 100;

interface BatchProcessorProps {
  selection: CalibrationSelection | null;
}

function revokeUrl(url: string | null | undefined) {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function BatchProcessor({ selection }: BatchProcessorProps) {
  const [images, setImages] = useState<BatchImage[]>([]);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    format: 'jpeg',
    quality: 0.92,
    suffix: '_corrected',
  });
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const cancelRef = useRef(false);
  const activeSelectionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
      imagesRef.current.forEach((img) => {
        revokeUrl(img.originalUrl);
        revokeUrl(img.correctedUrl);
      });
    };
  }, []);

  // Invalidate completed results when the explicit revision or encode settings change
  useEffect(() => {
    const selectionKey = selection
      ? `${selection.presetId}@${selection.revision.revision}:${selection.revision.fingerprint}`
      : null;
    const selectionChanged =
      activeSelectionKeyRef.current !== null && activeSelectionKeyRef.current !== selectionKey;
    activeSelectionKeyRef.current = selectionKey;

    setImages((prev) => {
      let changed = false;
      const next = prev.map((img) => {
        if (img.status !== 'completed' || !img.processedWith) return img;
        if (!selectionChanged && !isProcessedResultStale(img.processedWith, selection, exportSettings)) {
          return img;
        }
        changed = true;
        revokeUrl(img.correctedUrl);
        return {
          ...img,
          status: 'pending' as const,
          correctedUrl: null,
          processedWith: undefined,
          error: undefined,
        };
      });
      return changed ? next : prev;
    });
  }, [
    // The effect reads the full objects but only identity-relevant primitives
    // should trigger an invalidation pass.
    selection?.presetId,
    selection?.revision.revision,
    selection?.revision.fingerprint,
    exportSettings.format,
    exportSettings.quality,
  ]);

  const handleFilesSelected = useCallback((files: File[]) => {
    const currentCount = imagesRef.current.length;
    const remaining = MAX_BATCH_FILES - currentCount;
    if (remaining <= 0) {
      toast.error(`Maximum of ${MAX_BATCH_FILES} images reached`);
      return;
    }

    const raster = files.filter(
      (file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml'
    );
    if (raster.length === 0) {
      toast.error('No supported raster images found');
      return;
    }

    const accepted = raster.slice(0, remaining);
    if (accepted.length < raster.length) {
      toast.warning(`Only ${accepted.length} of ${raster.length} images added (limit ${MAX_BATCH_FILES})`);
    }

    const newImages: BatchImage[] = accepted.map((file, index) => ({
      id: `img_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 7)}`,
      file,
      originalUrl: URL.createObjectURL(file),
      correctedUrl: null,
      status: 'pending',
      excluded: false,
    }));

    setImages((prev) => [...prev, ...newImages]);
  }, []);

  const handleToggleExclude = useCallback((id: string) => {
    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, excluded: !img.excluded } : img))
    );
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) {
        revokeUrl(target.originalUrl);
        revokeUrl(target.correctedUrl);
      }
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  const handleRemoveAll = useCallback(() => {
    cancelRef.current = true;
    imagesRef.current.forEach((img) => {
      revokeUrl(img.originalUrl);
      revokeUrl(img.correctedUrl);
    });
    setImages([]);
    setProgress(null);
  }, []);

  const processImages = useCallback(async (reprocessAll = false) => {
    if (!selection) {
      toast.error('Select a calibration profile and revision first');
      return;
    }

    const blocked = destructiveRevisionReason(selection.revision);
    if (blocked) {
      toast.error(
        `This revision fails the colour safety guardrail (${blocked}) and was not applied. Choose or import a different revision.`
      );
      return;
    }

    const matrix = selection.revision.matrix;

    const snapshot = imagesRef.current;
    const toProcess = snapshot.filter(
      (img) =>
        !img.excluded &&
        (reprocessAll
          ? img.status === 'pending' || img.status === 'completed' || img.status === 'error'
          : img.status === 'pending' || img.status === 'error')
    );

    if (toProcess.length === 0) {
      toast.info('No images left to process');
      return;
    }

    cancelRef.current = false;
    const total = toProcess.length;
    setProgress({ current: 0, total, percentage: 0 });

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < toProcess.length; i++) {
      if (cancelRef.current) {
        toast.info('Processing cancelled');
        break;
      }

      const img = toProcess[i];

      setImages((prev) =>
        prev.map((item) =>
          item.id === img.id ? { ...item, status: 'processing' } : item
        )
      );

      try {
        const canvas = await loadImageToCanvas(img.file);
        if (cancelRef.current) break;

        const correctedCanvas = applyColorCorrectionToImage(canvas, matrix);
        const blob = await canvasToBlob(
          correctedCanvas,
          exportSettings.format,
          exportSettings.quality
        );
        const correctedUrl = URL.createObjectURL(blob);

        setImages((prev) =>
          prev.map((item) => {
            if (item.id !== img.id) return item;
            revokeUrl(item.correctedUrl);
            return {
              ...item,
              status: 'completed',
              correctedUrl,
              error: undefined,
              processedWith: {
                presetId: selection.presetId,
                revision: selection.revision.revision,
                fingerprint: selection.revision.fingerprint,
                format: exportSettings.format,
                quality: exportSettings.quality,
              },
            };
          })
        );
        successCount += 1;
      } catch (error) {
        setImages((prev) =>
          prev.map((item) =>
            item.id === img.id
              ? {
                  ...item,
                  status: 'error',
                  error: error instanceof Error ? error.message : String(error),
                }
              : item
          )
        );
        errorCount += 1;
      }

      setProgress({
        current: i + 1,
        total,
        percentage: Math.round(((i + 1) / total) * 100),
      });

      // Yield to keep UI responsive on large batches
      await new Promise((r) => setTimeout(r, 0));
    }

    setProgress(null);

    if (cancelRef.current) return;

    if (errorCount === 0) {
      toast.success(`Processed ${successCount} image${successCount === 1 ? '' : 's'}`);
    } else {
      toast.warning(`Processed ${successCount}, failed ${errorCount}`);
    }
  }, [selection, exportSettings]);

  const downloadSingle = useCallback(
    async (image: BatchImage) => {
      if (!image.correctedUrl) return;

      try {
        const response = await fetch(image.correctedUrl);
        const blob = await response.blob();
        const format = formatFromMime(
          blob.type || image.processedWith?.format,
          exportSettings.format
        );
        const ext = extensionForFormat(format);
        const baseName = image.file.name.replace(/\.[^/.]+$/, '');
        const fileName = `${baseName}${exportSettings.suffix}.${ext}`;

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        toast.error(`Failed to download ${image.file.name}`);
      }
    },
    [exportSettings]
  );

  const downloadAll = useCallback(async () => {
    const completed = imagesRef.current.filter(
      (img) => img.status === 'completed' && !img.excluded && img.correctedUrl
    );
    if (completed.length === 0) return;

    try {
      const zip = new JSZip();
      const usedNames = new Set<string>();

      for (const img of completed) {
        if (!img.correctedUrl) continue;
        const response = await fetch(img.correctedUrl);
        const blob = await response.blob();
        const format = formatFromMime(
          blob.type || img.processedWith?.format,
          exportSettings.format
        );
        const ext = extensionForFormat(format);
        const baseName = img.file.name.replace(/\.[^/.]+$/, '');
        let fileName = `${baseName}${exportSettings.suffix}.${ext}`;
        let counter = 1;
        while (usedNames.has(fileName)) {
          fileName = `${baseName}${exportSettings.suffix}_${counter}.${ext}`;
          counter += 1;
        }
        usedNames.add(fileName);
        zip.file(fileName, blob);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'corrected_images.zip';
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Download started');
    } catch {
      toast.error('Failed to create zip download');
    }
  }, [exportSettings]);

  const completedCount = images.filter((img) => img.status === 'completed' && !img.excluded).length;
  const pendingCount = images.filter(
    (img) => (img.status === 'pending' || img.status === 'error') && !img.excluded
  ).length;
  const isProcessing = progress !== null;
  const remainingSlots = Math.max(0, MAX_BATCH_FILES - images.length);
  const hasStaleCompleted = hasStaleCompletedResults(images, selection, exportSettings);

  return (
    <div className="space-y-6">
      <DropZone
        onFilesSelected={handleFilesSelected}
        multiple
        maxFiles={remainingSlots || MAX_BATCH_FILES}
        disabled={remainingSlots === 0 || isProcessing}
        className="min-h-[160px] sm:min-h-[200px]"
      />

      {images.length > 0 && (
        <>
          {hasStaleCompleted && (
            <div
              role="status"
              className="p-3 rounded-lg bg-warning/15 border border-warning/40 text-sm text-foreground"
            >
              <span className="font-medium text-warning">Out of date:</span>{' '}
              Some results were produced with a different revision or export setting. Reprocess
              before downloading.
            </div>
          )}

          <div className="space-y-4 p-3 sm:p-4 bg-card rounded-lg border">
            <div className="flex items-center gap-2 min-w-0">
              <ImageIcon className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium truncate">
                {images.length} images • {completedCount} processed
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="export-format" className="text-xs text-muted-foreground">
                  Format
                </Label>
                <Select
                  value={exportSettings.format}
                  onValueChange={(v) =>
                    setExportSettings((s) => ({ ...s, format: v as 'jpeg' | 'png' }))
                  }
                  disabled={isProcessing}
                >
                  <SelectTrigger id="export-format" className="w-full h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jpeg">JPEG</SelectItem>
                    <SelectItem value="png">PNG</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {exportSettings.format === 'jpeg' && (
                <div className="space-y-1.5 min-w-0">
                  <Label htmlFor="export-quality" className="text-xs text-muted-foreground">
                    Quality ({Math.round(exportSettings.quality * 100)}%)
                  </Label>
                  <Slider
                    id="export-quality"
                    value={[exportSettings.quality * 100]}
                    onValueChange={([v]) =>
                      setExportSettings((s) => ({ ...s, quality: v / 100 }))
                    }
                    min={50}
                    max={100}
                    step={1}
                    className="w-full py-3"
                    disabled={isProcessing}
                  />
                </div>
              )}

              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="export-suffix" className="text-xs text-muted-foreground">
                  Suffix
                </Label>
                <Input
                  id="export-suffix"
                  value={exportSettings.suffix}
                  onChange={(e) =>
                    setExportSettings((s) => ({ ...s, suffix: e.target.value }))
                  }
                  className="w-full h-10"
                  disabled={isProcessing}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                className="flex-1 sm:flex-none min-h-10"
                onClick={() => processImages(false)}
                disabled={!selection || pendingCount === 0 || isProcessing}
              >
                <Play className="w-4 h-4 mr-2" />
                Process {pendingCount > 0 ? `(${pendingCount})` : ''}
              </Button>

              {isProcessing && (
                <Button
                  variant="secondary"
                  className="min-h-10"
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                >
                  <Square className="w-4 h-4 mr-2" />
                  Cancel
                </Button>
              )}

              {completedCount > 0 && !isProcessing && (
                <>
                  <Button
                    variant="secondary"
                    className="min-h-10"
                    onClick={() => processImages(true)}
                    disabled={!selection}
                    title="Reprocess all included images with the selected revision"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Reprocess
                  </Button>
                  <Button variant="outline" className="min-h-10" onClick={downloadAll}>
                    <Download className="w-4 h-4 mr-2" />
                    Download
                  </Button>
                </>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10"
                onClick={handleRemoveAll}
                disabled={isProcessing}
                aria-label="Remove all images"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {progress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm gap-2">
                <span>Processing images...</span>
                <span className="text-muted-foreground shrink-0">
                  {progress.current} / {progress.total}
                </span>
              </div>
              <Progress value={progress.percentage} />
            </div>
          )}

          <div className="grid grid-cols-1 min-[360px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {images.map((image) => (
              <ImageThumbnail
                key={image.id}
                image={image}
                onToggleExclude={handleToggleExclude}
                onDownload={downloadSingle}
                onRemove={handleRemoveImage}
              />
            ))}
          </div>
        </>
      )}

      {!selection && images.length > 0 && (
        <div
          role="status"
          className="p-4 rounded-lg bg-warning/15 border border-warning/40 text-center"
        >
          <p className="text-sm text-foreground">
            Select a saved calibration profile and an explicit revision before processing.
          </p>
        </div>
      )}
    </div>
  );
}

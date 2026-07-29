import { useState, useCallback, useEffect, useRef } from 'react';
import { BatchImage, CalibrationPreset, ExportSettings, ProcessingProgress } from '@/types/colorCorrector';
import { loadImageToCanvas, applyColorCorrectionToImage, canvasToBlob } from '@/lib/colorCorrection';
import { DropZone } from './DropZone';
import { ImageThumbnail } from './ImageThumbnail';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Download, Play, X, ImageIcon, RotateCcw } from 'lucide-react';
import JSZip from 'jszip';
import { toast } from 'sonner';

const MAX_BATCH_FILES = 100;

interface BatchProcessorProps {
  preset: CalibrationPreset | null;
}

function revokeUrl(url: string | null | undefined) {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function BatchProcessor({ preset }: BatchProcessorProps) {
  const [images, setImages] = useState<BatchImage[]>([]);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    format: 'jpeg',
    quality: 0.92,
    suffix: '_corrected',
  });
  const imagesRef = useRef(images);
  imagesRef.current = images;

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      imagesRef.current.forEach((img) => {
        revokeUrl(img.originalUrl);
        revokeUrl(img.correctedUrl);
      });
    };
  }, []);

  const handleFilesSelected = useCallback((files: File[]) => {
    setImages((prev) => {
      const remaining = MAX_BATCH_FILES - prev.length;
      if (remaining <= 0) {
        toast.error(`Maximum of ${MAX_BATCH_FILES} images reached`);
        return prev;
      }

      const accepted = files.slice(0, remaining);
      if (accepted.length < files.length) {
        toast.warning(`Only ${accepted.length} of ${files.length} images added (limit ${MAX_BATCH_FILES})`);
      }

      const newImages: BatchImage[] = accepted.map((file, index) => ({
        id: `img_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 7)}`,
        file,
        originalUrl: URL.createObjectURL(file),
        correctedUrl: null,
        status: 'pending',
        excluded: false,
      }));

      return [...prev, ...newImages];
    });
  }, []);

  const handleToggleExclude = useCallback((id: string) => {
    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, excluded: !img.excluded } : img))
    );
  }, []);

  const handleRemoveAll = useCallback(() => {
    imagesRef.current.forEach((img) => {
      revokeUrl(img.originalUrl);
      revokeUrl(img.correctedUrl);
    });
    setImages([]);
    setProgress(null);
  }, []);

  const processImages = useCallback(async (reprocessAll = false) => {
    if (!preset?.matrix) {
      toast.error('Select a calibration preset first');
      return;
    }

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

    const total = toProcess.length;
    setProgress({ current: 0, total, percentage: 0 });

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < toProcess.length; i++) {
      const img = toProcess[i];

      setImages((prev) =>
        prev.map((item) =>
          item.id === img.id ? { ...item, status: 'processing' } : item
        )
      );

      try {
        const canvas = await loadImageToCanvas(img.file);
        const correctedCanvas = applyColorCorrectionToImage(canvas, preset.matrix);
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
            return { ...item, status: 'completed', correctedUrl, error: undefined };
          })
        );
        successCount += 1;
      } catch (error) {
        setImages((prev) =>
          prev.map((item) =>
            item.id === img.id
              ? { ...item, status: 'error', error: error instanceof Error ? error.message : String(error) }
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
    }

    setProgress(null);

    if (errorCount === 0) {
      toast.success(`Processed ${successCount} image${successCount === 1 ? '' : 's'}`);
    } else {
      toast.warning(`Processed ${successCount}, failed ${errorCount}`);
    }
  }, [preset, exportSettings]);

  const downloadSingle = useCallback(
    async (image: BatchImage) => {
      if (!image.correctedUrl) return;

      try {
        const response = await fetch(image.correctedUrl);
        const blob = await response.blob();
        const ext = exportSettings.format === 'jpeg' ? 'jpg' : 'png';
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
      const ext = exportSettings.format === 'jpeg' ? 'jpg' : 'png';
      const usedNames = new Set<string>();

      for (const img of completed) {
        if (!img.correctedUrl) continue;
        const response = await fetch(img.correctedUrl);
        const blob = await response.blob();
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

  return (
    <div className="space-y-6">
      <DropZone
        onFilesSelected={handleFilesSelected}
        multiple
        maxFiles={remainingSlots || MAX_BATCH_FILES}
        disabled={remainingSlots === 0}
        className="min-h-[200px]"
      />

      {images.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-4 p-4 bg-card rounded-lg border">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                {images.length} images • {completedCount} processed
              </span>
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Format</Label>
                <Select
                  value={exportSettings.format}
                  onValueChange={(v) =>
                    setExportSettings((s) => ({ ...s, format: v as 'jpeg' | 'png' }))
                  }
                  disabled={isProcessing}
                >
                  <SelectTrigger className="w-20 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jpeg">JPEG</SelectItem>
                    <SelectItem value="png">PNG</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {exportSettings.format === 'jpeg' && (
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Quality</Label>
                  <Slider
                    value={[exportSettings.quality * 100]}
                    onValueChange={([v]) =>
                      setExportSettings((s) => ({ ...s, quality: v / 100 }))
                    }
                    min={50}
                    max={100}
                    step={1}
                    className="w-20"
                    disabled={isProcessing}
                  />
                  <span className="text-xs w-8">{Math.round(exportSettings.quality * 100)}%</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Suffix</Label>
                <Input
                  value={exportSettings.suffix}
                  onChange={(e) =>
                    setExportSettings((s) => ({ ...s, suffix: e.target.value }))
                  }
                  className="w-28 h-8"
                  disabled={isProcessing}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => processImages(false)}
                disabled={!preset?.matrix || pendingCount === 0 || isProcessing}
              >
                <Play className="w-4 h-4 mr-2" />
                Process {pendingCount > 0 ? `(${pendingCount})` : ''}
              </Button>

              {completedCount > 0 && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => processImages(true)}
                    disabled={!preset?.matrix || isProcessing}
                    title="Reprocess all included images with current settings"
                  >
                    <RotateCcw className="w-4 h-4 mr-2" />
                    Reprocess
                  </Button>
                  <Button variant="outline" onClick={downloadAll} disabled={isProcessing}>
                    <Download className="w-4 h-4 mr-2" />
                    Download All
                  </Button>
                </>
              )}

              <Button variant="ghost" size="icon" onClick={handleRemoveAll} disabled={isProcessing}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {progress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Processing images...</span>
                <span className="text-muted-foreground">
                  {progress.current} / {progress.total}
                </span>
              </div>
              <Progress value={progress.percentage} />
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {images.map((image) => (
              <ImageThumbnail
                key={image.id}
                image={image}
                onToggleExclude={handleToggleExclude}
                onDownload={downloadSingle}
              />
            ))}
          </div>
        </>
      )}

      {!preset?.matrix && images.length > 0 && (
        <div className="p-4 rounded-lg bg-warning/10 border border-warning/30 text-center">
          <p className="text-sm text-warning">
            Please create or select a calibration preset first to process images.
          </p>
        </div>
      )}
    </div>
  );
}

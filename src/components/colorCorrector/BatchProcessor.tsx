import { useState, useCallback } from 'react';
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
import { Download, Play, X, ImageIcon } from 'lucide-react';
import JSZip from 'jszip';

interface BatchProcessorProps {
  preset: CalibrationPreset | null;
}

export function BatchProcessor({ preset }: BatchProcessorProps) {
  const [images, setImages] = useState<BatchImage[]>([]);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    format: 'jpeg',
    quality: 0.92,
    suffix: '_corrected',
  });

  const handleFilesSelected = useCallback((files: File[]) => {
    const newImages: BatchImage[] = files.map((file) => ({
      id: `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
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

  const handleRemoveAll = useCallback(() => {
    images.forEach((img) => {
      URL.revokeObjectURL(img.originalUrl);
      if (img.correctedUrl) URL.revokeObjectURL(img.correctedUrl);
    });
    setImages([]);
    setProgress(null);
  }, [images]);

  const processImages = useCallback(async () => {
    if (!preset?.matrix) return;

    const toProcess = images.filter((img) => !img.excluded && img.status !== 'completed');
    const total = toProcess.length;

    setProgress({ current: 0, total, percentage: 0 });

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
        const blob = await canvasToBlob(correctedCanvas, exportSettings.format, exportSettings.quality);
        const correctedUrl = URL.createObjectURL(blob);

        setImages((prev) =>
          prev.map((item) =>
            item.id === img.id
              ? { ...item, status: 'completed', correctedUrl }
              : item
          )
        );
      } catch (error) {
        setImages((prev) =>
          prev.map((item) =>
            item.id === img.id
              ? { ...item, status: 'error', error: String(error) }
              : item
          )
        );
      }

      setProgress({
        current: i + 1,
        total,
        percentage: Math.round(((i + 1) / total) * 100),
      });
    }

    setProgress(null);
  }, [images, preset, exportSettings]);

  const downloadSingle = useCallback(
    async (image: BatchImage) => {
      if (!image.correctedUrl) return;

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
    },
    [exportSettings]
  );

  const downloadAll = useCallback(async () => {
    const completed = images.filter((img) => img.status === 'completed' && !img.excluded);
    if (completed.length === 0) return;

    const zip = new JSZip();
    const ext = exportSettings.format === 'jpeg' ? 'jpg' : 'png';

    for (const img of completed) {
      if (!img.correctedUrl) continue;
      const response = await fetch(img.correctedUrl);
      const blob = await response.blob();
      const baseName = img.file.name.replace(/\.[^/.]+$/, '');
      const fileName = `${baseName}${exportSettings.suffix}.${ext}`;
      zip.file(fileName, blob);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'corrected_images.zip';
    a.click();
    URL.revokeObjectURL(url);
  }, [images, exportSettings]);

  const completedCount = images.filter((img) => img.status === 'completed' && !img.excluded).length;
  const pendingCount = images.filter((img) => img.status === 'pending' && !img.excluded).length;

  return (
    <div className="space-y-6">
      {/* Upload area */}
      <DropZone
        onFilesSelected={handleFilesSelected}
        multiple
        maxFiles={100}
        className="min-h-[200px]"
      />

      {images.length > 0 && (
        <>
          {/* Controls bar */}
          <div className="flex flex-wrap items-center gap-4 p-4 bg-card rounded-lg border">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                {images.length} images • {completedCount} processed
              </span>
            </div>

            <div className="flex-1" />

            {/* Export settings */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Format</Label>
                <Select
                  value={exportSettings.format}
                  onValueChange={(v) => setExportSettings((s) => ({ ...s, format: v as 'jpeg' | 'png' }))}
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
                    onValueChange={([v]) => setExportSettings((s) => ({ ...s, quality: v / 100 }))}
                    min={50}
                    max={100}
                    step={1}
                    className="w-20"
                  />
                  <span className="text-xs w-8">{Math.round(exportSettings.quality * 100)}%</span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Suffix</Label>
                <Input
                  value={exportSettings.suffix}
                  onChange={(e) => setExportSettings((s) => ({ ...s, suffix: e.target.value }))}
                  className="w-28 h-8"
                />
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              <Button
                onClick={processImages}
                disabled={!preset?.matrix || pendingCount === 0 || progress !== null}
              >
                <Play className="w-4 h-4 mr-2" />
                Process {pendingCount > 0 ? `(${pendingCount})` : ''}
              </Button>

              {completedCount > 0 && (
                <Button variant="outline" onClick={downloadAll}>
                  <Download className="w-4 h-4 mr-2" />
                  Download All
                </Button>
              )}

              <Button variant="ghost" size="icon" onClick={handleRemoveAll}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Progress bar */}
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

          {/* Image grid */}
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

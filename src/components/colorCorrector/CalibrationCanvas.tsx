import { useRef, useState, useEffect, useCallback } from 'react';
import { ColorPoint, RGB } from '@/types/colorCorrector';
import { sampleColorFromCanvas, hexToRgb } from '@/lib/colorCorrection';
import { ColorPointMarker } from './ColorPointMarker';
import { cn } from '@/lib/utils';

interface CalibrationCanvasProps {
  imageUrl: string;
  points: ColorPoint[];
  onPointsChange: (points: ColorPoint[]) => void;
  showCorrected?: boolean;
  correctedImageUrl?: string;
  className?: string;
}

function defaultLabel(existingLabels: string[], index: number): string {
  if (!existingLabels.includes('white')) return 'White';
  if (!existingLabels.includes('grey') && !existingLabels.includes('gray')) return 'Grey';
  if (!existingLabels.includes('black')) return 'Black';
  return `Point ${index + 1}`;
}

function defaultTarget(label: string, sampledColor: RGB): RGB {
  const normalized = label.toLowerCase();
  if (normalized === 'white') return hexToRgb('#FFFFFF');
  if (normalized === 'grey' || normalized === 'gray') return hexToRgb('#808080');
  if (normalized === 'black') return hexToRgb('#000000');
  return { ...sampledColor };
}

export function CalibrationCanvas({
  imageUrl,
  points,
  onPointsChange,
  showCorrected = false,
  correctedImageUrl,
  className,
}: CalibrationCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0);
        }
      }
      setIsLoaded(true);
    };
    img.onerror = () => {
      setIsLoaded(false);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !canvasRef.current || !isLoaded) return;
      // Ignore clicks originating from markers / popovers
      if ((e.target as HTMLElement).closest('[data-color-point-marker]')) return;

      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));

      const canvas = canvasRef.current;
      const sampledColor = sampleColorFromCanvas(
        canvas,
        x * canvas.width,
        y * canvas.height,
        7
      );

      const existingLabels = points.map((p) => p.label.toLowerCase());
      const label = defaultLabel(existingLabels, points.length);
      const targetColor = defaultTarget(label, sampledColor);

      const newPoint: ColorPoint = {
        id: `point_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        x,
        y,
        sampledColor,
        targetColor,
        label,
      };

      onPointsChange([...points, newPoint]);
    },
    [points, onPointsChange, isLoaded]
  );

  const handlePointUpdate = useCallback(
    (updatedPoint: ColorPoint) => {
      onPointsChange(points.map((p) => (p.id === updatedPoint.id ? updatedPoint : p)));
    },
    [points, onPointsChange]
  );

  const handlePointMove = useCallback(
    (id: string, x: number, y: number) => {
      if (!canvasRef.current || !isLoaded) return;
      const canvas = canvasRef.current;
      const sampledColor = sampleColorFromCanvas(
        canvas,
        x * canvas.width,
        y * canvas.height,
        7
      );
      onPointsChange(
        points.map((p) =>
          p.id === id
            ? {
                ...p,
                x,
                y,
                sampledColor,
              }
            : p
        )
      );
    },
    [points, onPointsChange, isLoaded]
  );

  const handlePointDelete = useCallback(
    (id: string) => {
      onPointsChange(points.filter((p) => p.id !== id));
    },
    [points, onPointsChange]
  );

  const displayUrl = showCorrected && correctedImageUrl ? correctedImageUrl : imageUrl;

  return (
    <div className={cn('relative', className)}>
      <div
        ref={containerRef}
        className="relative cursor-crosshair overflow-hidden rounded-lg bg-muted"
        onClick={handleCanvasClick}
      >
        <img
          src={displayUrl}
          alt="Reference image"
          className="w-full h-auto block select-none"
          draggable={false}
        />

        <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

        {!showCorrected &&
          points.map((point) => (
            <ColorPointMarker
              key={point.id}
              point={point}
              onUpdate={handlePointUpdate}
              onDelete={handlePointDelete}
              onMove={handlePointMove}
              containerRef={containerRef}
            />
          ))}
      </div>

      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted rounded-lg">
          <div className="animate-pulse text-muted-foreground">Loading image...</div>
        </div>
      )}
    </div>
  );
}

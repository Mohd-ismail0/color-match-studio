import { useRef, useState, useEffect, useCallback } from 'react';
import { ColorPoint } from '@/types/colorCorrector';
import {
  sampleColorFromCanvas,
  nextAutoRole,
  defaultTargetForRole,
  defaultLabelForRole,
} from '@/lib/colorCorrection';
import { ColorPointMarker } from './ColorPointMarker';
import { cn } from '@/lib/utils';

interface CalibrationCanvasProps {
  imageUrl: string;
  points: ColorPoint[];
  onPointsChange: (points: ColorPoint[]) => void;
  showCorrected?: boolean;
  correctedImageUrl?: string;
  className?: string;
  /** Called when the sampling canvas is ready (e.g. to re-sample existing points) */
  onSamplingCanvasReady?: (canvas: HTMLCanvasElement) => void;
}

export function CalibrationCanvas({
  imageUrl,
  points,
  onPointsChange,
  showCorrected = false,
  correctedImageUrl,
  className,
  onSamplingCanvasReady,
}: CalibrationCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadIdRef = useRef(0);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const loadId = ++loadIdRef.current;
    setIsLoaded(false);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (loadId !== loadIdRef.current) return;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0);
        }
        onSamplingCanvasReady?.(canvas);
      }
      setIsLoaded(true);
    };
    img.onerror = () => {
      if (loadId !== loadIdRef.current) return;
      setIsLoaded(false);
    };
    img.src = imageUrl;
  }, [imageUrl, onSamplingCanvasReady]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !canvasRef.current || !isLoaded) return;
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

      const role = nextAutoRole(points);
      const label = defaultLabelForRole(role, points.length);
      const targetColor = defaultTargetForRole(role, sampledColor);

      const newPoint: ColorPoint = {
        id: `point_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        x,
        y,
        sampledColor,
        targetColor,
        label,
        role,
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

        {/* Keep markers visible during preview so patch hits stay editable */}
        {points.map((point) => (
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

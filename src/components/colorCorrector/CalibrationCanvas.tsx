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

  // Load image to canvas for color sampling
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
        }
      }
      setIsLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!containerRef.current || !canvasRef.current || !isLoaded) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      // Sample color from canvas
      const canvas = canvasRef.current;
      const canvasX = x * canvas.width;
      const canvasY = y * canvas.height;
      const sampledColor = sampleColorFromCanvas(canvas, canvasX, canvasY, 7);

      // Determine default label based on existing points
      const existingLabels = points.map((p) => p.label.toLowerCase());
      let label = `Point ${points.length + 1}`;
      if (!existingLabels.includes('white')) label = 'White';
      else if (!existingLabels.includes('grey') && !existingLabels.includes('gray')) label = 'Grey';
      else if (!existingLabels.includes('black')) label = 'Black';

      // Default target based on label
      let targetColor: RGB = { ...sampledColor };
      if (label.toLowerCase() === 'white') targetColor = hexToRgb('#FFFFFF');
      else if (label.toLowerCase() === 'grey' || label.toLowerCase() === 'gray') targetColor = hexToRgb('#808080');
      else if (label.toLowerCase() === 'black') targetColor = hexToRgb('#000000');

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
          className="w-full h-auto block"
          draggable={false}
        />
        
        {/* Hidden canvas for color sampling */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Color point markers */}
        {!showCorrected &&
          points.map((point) => (
            <ColorPointMarker
              key={point.id}
              point={point}
              onUpdate={handlePointUpdate}
              onDelete={handlePointDelete}
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

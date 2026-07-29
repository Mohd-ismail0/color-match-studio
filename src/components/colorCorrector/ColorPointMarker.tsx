import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ColorPoint } from '@/types/colorCorrector';
import {
  rgbToHex,
  parseHexColor,
  inferPointRole,
  defaultTargetForRole,
} from '@/lib/colorCorrection';
import { cn } from '@/lib/utils';

interface ColorPointMarkerProps {
  point: ColorPoint;
  onUpdate: (point: ColorPoint) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

export function ColorPointMarker({
  point,
  onUpdate,
  onDelete,
  onMove,
  containerRef,
}: ColorPointMarkerProps) {
  const [targetHex, setTargetHex] = useState(rgbToHex(point.targetColor));
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef({
    pointerId: null as number | null,
    startX: 0,
    startY: 0,
    didMove: false,
  });
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setTargetHex(rgbToHex(point.targetColor));
  }, [point.targetColor]);

  const handleTargetColorChange = (hex: string) => {
    setTargetHex(hex);
    const parsed = parseHexColor(hex);
    if (!parsed) return;
    const normalized = hex.startsWith('#') ? hex : `#${hex}`;
    setTargetHex(normalized);
    onUpdate({
      ...point,
      targetColor: parsed,
    });
  };

  const handleLabelChange = (label: string) => {
    const role = inferPointRole(label);
    const shouldUpdateTarget = role !== 'custom' && role !== inferPointRole(point.label, point.role);
    onUpdate({
      ...point,
      label,
      role,
      targetColor: shouldUpdateTarget
        ? defaultTargetForRole(role, point.sampledColor)
        : point.targetColor,
    });
  };

  const getRelativePosition = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const position = getRelativePosition(event.clientX, event.clientY);
    if (!position) return;

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      didMove: false,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (dragState.pointerId !== event.pointerId) return;

    const distance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (distance > 3) {
      if (!dragState.didMove) {
        dragState.didMove = true;
        setIsDragging(true);
        setIsOpen(false);
      }

      const position = getRelativePosition(event.clientX, event.clientY);
      if (!position) return;
      onMove(point.id, position.x, position.y);
    }
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (dragState.pointerId !== event.pointerId) return;

    if (dragState.didMove) {
      suppressClickRef.current = true;
    }

    dragStateRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      didMove: false,
    };
    setIsDragging(false);
  };

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    // Never let marker interactions create a new calibration point
    event.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      setIsOpen(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-color-point-marker
          className={cn(
            "absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow-lg cursor-grab transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 active:cursor-grabbing",
            isOpen && "scale-125 ring-2 ring-ring ring-offset-2",
            isDragging && "scale-125 cursor-grabbing"
          )}
          style={{
            left: `${point.x * 100}%`,
            top: `${point.y * 100}%`,
            backgroundColor: rgbToHex(point.sampledColor),
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onClick={handleClick}
        >
          <span className="sr-only">Edit point: {point.label}</span>
        </button>
      </PopoverTrigger>
      
      <PopoverContent className="w-72" align="start">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">Edit Color Point</h4>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => {
                onDelete(point.id);
                setIsOpen(false);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor={`label-${point.id}`}>Label</Label>
            <Input
              id={`label-${point.id}`}
              value={point.label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="e.g., White, Grey, Black"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Sampled</Label>
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded border border-border"
                  style={{ backgroundColor: rgbToHex(point.sampledColor) }}
                />
                <span className="text-xs font-mono">
                  {rgbToHex(point.sampledColor).toUpperCase()}
                </span>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor={`target-${point.id}`} className="text-xs">Target</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={targetHex}
                  onChange={(e) => handleTargetColorChange(e.target.value)}
                  className="w-8 h-8 rounded border border-border cursor-pointer"
                />
                <Input
                  id={`target-${point.id}`}
                  value={targetHex}
                  onChange={(e) => handleTargetColorChange(e.target.value)}
                  placeholder="#FFFFFF"
                  className="h-8 text-xs font-mono"
                />
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

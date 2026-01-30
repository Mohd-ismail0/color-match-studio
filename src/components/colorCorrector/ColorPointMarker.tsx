import { useState } from 'react';
import { X, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ColorPoint, RGB } from '@/types/colorCorrector';
import { rgbToHex, hexToRgb } from '@/lib/colorCorrection';
import { cn } from '@/lib/utils';

interface ColorPointMarkerProps {
  point: ColorPoint;
  onUpdate: (point: ColorPoint) => void;
  onDelete: (id: string) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

export function ColorPointMarker({
  point,
  onUpdate,
  onDelete,
  containerRef,
}: ColorPointMarkerProps) {
  const [targetHex, setTargetHex] = useState(rgbToHex(point.targetColor));
  const [isOpen, setIsOpen] = useState(false);

  const handleTargetColorChange = (hex: string) => {
    setTargetHex(hex);
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      onUpdate({
        ...point,
        targetColor: hexToRgb(hex),
      });
    }
  };

  const handleLabelChange = (label: string) => {
    onUpdate({
      ...point,
      label,
    });
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow-lg cursor-pointer transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
            isOpen && "scale-125 ring-2 ring-ring ring-offset-2"
          )}
          style={{
            left: `${point.x * 100}%`,
            top: `${point.y * 100}%`,
            backgroundColor: rgbToHex(point.sampledColor),
          }}
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

import { CalibrationPreset } from '@/types/colorCorrector';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, Edit, Play } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface PresetCardProps {
  preset: CalibrationPreset;
  onApply: (preset: CalibrationPreset) => void;
  onEdit: (preset: CalibrationPreset) => void;
  onDelete: (id: string) => void;
}

export function PresetCard({ preset, onApply, onEdit, onDelete }: PresetCardProps) {
  return (
    <Card className="group hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base line-clamp-1">{preset.name}</CardTitle>
          <Badge variant={preset.mode === 'advanced' ? 'default' : 'secondary'}>
            {preset.mode === 'advanced' ? 'Multi-point' : '3-Point'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {preset.points.slice(0, 5).map((point) => (
            <div
              key={point.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-xs"
            >
              <div
                className="w-2.5 h-2.5 rounded-full border border-border"
                style={{
                  backgroundColor: `rgb(${point.targetColor.r}, ${point.targetColor.g}, ${point.targetColor.b})`,
                }}
              />
              <span className="text-muted-foreground">{point.label}</span>
            </div>
          ))}
          {preset.points.length > 5 && (
            <span className="text-xs text-muted-foreground px-2 py-0.5">
              +{preset.points.length - 5} more
            </span>
          )}
        </div>
        
        <p className="text-xs text-muted-foreground">
          Updated {formatDistanceToNow(preset.updatedAt, { addSuffix: true })}
        </p>

        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" className="flex-1" onClick={() => onApply(preset)}>
            <Play className="w-3.5 h-3.5 mr-1" />
            Apply
          </Button>
          <Button size="sm" variant="outline" onClick={() => onEdit(preset)}>
            <Edit className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            onClick={() => onDelete(preset.id)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

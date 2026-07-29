import { useState } from 'react';
import { BatchImage } from '@/types/colorCorrector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Download, Eye, EyeOff, Loader2, AlertCircle, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageThumbnailProps {
  image: BatchImage;
  onToggleExclude: (id: string) => void;
  onDownload: (image: BatchImage) => void;
  onRemove?: (id: string) => void;
}

export function ImageThumbnail({
  image,
  onToggleExclude,
  onDownload,
  onRemove,
}: ImageThumbnailProps) {
  const [showCorrected, setShowCorrected] = useState(true);

  const displayUrl = showCorrected && image.correctedUrl ? image.correctedUrl : image.originalUrl;

  return (
    <div
      className={cn(
        'group relative rounded-lg overflow-hidden border transition-all',
        image.excluded ? 'opacity-50 border-dashed' : 'border-border hover:border-primary/50',
        image.status === 'error' && 'border-destructive'
      )}
    >
      <div className="aspect-square bg-muted">
        <img
          src={displayUrl}
          alt={image.file.name}
          className="w-full h-full object-cover"
        />

        {image.status === 'processing' && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        )}

        {image.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-destructive/10">
            <AlertCircle className="w-6 h-6 text-destructive" />
          </div>
        )}
      </div>

      <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-transparent to-transparent opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <div className="absolute bottom-0 left-0 right-0 p-2 space-y-2">
          <p className="text-xs font-medium truncate text-foreground">{image.file.name}</p>

          <div className="flex items-center gap-1">
            {image.correctedUrl && (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-xs"
                onClick={() => setShowCorrected(!showCorrected)}
              >
                {showCorrected ? (
                  <>
                    <Eye className="w-3 h-3 mr-1" /> Corrected
                  </>
                ) : (
                  <>
                    <EyeOff className="w-3 h-3 mr-1" /> Original
                  </>
                )}
              </Button>
            )}

            {image.status === 'completed' && (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2"
                onClick={() => onDownload(image)}
              >
                <Download className="w-3 h-3" />
              </Button>
            )}

            {onRemove && (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2"
                onClick={() => onRemove(image.id)}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-background/80 px-1.5 py-1">
        <Checkbox
          checked={!image.excluded}
          onCheckedChange={() => onToggleExclude(image.id)}
          className="border-border"
          aria-label={image.excluded ? 'Include image' : 'Exclude image'}
        />
        <span className="text-[10px] text-muted-foreground hidden sm:inline">
          {image.excluded ? 'Off' : 'On'}
        </span>
      </div>

      <div className="absolute top-2 right-2">
        {image.status === 'completed' && (
          <Badge variant="default" className="bg-success text-success-foreground text-xs">
            Done
          </Badge>
        )}
        {image.status === 'error' && (
          <Badge variant="destructive" className="text-xs">
            Error
          </Badge>
        )}
      </div>
    </div>
  );
}

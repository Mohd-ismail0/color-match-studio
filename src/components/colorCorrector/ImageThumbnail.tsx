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
            <Loader2 className="w-6 h-6 animate-spin text-primary" aria-label="Processing" />
          </div>
        )}

        {image.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-destructive/10">
            <AlertCircle className="w-6 h-6 text-destructive" aria-label="Error" />
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/95 via-background/70 to-transparent p-2 pt-8 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
        <p className="text-xs font-medium truncate text-foreground mb-2">{image.file.name}</p>

        <div className="flex items-center gap-1.5 flex-wrap">
          {image.correctedUrl && (
            <Button
              size="sm"
              variant="secondary"
              className="h-9 px-2.5 text-xs"
              onClick={() => setShowCorrected(!showCorrected)}
              aria-label={showCorrected ? 'Show original' : 'Show corrected'}
            >
              {showCorrected ? (
                <Eye className="w-3.5 h-3.5 sm:mr-1" />
              ) : (
                <EyeOff className="w-3.5 h-3.5 sm:mr-1" />
              )}
              <span className="hidden sm:inline">{showCorrected ? 'Corrected' : 'Original'}</span>
            </Button>
          )}

          {image.status === 'completed' && (
            <Button
              size="sm"
              variant="secondary"
              className="h-9 w-9 px-0"
              onClick={() => onDownload(image)}
              aria-label={`Download ${image.file.name}`}
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
          )}

          {onRemove && (
            <Button
              size="sm"
              variant="secondary"
              className="h-9 w-9 px-0"
              onClick={() => onRemove(image.id)}
              aria-label={`Remove ${image.file.name}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-background/90 px-1.5 py-1.5 shadow-sm">
        <Checkbox
          checked={!image.excluded}
          onCheckedChange={() => onToggleExclude(image.id)}
          className="h-5 w-5 border-border"
          aria-label={image.excluded ? 'Include image' : 'Exclude image'}
        />
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

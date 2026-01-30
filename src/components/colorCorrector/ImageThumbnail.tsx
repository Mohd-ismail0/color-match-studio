import { useState } from 'react';
import { BatchImage } from '@/types/colorCorrector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Download, Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageThumbnailProps {
  image: BatchImage;
  onToggleExclude: (id: string) => void;
  onDownload: (image: BatchImage) => void;
}

export function ImageThumbnail({ image, onToggleExclude, onDownload }: ImageThumbnailProps) {
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

      {/* Overlay controls */}
      <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
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
          </div>
        </div>
      </div>

      {/* Exclude checkbox */}
      <div className="absolute top-2 left-2">
        <Checkbox
          checked={!image.excluded}
          onCheckedChange={() => onToggleExclude(image.id)}
          className="bg-background/80 border-border"
        />
      </div>

      {/* Status badge */}
      <div className="absolute top-2 right-2">
        {image.status === 'completed' && (
          <Badge variant="default" className="bg-success text-success-foreground text-xs">
            Done
          </Badge>
        )}
        {image.status === 'error' && (
          <Badge variant="destructive" className="text-xs">Error</Badge>
        )}
      </div>
    </div>
  );
}

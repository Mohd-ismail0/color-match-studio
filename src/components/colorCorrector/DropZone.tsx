import { useCallback, useState } from 'react';
import { Upload, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DropZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  className?: string;
  children?: React.ReactNode;
}

export function DropZone({
  onFilesSelected,
  accept = 'image/*',
  multiple = false,
  maxFiles = 100,
  className,
  children,
}: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files).filter((file) =>
        file.type.startsWith('image/')
      );

      if (files.length > 0) {
        onFilesSelected(files.slice(0, maxFiles));
      }
    },
    [onFilesSelected, maxFiles]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (files.length > 0) {
        onFilesSelected(files.slice(0, maxFiles));
      }
      e.target.value = '';
    },
    [onFilesSelected, maxFiles]
  );

  return (
    <label
      className={cn(
        'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200',
        isDragging
          ? 'border-primary bg-primary/5 scale-[1.02]'
          : 'border-border bg-card hover:border-primary/50 hover:bg-muted/50',
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleFileInput}
        className="sr-only"
      />
      
      {children || (
        <div className="flex flex-col items-center gap-4 p-8 text-center">
          <div className={cn(
            "p-4 rounded-full transition-colors",
            isDragging ? "bg-primary/10" : "bg-muted"
          )}>
            {isDragging ? (
              <Upload className="w-8 h-8 text-primary animate-bounce" />
            ) : (
              <ImageIcon className="w-8 h-8 text-muted-foreground" />
            )}
          </div>
          <div>
            <p className="text-lg font-medium text-foreground">
              {isDragging ? 'Drop your images here' : 'Drag & drop images'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              or click to browse • {multiple ? `Up to ${maxFiles} images` : 'Single image'}
            </p>
          </div>
        </div>
      )}
    </label>
  );
}

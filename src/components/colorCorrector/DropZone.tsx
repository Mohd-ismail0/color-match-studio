import { useCallback, useRef, useState } from 'react';
import { Upload, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DropZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function DropZone({
  onFilesSelected,
  accept = 'image/*',
  multiple = false,
  maxFiles = 100,
  disabled = false,
  className,
  children,
}: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      dragDepthRef.current += 1;
      setIsDragging(true);
    },
    [disabled]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragging(false);
      if (disabled || maxFiles <= 0) return;

      const files = Array.from(e.dataTransfer.files).filter(
        (file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml'
      );

      if (files.length > 0) {
        onFilesSelected(files.slice(0, maxFiles));
      }
    },
    [onFilesSelected, maxFiles, disabled]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled || maxFiles <= 0) {
        e.target.value = '';
        return;
      }
      const files = e.target.files
        ? Array.from(e.target.files).filter(
            (file) => file.type.startsWith('image/') && file.type !== 'image/svg+xml'
          )
        : [];
      if (files.length > 0) {
        onFilesSelected(files.slice(0, maxFiles));
      }
      e.target.value = '';
    },
    [onFilesSelected, maxFiles, disabled]
  );

  return (
    <label
      className={cn(
        'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-all duration-200',
        disabled
          ? 'cursor-not-allowed opacity-60 border-border bg-muted/30'
          : 'cursor-pointer',
        !disabled && isDragging
          ? 'border-primary bg-primary/5 scale-[1.02]'
          : !disabled && 'border-border bg-card hover:border-primary/50 hover:bg-muted/50',
        className
      )}
      onDragEnter={handleDragEnter}
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
        disabled={disabled || maxFiles <= 0}
      />

      {children || (
        <div className="flex flex-col items-center gap-4 p-8 text-center">
          <div
            className={cn(
              'p-4 rounded-full transition-colors',
              isDragging && !disabled ? 'bg-primary/10' : 'bg-muted'
            )}
          >
            {isDragging && !disabled ? (
              <Upload className="w-8 h-8 text-primary animate-bounce" />
            ) : (
              <ImageIcon className="w-8 h-8 text-muted-foreground" />
            )}
          </div>
          <div>
            <p className="text-lg font-medium text-foreground">
              {disabled
                ? 'Image limit reached'
                : isDragging
                  ? 'Drop your images here'
                  : 'Drag & drop images'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {disabled
                ? 'Remove images to add more'
                : `or click to browse • ${multiple ? `Up to ${maxFiles} images` : 'Single image'}`}
            </p>
          </div>
        </div>
      )}
    </label>
  );
}

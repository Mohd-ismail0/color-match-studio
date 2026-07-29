import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { PresetCard } from '@/components/colorCorrector/PresetCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CalibrationPreset } from '@/types/colorCorrector';
import {
  getAllPresets,
  deletePreset,
  exportPresetsToJson,
  importPresetsFromJson,
} from '@/lib/presetStorage';
import { Settings2, Search, BookMarked, Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export default function Presets() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [presets, setPresets] = useState<CalibrationPreset[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setPresets(getAllPresets());
  }, []);

  const filteredPresets = presets.filter((preset) =>
    preset.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleApply = (preset: CalibrationPreset) => {
    navigate('/batch', { state: { preset } });
  };

  const handleEdit = (preset: CalibrationPreset) => {
    navigate('/calibrate', { state: { preset } });
  };

  const handleDelete = (id: string) => {
    setDeleteId(id);
  };

  const confirmDelete = () => {
    if (deleteId) {
      deletePreset(deleteId);
      setPresets(getAllPresets());
      toast.success('Preset deleted');
      setDeleteId(null);
    }
  };

  const handleExport = () => {
    const json = exportPresetsToJson(presets);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `colorfix-presets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Presets exported');
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const { imported, skipped } = importPresetsFromJson(text);
      setPresets(getAllPresets());
      if (imported === 0) {
        toast.error('No valid presets found in file');
        return;
      }
      toast.success(
        `Imported ${imported} preset${imported === 1 ? '' : 's'}${
          skipped ? ` (${skipped} skipped)` : ''
        }`
      );
    } catch {
      toast.error('Failed to import presets — invalid JSON');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main id="main-content" className="container py-6 sm:py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold">Preset Library</h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Manage your saved color calibration presets
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImportFile(file);
                e.target.value = '';
              }}
            />
            <Button variant="outline" className="min-h-10" onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" />
              Import
            </Button>
            {presets.length > 0 && (
              <Button variant="outline" className="min-h-10" onClick={handleExport}>
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            )}
            <Button className="min-h-10" asChild>
              <Link to="/calibrate">
                <Settings2 className="w-4 h-4 mr-2" />
                New Preset
              </Link>
            </Button>
          </div>
        </div>

        {presets.length > 0 && (
          <div className="relative max-w-md w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search presets..."
              className="pl-10 min-h-10"
              aria-label="Search presets"
            />
          </div>
        )}

        {presets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="p-6 rounded-full bg-muted mb-4">
              <BookMarked className="w-12 h-12 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-medium mb-2">No presets yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md">
              Create your first calibration preset to start correcting product photos with consistent
              colors, or import a previously exported library.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <Link to="/calibrate">
                  <Settings2 className="w-5 h-5 mr-2" />
                  Create Your First Preset
                </Link>
              </Button>
              <Button size="lg" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="w-5 h-5 mr-2" />
                Import Presets
              </Button>
            </div>
          </div>
        ) : filteredPresets.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No presets match your search</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredPresets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                onApply={handleApply}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </main>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Preset?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The preset will be permanently removed from your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

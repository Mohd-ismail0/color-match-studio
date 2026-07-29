import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { PresetCard } from '@/components/colorCorrector/PresetCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CalibrationPreset } from '@/types/colorCorrector';
import { getAllPresets, deletePreset } from '@/lib/presetStorage';
import { Settings2, Search, BookMarked } from 'lucide-react';
import { Link } from 'react-router-dom';
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

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Preset Library</h1>
            <p className="text-muted-foreground mt-1">
              Manage your saved color calibration presets
            </p>
          </div>

          <Button asChild>
            <Link to="/calibrate">
              <Settings2 className="w-4 h-4 mr-2" />
              New Preset
            </Link>
          </Button>
        </div>

        {presets.length > 0 && (
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search presets..."
              className="pl-10"
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
              Create your first calibration preset to start correcting product photos with consistent colors.
            </p>
            <Button asChild size="lg">
              <Link to="/calibrate">
                <Settings2 className="w-5 h-5 mr-2" />
                Create Your First Preset
              </Link>
            </Button>
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
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

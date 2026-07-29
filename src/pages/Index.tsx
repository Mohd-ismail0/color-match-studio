import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '@/components/colorCorrector/Header';
import { PresetCard } from '@/components/colorCorrector/PresetCard';
import { getRecentPresets, getAllPresets, deletePreset } from '@/lib/presetStorage';
import { Settings2, Upload, BookMarked, ArrowRight, Sparkles, Shield, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CalibrationPreset } from '@/types/colorCorrector';
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

const Index = () => {
  const navigate = useNavigate();
  const [recentPresets, setRecentPresets] = useState<CalibrationPreset[]>([]);
  const [allPresets, setAllPresets] = useState<CalibrationPreset[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const refreshPresets = useCallback(() => {
    setRecentPresets(getRecentPresets());
    setAllPresets(getAllPresets());
  }, []);

  useEffect(() => {
    refreshPresets();
  }, [refreshPresets]);

  const confirmDelete = () => {
    if (!deleteId) return;
    deletePreset(deleteId);
    refreshPresets();
    toast.success('Preset deleted');
    setDeleteId(null);
  };

  const features = [
    {
      icon: Sparkles,
      title: 'Smart Calibration',
      description: 'Click on your color card to automatically sample and correct colors with precision.',
    },
    {
      icon: Zap,
      title: 'Batch Processing',
      description: 'Process 20-100 product photos at once with consistent color accuracy.',
    },
    {
      icon: Shield,
      title: 'Privacy First',
      description: 'All processing happens in your browser. Your images never leave your device.',
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main id="main-content" className="container py-6 sm:py-8 space-y-10 sm:space-y-12">
        <section className="text-center space-y-4 sm:space-y-6 py-4 sm:py-8">
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight">
            Perfect Product Colors,
            <br />
            <span className="text-primary">Every Time</span>
          </h1>
          <p className="text-base sm:text-xl text-muted-foreground max-w-2xl mx-auto px-1">
            Calibrate your photos using color cards and batch-correct your entire product catalog in
            minutes.
          </p>

          <div className="flex flex-col sm:flex-row flex-wrap justify-center gap-3 sm:gap-4 pt-2 sm:pt-4">
            <Button size="lg" className="w-full sm:w-auto min-h-11" asChild>
              <Link to="/calibrate">
                <Settings2 className="w-5 h-5 mr-2" />
                Start Calibrating
                <ArrowRight className="w-5 h-5 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" className="w-full sm:w-auto min-h-11" asChild>
              <Link to="/batch">
                <Upload className="w-5 h-5 mr-2" />
                Batch Process
              </Link>
            </Button>
          </div>
        </section>

        <section className="grid sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6">
          <Link
            to="/calibrate"
            className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Card className="group h-full hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="p-3 rounded-xl bg-primary/10 w-fit mb-2 group-hover:bg-primary/20 transition-colors">
                  <Settings2 className="w-6 h-6 text-primary" />
                </div>
                <CardTitle>1. Calibrate</CardTitle>
                <CardDescription>
                  Upload a reference photo with your color card and set calibration points.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            to="/presets"
            className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Card className="group h-full hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="p-3 rounded-xl bg-accent/10 w-fit mb-2 group-hover:bg-accent/20 transition-colors">
                  <BookMarked className="w-6 h-6 text-accent" />
                </div>
                <CardTitle>2. Save Preset</CardTitle>
                <CardDescription>
                  Save your calibration as a reusable preset for your shooting environment.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>

          <Link
            to="/batch"
            className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:col-span-2 md:col-span-1"
          >
            <Card className="group h-full hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="p-3 rounded-xl bg-success/10 w-fit mb-2 group-hover:bg-success/20 transition-colors">
                  <Upload className="w-6 h-6 text-success" />
                </div>
                <CardTitle>3. Batch Process</CardTitle>
                <CardDescription>
                  Apply your preset to multiple images and download them all at once.
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        </section>

        <section className="grid sm:grid-cols-2 md:grid-cols-3 gap-6 sm:gap-8 py-4 sm:py-8">
          {features.map((feature) => (
            <div key={feature.title} className="text-center space-y-3">
              <div className="mx-auto p-4 rounded-full bg-muted w-fit">
                <feature.icon className="w-6 h-6 text-foreground" />
              </div>
              <h3 className="font-semibold text-lg">{feature.title}</h3>
              <p className="text-muted-foreground text-sm">{feature.description}</p>
            </div>
          ))}
        </section>

        {recentPresets.length > 0 && (
          <section className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-xl sm:text-2xl font-semibold">Recent Presets</h2>
              <Button variant="ghost" className="self-start sm:self-auto" asChild>
                <Link to="/presets">
                  View All ({allPresets.length})
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Link>
              </Button>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {recentPresets.slice(0, 3).map((preset) => (
                <PresetCard
                  key={preset.id}
                  preset={preset}
                  onApply={() => navigate('/batch', { state: { preset } })}
                  onEdit={() => navigate('/calibrate', { state: { preset } })}
                  onDelete={setDeleteId}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
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
};

export default Index;

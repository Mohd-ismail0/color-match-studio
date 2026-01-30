import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '@/components/colorCorrector/Header';
import { PresetCard } from '@/components/colorCorrector/PresetCard';
import { getRecentPresets, getAllPresets } from '@/lib/presetStorage';
import { Settings2, Upload, BookMarked, ArrowRight, Sparkles, Shield, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { CalibrationPreset } from '@/types/colorCorrector';

const Index = () => {
  const navigate = useNavigate();
  const [recentPresets, setRecentPresets] = useState<CalibrationPreset[]>([]);
  const [allPresets, setAllPresets] = useState<CalibrationPreset[]>([]);

  useEffect(() => {
    setRecentPresets(getRecentPresets());
    setAllPresets(getAllPresets());
  }, []);

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
      
      <main className="container py-8 space-y-12">
        {/* Hero Section */}
        <section className="text-center space-y-6 py-8">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Perfect Product Colors,
            <br />
            <span className="text-primary">Every Time</span>
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Calibrate your photos using color cards and batch-correct your entire product catalog in minutes.
          </p>
          
          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <Button size="lg" asChild>
              <Link to="/calibrate">
                <Settings2 className="w-5 h-5 mr-2" />
                Start Calibrating
                <ArrowRight className="w-5 h-5 ml-2" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/batch">
                <Upload className="w-5 h-5 mr-2" />
                Batch Process
              </Link>
            </Button>
          </div>
        </section>

        {/* Quick Start Cards */}
        <section className="grid md:grid-cols-3 gap-6">
          <Card className="group hover:shadow-lg transition-shadow cursor-pointer" onClick={() => navigate('/calibrate')}>
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

          <Card className="group hover:shadow-lg transition-shadow cursor-pointer" onClick={() => navigate('/presets')}>
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

          <Card className="group hover:shadow-lg transition-shadow cursor-pointer" onClick={() => navigate('/batch')}>
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
        </section>

        {/* Features */}
        <section className="grid md:grid-cols-3 gap-8 py-8">
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

        {/* Recent Presets */}
        {recentPresets.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold">Recent Presets</h2>
              <Button variant="ghost" asChild>
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
                  onDelete={() => {}}
                />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default Index;

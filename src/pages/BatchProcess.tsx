import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { BatchProcessor } from '@/components/colorCorrector/BatchProcessor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CalibrationPreset } from '@/types/colorCorrector';
import { getAllPresets } from '@/lib/presetStorage';
import { Settings2, Check, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function BatchProcess() {
  const location = useLocation();
  const [presets, setPresets] = useState<CalibrationPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<CalibrationPreset | null>(null);

  useEffect(() => {
    setPresets(getAllPresets());
    
    // Check for preset passed from navigation
    const preset = location.state?.preset as CalibrationPreset | undefined;
    if (preset) {
      setSelectedPreset(preset);
    }
  }, [location.state]);

  const handlePresetChange = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    setSelectedPreset(preset || null);
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Batch Processor</h1>
            <p className="text-muted-foreground mt-1">
              Apply color correction to multiple images at once
            </p>
          </div>

          <div className="flex items-center gap-3">
            {presets.length > 0 ? (
              <Select
                value={selectedPreset?.id || ''}
                onValueChange={handlePresetChange}
              >
                <SelectTrigger className="w-[250px]">
                  <SelectValue placeholder="Select a preset" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      <div className="flex items-center gap-2">
                        <span>{preset.name}</span>
                        {preset.id === selectedPreset?.id && (
                          <Check className="w-4 h-4 text-success" />
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Button asChild>
                <Link to="/calibrate">
                  <Settings2 className="w-4 h-4 mr-2" />
                  Create Preset
                </Link>
              </Button>
            )}
          </div>
        </div>

        {/* Selected preset info */}
        {selectedPreset && (
          <Card className="bg-success/5 border-success/20">
            <CardContent className="flex items-center gap-4 py-4">
              <div className="p-2 rounded-full bg-success/10">
                <Check className="w-5 h-5 text-success" />
              </div>
              <div className="flex-1">
                <p className="font-medium">Using: {selectedPreset.name}</p>
                <p className="text-sm text-muted-foreground">
                  {selectedPreset.points.length} calibration points • {selectedPreset.mode === 'advanced' ? 'Multi-point' : '3-point'} mode
                </p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link to="/calibrate" state={{ preset: selectedPreset }}>
                  Edit
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {!selectedPreset && presets.length > 0 && (
          <Card className="bg-warning/5 border-warning/20">
            <CardContent className="flex items-center gap-4 py-4">
              <div className="p-2 rounded-full bg-warning/10">
                <AlertCircle className="w-5 h-5 text-warning" />
              </div>
              <div>
                <p className="font-medium">No preset selected</p>
                <p className="text-sm text-muted-foreground">
                  Choose a preset from the dropdown to start processing images
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {presets.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Settings2 className="w-12 h-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No presets available</h3>
              <p className="text-muted-foreground mb-4">
                Create a calibration preset first to start batch processing
              </p>
              <Button asChild>
                <Link to="/calibrate">
                  <Settings2 className="w-4 h-4 mr-2" />
                  Create Your First Preset
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        <BatchProcessor preset={selectedPreset} />
      </main>
    </div>
  );
}

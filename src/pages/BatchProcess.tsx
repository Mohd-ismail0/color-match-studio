import { useState, useEffect, useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { BatchProcessor } from '@/components/colorCorrector/BatchProcessor';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CalibrationPreset } from '@/types/colorCorrector';
import { getAllPresets, isPresetPersisted } from '@/lib/presetStorage';
import { Settings2, Check, AlertCircle } from 'lucide-react';

export default function BatchProcess() {
  const location = useLocation();
  const [presets, setPresets] = useState<CalibrationPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<CalibrationPreset | null>(null);
  const [transientPreset, setTransientPreset] = useState<CalibrationPreset | null>(null);

  useEffect(() => {
    const stored = getAllPresets();
    setPresets(stored);

    const incoming = location.state?.preset as CalibrationPreset | undefined;
    const markedUnsaved = Boolean(location.state?.unsaved);

    if (incoming?.matrix || (incoming && incoming.points.length > 0)) {
      setSelectedPreset(incoming);
      if (markedUnsaved || !isPresetPersisted(incoming.id)) {
        setTransientPreset(incoming);
      } else {
        setTransientPreset(null);
      }
      return;
    }

    setTransientPreset(null);
    if (stored.length === 1) {
      setSelectedPreset(stored[0]);
    }
  }, [location.state]);

  const selectablePresets = useMemo(() => {
    if (!transientPreset) return presets;
    if (presets.some((p) => p.id === transientPreset.id)) return presets;
    return [transientPreset, ...presets];
  }, [presets, transientPreset]);

  const handlePresetChange = (presetId: string) => {
    const preset = selectablePresets.find((p) => p.id === presetId);
    setSelectedPreset(preset || null);
  };

  const hasAnyPreset = selectablePresets.length > 0 || !!selectedPreset;
  const selectedIsUnsaved =
    !!selectedPreset &&
    (!!transientPreset && transientPreset.id === selectedPreset.id) &&
    !isPresetPersisted(selectedPreset.id);

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main id="main-content" className="container py-6 sm:py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold">Batch Processor</h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Apply color correction to multiple images at once
            </p>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            {hasAnyPreset ? (
              <Select
                value={selectedPreset?.id || undefined}
                onValueChange={handlePresetChange}
              >
                <SelectTrigger className="w-full sm:w-[250px] min-h-10">
                  <SelectValue placeholder="Select a preset" />
                </SelectTrigger>
                <SelectContent>
                  {selectablePresets.map((preset) => {
                    const unsaved =
                      transientPreset?.id === preset.id && !isPresetPersisted(preset.id);
                    return (
                      <SelectItem key={preset.id} value={preset.id}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate">{preset.name}</span>
                          {unsaved && (
                            <span className="text-xs text-muted-foreground shrink-0">(unsaved)</span>
                          )}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : (
              <Button className="w-full sm:w-auto min-h-10" asChild>
                <Link to="/calibrate">
                  <Settings2 className="w-4 h-4 mr-2" />
                  Create Preset
                </Link>
              </Button>
            )}
          </div>
        </div>

        {selectedPreset && (
          <Card className="bg-success/5 border-success/20">
            <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 py-4">
              <div className="p-2 rounded-full bg-success/10 w-fit shrink-0">
                <Check className="w-5 h-5 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">
                  Using: {selectedPreset.name}
                  {selectedIsUnsaved ? ' (unsaved)' : ''}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedPreset.points.length} calibration points •{' '}
                  {selectedPreset.mode === 'advanced' ? 'Multi-point' : '3-point'} mode
                  {!selectedPreset.matrix && ' • Missing matrix'}
                </p>
              </div>
              <Button variant="outline" size="sm" className="w-full sm:w-auto min-h-9" asChild>
                <Link to="/calibrate" state={{ preset: selectedPreset }}>
                  Edit
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {!selectedPreset && hasAnyPreset && (
          <Card className="bg-warning/10 border-warning/30">
            <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 py-4">
              <div className="p-2 rounded-full bg-warning/15 w-fit shrink-0">
                <AlertCircle className="w-5 h-5 text-warning" />
              </div>
              <div className="min-w-0">
                <p className="font-medium">No preset selected</p>
                <p className="text-sm text-muted-foreground">
                  Choose a preset from the dropdown to start processing images
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {!hasAnyPreset && (
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

        {hasAnyPreset && <BatchProcessor preset={selectedPreset} />}
      </main>
    </div>
  );
}

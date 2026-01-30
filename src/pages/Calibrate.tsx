import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { CalibrationCanvas } from '@/components/colorCorrector/CalibrationCanvas';
import { DropZone } from '@/components/colorCorrector/DropZone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ColorPoint, CalibrationPreset, ColorMatrix } from '@/types/colorCorrector';
import { 
  calculateSimpleMatrix, 
  calculateAdvancedMatrix, 
  applyColorCorrectionToImage,
  loadImageToCanvas,
  rgbToHex 
} from '@/lib/colorCorrection';
import { savePreset, generatePresetId } from '@/lib/presetStorage';
import { 
  Save, 
  Eye, 
  EyeOff, 
  Trash2, 
  Upload, 
  ArrowRight,
  Crosshair,
  Info
} from 'lucide-react';
import { toast } from 'sonner';

export default function Calibrate() {
  const location = useLocation();
  const navigate = useNavigate();
  
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [points, setPoints] = useState<ColorPoint[]>([]);
  const [presetName, setPresetName] = useState('');
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [matrix, setMatrix] = useState<ColorMatrix | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [correctedUrl, setCorrectedUrl] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<CalibrationPreset | null>(null);

  // Load preset from navigation state
  useEffect(() => {
    const preset = location.state?.preset as CalibrationPreset | undefined;
    if (preset) {
      setEditingPreset(preset);
      setPoints(preset.points);
      setPresetName(preset.name);
      setMode(preset.mode);
      if (preset.matrix) {
        setMatrix(preset.matrix);
      }
    }
  }, [location.state]);

  // Recalculate matrix when points or mode change
  useEffect(() => {
    if (points.length === 0) {
      setMatrix(null);
      setCorrectedUrl(null);
      return;
    }

    const newMatrix = mode === 'advanced' 
      ? calculateAdvancedMatrix(points) 
      : calculateSimpleMatrix(points);
    setMatrix(newMatrix);
  }, [points, mode]);

  // Generate preview when matrix changes
  useEffect(() => {
    if (!matrix || !imageFile || !showPreview) {
      setCorrectedUrl(null);
      return;
    }

    const generatePreview = async () => {
      try {
        const canvas = await loadImageToCanvas(imageFile);
        const correctedCanvas = applyColorCorrectionToImage(canvas, matrix);
        const url = correctedCanvas.toDataURL('image/jpeg', 0.9);
        setCorrectedUrl(url);
      } catch (error) {
        console.error('Failed to generate preview:', error);
      }
    };

    generatePreview();
  }, [matrix, imageFile, showPreview]);

  const handleFileSelected = useCallback((files: File[]) => {
    if (files.length > 0) {
      const file = files[0];
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      setImageUrl(URL.createObjectURL(file));
      setImageFile(file);
      setPoints([]);
      setCorrectedUrl(null);
    }
  }, [imageUrl]);

  const handleClearAll = useCallback(() => {
    setPoints([]);
    setMatrix(null);
    setCorrectedUrl(null);
  }, []);

  const handleSavePreset = useCallback(() => {
    if (!presetName.trim()) {
      toast.error('Please enter a preset name');
      return;
    }
    if (points.length === 0) {
      toast.error('Please add at least one calibration point');
      return;
    }

    const preset: CalibrationPreset = {
      id: editingPreset?.id || generatePresetId(),
      name: presetName.trim(),
      createdAt: editingPreset?.createdAt || Date.now(),
      updatedAt: Date.now(),
      points,
      matrix,
      mode,
    };

    savePreset(preset);
    toast.success(`Preset "${presetName}" saved successfully!`);
    
    if (!editingPreset) {
      setEditingPreset(preset);
    }
  }, [presetName, points, matrix, mode, editingPreset]);

  const handleApplyToBatch = useCallback(() => {
    if (!matrix) {
      toast.error('Please calibrate first');
      return;
    }

    const preset: CalibrationPreset = {
      id: editingPreset?.id || generatePresetId(),
      name: presetName.trim() || 'Unsaved Preset',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      points,
      matrix,
      mode,
    };

    navigate('/batch', { state: { preset } });
  }, [matrix, editingPreset, presetName, points, mode, navigate]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Calibration Studio</h1>
            <p className="text-muted-foreground mt-1">
              Upload a reference image and click to place calibration points
            </p>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main canvas area */}
          <div className="lg:col-span-2 space-y-4">
            {!imageUrl ? (
              <DropZone
                onFilesSelected={handleFileSelected}
                className="min-h-[400px]"
              >
                <div className="flex flex-col items-center gap-4 p-12 text-center">
                  <div className="p-6 rounded-full bg-muted">
                    <Upload className="w-10 h-10 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-xl font-medium">Upload Reference Image</p>
                    <p className="text-muted-foreground mt-1">
                      Choose a photo with your color card visible
                    </p>
                  </div>
                </div>
              </DropZone>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowPreview(!showPreview)}
                      disabled={!matrix}
                    >
                      {showPreview ? (
                        <>
                          <EyeOff className="w-4 h-4 mr-2" />
                          Show Original
                        </>
                      ) : (
                        <>
                          <Eye className="w-4 h-4 mr-2" />
                          Preview Correction
                        </>
                      )}
                    </Button>
                    
                    <Button variant="ghost" size="sm" onClick={handleClearAll}>
                      <Trash2 className="w-4 h-4 mr-2" />
                      Clear Points
                    </Button>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (imageUrl) URL.revokeObjectURL(imageUrl);
                      setImageUrl(null);
                      setImageFile(null);
                      setPoints([]);
                    }}
                  >
                    Change Image
                  </Button>
                </div>

                <CalibrationCanvas
                  imageUrl={imageUrl}
                  points={points}
                  onPointsChange={setPoints}
                  showCorrected={showPreview}
                  correctedImageUrl={correctedUrl || undefined}
                  className="shadow-lg"
                />

                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
                  <Crosshair className="w-4 h-4 flex-shrink-0" />
                  <span>Click on the image to add calibration points. Click on a point to edit its target color.</span>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar controls */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Calibration Mode</CardTitle>
              </CardHeader>
              <CardContent>
                <Tabs value={mode} onValueChange={(v) => setMode(v as 'simple' | 'advanced')}>
                  <TabsList className="grid grid-cols-2 w-full">
                    <TabsTrigger value="simple">3-Point</TabsTrigger>
                    <TabsTrigger value="advanced">Multi-Point</TabsTrigger>
                  </TabsList>
                  <TabsContent value="simple" className="mt-3">
                    <p className="text-sm text-muted-foreground">
                      Quick white balance correction using white, grey, and black points.
                    </p>
                  </TabsContent>
                  <TabsContent value="advanced" className="mt-3">
                    <p className="text-sm text-muted-foreground">
                      Advanced color matching using multiple reference points for higher accuracy.
                    </p>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Calibration Points</CardTitle>
                <CardDescription>
                  {points.length === 0 
                    ? 'Click on the image to add points'
                    : `${points.length} point${points.length === 1 ? '' : 's'} defined`
                  }
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {points.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground">
                    <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No points added yet</p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[200px] overflow-y-auto">
                    {points.map((point) => (
                      <div
                        key={point.id}
                        className="flex items-center gap-3 p-2 rounded-lg bg-muted/50"
                      >
                        <div
                          className="w-6 h-6 rounded border border-border flex-shrink-0"
                          style={{ backgroundColor: rgbToHex(point.sampledColor) }}
                        />
                        <span className="text-sm flex-1 truncate">{point.label}</span>
                        <div
                          className="w-6 h-6 rounded border border-border flex-shrink-0"
                          style={{ backgroundColor: rgbToHex(point.targetColor) }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Save Preset</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="preset-name">Preset Name</Label>
                  <Input
                    id="preset-name"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="e.g., Studio Light Setup"
                  />
                </div>
                
                <div className="flex flex-col gap-2">
                  <Button onClick={handleSavePreset} disabled={points.length === 0}>
                    <Save className="w-4 h-4 mr-2" />
                    {editingPreset ? 'Update Preset' : 'Save Preset'}
                  </Button>
                  
                  <Button 
                    variant="outline" 
                    onClick={handleApplyToBatch}
                    disabled={!matrix}
                  >
                    Apply to Batch
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

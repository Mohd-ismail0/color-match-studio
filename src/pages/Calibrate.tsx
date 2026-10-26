import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { CalibrationCanvas } from '@/components/colorCorrector/CalibrationCanvas';
import { DropZone } from '@/components/colorCorrector/DropZone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ColorPoint, CalibrationPreset, ColorMatrix, MatrixFitResult } from '@/types/colorCorrector';
import {
  calculateMatrixDetailed,
  applyColorCorrectionToImage,
  loadImageToCanvas,
  rgbToHex,
  sampleColorFromCanvas,
  inferPointRole,
} from '@/lib/colorCorrection';
import {
  buildTransientPreset,
  generatePresetId,
  savePreset,
} from '@/lib/presetStorage';
import { ALGORITHM_VERSION } from '@/lib/calibrationLimits';
import { revisionFingerprint } from '@/lib/matrixFingerprint';
import {
  Save,
  Eye,
  EyeOff,
  Trash2,
  Upload,
  ArrowRight,
  Crosshair,
  Info,
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
  const [fitWarning, setFitWarning] = useState<string | null>(null);
  const [fit, setFit] = useState<MatrixFitResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [correctedUrl, setCorrectedUrl] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<CalibrationPreset | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const previewCanvasRef = useRef<{ file: File; canvas: HTMLCanvasElement } | null>(null);
  const preservePointsOnNextImageRef = useRef(false);
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => {
    return () => {
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const preset = location.state?.preset as CalibrationPreset | undefined;
    if (preset) {
      setEditingPreset(preset);
      setPoints(
        preset.points.map((p) => ({
          ...p,
          role: p.role ?? inferPointRole(p.label),
        }))
      );
      setPresetName(preset.name);
      setMode(preset.mode);
      if (preset.matrix) {
        setMatrix(preset.matrix);
      }
      // Next uploaded reference image should re-sample, not wipe points
      preservePointsOnNextImageRef.current = true;
    }
  }, [location.state]);

  useEffect(() => {
    if (points.length === 0) {
      setMatrix(null);
      setFit(null);
      setFitWarning(null);
      setCorrectedUrl(null);
      return;
    }

    const result = calculateMatrixDetailed(points, mode);
    setMatrix(result.matrix);
    setFit(result);
    setFitWarning(result.warning ?? null);
  }, [points, mode]);

  useEffect(() => {
    if (!matrix || !imageFile || !showPreview) {
      setCorrectedUrl((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    let cancelled = false;

    const generatePreview = async () => {
      try {
        let cached = previewCanvasRef.current;
        if (!cached || cached.file !== imageFile) {
          const canvas = await loadImageToCanvas(imageFile);
          cached = { file: imageFile, canvas };
          previewCanvasRef.current = cached;
        }
        if (cancelled) return;
        const correctedCanvas = applyColorCorrectionToImage(cached.canvas, matrix);
        const blob = await new Promise<Blob | null>((resolve) =>
          correctedCanvas.toBlob(resolve, 'image/jpeg', 0.9)
        );
        if (cancelled || !blob) return;
        const url = URL.createObjectURL(blob);
        setCorrectedUrl((prev) => {
          if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
          return url;
        });
      } catch (error) {
        console.error('Failed to generate preview:', error);
        if (!cancelled) {
          toast.error('Failed to generate preview');
        }
      }
    };

    // Debounce so dragging a point does not re-run a full-res pass per step.
    const timer = window.setTimeout(generatePreview, 250);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [matrix, imageFile, showPreview]);

  const resamplePoints = useCallback((canvas: HTMLCanvasElement, sourcePoints: ColorPoint[]) => {
    return sourcePoints.map((p) => ({
      ...p,
      sampledColor: sampleColorFromCanvas(canvas, p.x * canvas.width, p.y * canvas.height, 7),
      role: p.role ?? inferPointRole(p.label),
    }));
  }, []);

  const handleSamplingCanvasReady = useCallback(
    (canvas: HTMLCanvasElement) => {
      if (!preservePointsOnNextImageRef.current) return;
      preservePointsOnNextImageRef.current = false;
      const current = pointsRef.current;
      if (current.length === 0) return;
      setPoints(resamplePoints(canvas, current));
      toast.success('Re-sampled calibration points on the new image');
    },
    [resamplePoints]
  );

  const handleFileSelected = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      toast.error('Please upload a raster image (JPEG, PNG, WebP, etc.)');
      return;
    }
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    imageUrlRef.current = url;
    setImageUrl(url);
    setImageFile(file);

    if (!preservePointsOnNextImageRef.current) {
      setPoints([]);
    }
    setCorrectedUrl(null);
    setShowPreview(false);
  }, []);

  const handleClearAll = useCallback(() => {
    setPoints([]);
    setMatrix(null);
    setFit(null);
    setFitWarning(null);
    setCorrectedUrl(null);
  }, []);

  const handleChangeImage = useCallback(() => {
    // Keep points when swapping reference while editing
    if (pointsRef.current.length > 0) {
      preservePointsOnNextImageRef.current = true;
    }
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    }
    previewCanvasRef.current = null;
    setImageUrl(null);
    setImageFile(null);
    setCorrectedUrl(null);
    setShowPreview(false);
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
    if (!matrix) {
      toast.error('Calibration matrix is not ready yet');
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

    try {
      const saved = savePreset(preset);
      setEditingPreset(saved);
      toast.success(
        `Preset "${saved.name}" saved as revision ${saved.currentRevision ?? 1}.`
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save preset.');
    }
  }, [presetName, points, matrix, mode, editingPreset]);

  const handleApplyToBatch = useCallback(() => {
    if (!matrix) {
      toast.error('Please calibrate first');
      return;
    }

    // Always hand the batch page an explicit revision, never an implicit
    // "latest". If the current points/matrix differ from the saved revision,
    // use an in-memory revision instead of silently applying stale content.
    const currentFingerprint = revisionFingerprint({
      algorithmVersion: ALGORITHM_VERSION,
      mode,
      points,
      matrix,
    });
    const savedRevision = editingPreset?.revisions?.find(
      (r) => r.revision === editingPreset.currentRevision
    );
    const target =
      editingPreset && savedRevision && savedRevision.fingerprint === currentFingerprint
        ? editingPreset
        : buildTransientPreset({
            name: presetName.trim() || 'Unsaved Preset',
            points,
            matrix,
            mode,
          });
    const revision = target.currentRevision ?? target.revisions?.[0]?.revision ?? 1;

    navigate('/batch', {
      state: { preset: target, revision, unsaved: !editingPreset },
    });
  }, [matrix, editingPreset, presetName, points, mode, navigate]);

  const modeHint =
    mode === 'simple'
      ? 'Locks White/Black levels in linear light. Add Grey or switch to Multi-Point for richer matching.'
      : points.length < 3
        ? 'Add at least 3 colorful patches for multi-point matching (4+ recommended).'
        : points.length < 4
          ? 'Using a 3×3 linear matrix. Add a 4th point to include offset.'
          : 'Least-squares 3×3 matrix with offset in linear sRGB (uses all patches including Grey).';

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main id="main-content" className="container py-6 sm:py-8 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold">Calibration Studio</h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Upload a reference image and click to place calibration points
            </p>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4 min-w-0">
            {!imageUrl ? (
              <DropZone onFilesSelected={handleFileSelected} className="min-h-[280px] sm:min-h-[400px]">
                <div className="flex flex-col items-center gap-4 p-6 sm:p-12 text-center">
                  <div className="p-4 sm:p-6 rounded-full bg-muted">
                    <Upload className="w-8 h-8 sm:w-10 sm:h-10 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-lg sm:text-xl font-medium">Upload Reference Image</p>
                    <p className="text-muted-foreground mt-1 text-sm sm:text-base">
                      {editingPreset
                        ? `Editing "${editingPreset.name}" — upload a reference image to adjust points`
                        : 'Choose a photo with your color card visible'}
                    </p>
                  </div>
                </div>
              </DropZone>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-9"
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

                    <Button variant="ghost" size="sm" className="min-h-9" onClick={handleClearAll}>
                      <Trash2 className="w-4 h-4 mr-2" />
                      Clear Points
                    </Button>
                  </div>

                  <Button variant="ghost" size="sm" className="min-h-9 self-start" onClick={handleChangeImage}>
                    Change Image
                  </Button>
                </div>

                <CalibrationCanvas
                  imageUrl={imageUrl}
                  points={points}
                  onPointsChange={setPoints}
                  showCorrected={showPreview}
                  correctedImageUrl={correctedUrl || undefined}
                  onSamplingCanvasReady={handleSamplingCanvasReady}
                  className="shadow-lg"
                />

                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
                  <Crosshair className="w-4 h-4 flex-shrink-0" />
                  <span>
                    Click to add points, drag them to resample colors, and click a point to edit its
                    label, target color, or delete it.
                  </span>
                </div>
              </div>
            )}
          </div>

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
                    <p className="text-sm text-muted-foreground">{modeHint}</p>
                  </TabsContent>
                  <TabsContent value="advanced" className="mt-3">
                    <p className="text-sm text-muted-foreground">{modeHint}</p>
                  </TabsContent>
                </Tabs>
                {fitWarning && (
                  <p className="text-xs text-foreground mt-3 rounded-md bg-warning/15 border border-warning/40 p-2">
                    {fitWarning}
                  </p>
                )}
                {fit && fit.warnings.length > 1 && (
                  <ul className="text-xs text-muted-foreground mt-2 space-y-1 list-disc pl-4">
                    {fit.warnings.slice(1).map((notice, index) => (
                      <li key={index}>{notice}</li>
                    ))}
                  </ul>
                )}
                {fit && (
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <dt>Chromatic patches</dt>
                    <dd className="text-right">{fit.diagnostics.chromaticSamples}</dd>
                    <dt>Cond. ratio</dt>
                    <dd className="text-right">
                      {fit.diagnostics.conditioningRatio === null
                        ? 'n/a'
                        : fit.diagnostics.conditioningRatio.toExponential(1)}
                    </dd>
                    <dt>Clipping (probe)</dt>
                    <dd className="text-right">
                      {(fit.diagnostics.clippingForecast * 100).toFixed(0)}%
                    </dd>
                    <dt>Fallback used</dt>
                    <dd className="text-right">
                      {fit.diagnostics.destructiveFallback
                        ? 'yes (identity)'
                        : fit.fellBackToSimple
                          ? 'simple'
                          : 'no'}
                    </dd>
                  </dl>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Calibration Points</CardTitle>
                <CardDescription>
                  {points.length === 0
                    ? 'Click on the image to add points'
                    : `${points.length} point${points.length === 1 ? '' : 's'} defined`}
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
                          title="Sampled"
                        />
                        <span className="text-sm flex-1 truncate">{point.label}</span>
                        <div
                          className="w-6 h-6 rounded border border-border flex-shrink-0"
                          style={{ backgroundColor: rgbToHex(point.targetColor) }}
                          title="Target"
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
                  <Button onClick={handleSavePreset} disabled={points.length === 0 || !matrix}>
                    <Save className="w-4 h-4 mr-2" />
                    {editingPreset ? 'Update Preset' : 'Save Preset'}
                  </Button>

                  <Button variant="outline" onClick={handleApplyToBatch} disabled={!matrix}>
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

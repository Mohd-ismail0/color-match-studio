import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/colorCorrector/Header';
import { CalibrationCanvas } from '@/components/colorCorrector/CalibrationCanvas';
import { DropZone } from '@/components/colorCorrector/DropZone';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ColorPoint } from '@/types/colorCorrector';
import { inferPointRole, rgbToHex, sampleColorFromCanvas } from '@/lib/colorCorrection';
import { IMAGE_LIMITS } from '@/lib/calibrationLimits';
import {
  encodePreset,
  formatPresetForDisplay,
  presetTierFor,
  quantiseColour,
  type PresetRole,
} from '@/lib/presetCode';
import { Copy, Check, Upload, Crosshair, Trash2, Info, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Public calibration page.
 *
 * Everything happens in the browser: pick points on your reference card, type
 * the colour each patch is supposed to be, and get a self-contained code. No
 * account, no upload, no server round-trip. The code is the only thing that
 * leaves the device, and it carries the measurements rather than a pre-baked
 * matrix, so the server re-derives and re-checks the correction itself.
 */

const TIER_LABEL: Record<string, string> = {
  a: 'Single point — quick white balance only',
  b: 'Two points — black and white levels',
  c: 'Multi-point — 3 to 5 patches, good for garments',
  d: 'Full card — 6 or more patches, best accuracy',
};

interface EditablePoint extends ColorPoint {
  /** Hex the user says this patch should be, before any camera cast. */
  targetHex: string;
}

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
};

export default function PublicCalibrate() {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [points, setPoints] = useState<EditablePoint[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [roleHintShown, setRoleHintShown] = useState(false);
  const [encodeError, setEncodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const imageUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    []
  );

  const handleFileSelected = useCallback((files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      toast.error('Please choose a photo (JPEG, PNG or WebP)');
      return;
    }
    if (file.size > IMAGE_LIMITS.maxInputBytes) {
      toast.error('That photo is too large — use a smaller export of the card');
      return;
    }
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    const url = URL.createObjectURL(file);
    imageUrlRef.current = url;
    setImageUrl(url);
    setPoints([]);
    setCode(null);
    setEncodeError(null);
  }, []);

  const updatePoint = useCallback((id: string, patch: Partial<EditablePoint>) => {
    setPoints((current) => current.map((point) => (point.id === id ? { ...point, ...patch } : point)));
    setCode(null);
    setEncodeError(null);
  }, []);

  const removePoint = useCallback((id: string) => {
    setPoints((current) => current.filter((point) => point.id !== id));
    setCode(null);
  }, []);

  const generate = useCallback(() => {
    try {
      const patches = points.map((point) => {
        const target = hexToRgb(point.targetHex);
        if (!target) {
          throw new Error(`${point.label}: target colour must be a 6-digit hex value`);
        }
        return {
          // Quantise before encoding so the code reproduces exactly what the
          // browser fitted, rather than approximately.
          sampledColor: quantiseColour(point.sampledColor),
          targetColor: quantiseColour(target),
          role: (point.role ?? 'custom') as PresetRole,
        };
      });
      const tier = presetTierFor(patches.length);
      setCode(encodePreset(patches, tier));
      setEncodeError(null);
    } catch (error) {
      setCode(null);
      setEncodeError(error instanceof Error ? error.message : 'Could not build a code');
    }
  }, [points]);

  const copyCode = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success('Calibration code copied');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed — select the code and copy it manually');
    }
  }, [code]);

  const tier = useMemo(() => presetTierFor(points.length), [points.length]);
  const neutralPoints = useMemo(
    () => points.filter((point) => ['white', 'grey', 'black'].includes(point.role ?? '')).length,
    [points]
  );

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main id="main-content" className="container py-6 sm:py-8 space-y-6">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold">Calibrate your photos</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Photograph your colour card, mark each patch, and get a short code. Nothing is uploaded —
            the measurements stay in your browser until you copy the code.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4 min-w-0">
            {!imageUrl ? (
              <DropZone
                onFilesSelected={handleFileSelected}
                className="min-h-[280px] sm:min-h-[400px]"
              >
                <div className="flex flex-col items-center gap-4 p-6 sm:p-12 text-center">
                  <div className="p-4 sm:p-6 rounded-full bg-muted">
                    <Upload className="w-8 h-8 sm:w-10 sm:h-10 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-lg sm:text-xl font-medium">Add your reference card photo</p>
                    <p className="text-muted-foreground mt-1 text-sm sm:text-base">
                      Include the whole card, evenly lit, with no strong reflections
                    </p>
                  </div>
                </div>
              </DropZone>
            ) : (
              <div className="space-y-3">
                <CalibrationCanvas
                  imageUrl={imageUrl}
                  points={points}
                  onPointsChange={(next) => {
                    // The canvas assigns roles and default targets; we only add the
                    // editable hex so the user can state what each patch should be.
                    setPoints(
                      next.map((point) => {
                        const existing = points.find((candidate) => candidate.id === point.id);
                        return {
                          ...point,
                          targetHex: existing?.targetHex ?? rgbToHex(point.targetColor),
                        };
                      })
                    );
                    setCode(null);
                    setEncodeError(null);
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <Crosshair className="w-3 h-3" />
                    {points.length} patch{points.length === 1 ? '' : 'es'}
                  </Badge>
                  {neutralPoints === 0 && points.length > 0 && (
                    <Badge variant="outline" className="gap-1 text-amber-600">
                      <AlertTriangle className="w-3 h-3" />
                      No white, grey or black patch
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPoints([]);
                      setCode(null);
                    }}
                    disabled={points.length === 0}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Clear patches
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4 min-w-0">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Patches</CardTitle>
                <CardDescription>
                  Tap the photo to mark a patch, then type the colour that patch is meant to be.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {points.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Start with the white patch, then grey and black, then one or two colours.
                  </p>
                )}
                {points.map((point) => (
                  <div key={point.id} className="rounded-md border p-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="h-5 w-5 shrink-0 rounded border"
                          style={{ backgroundColor: rgbToHex(point.sampledColor) }}
                          aria-hidden
                        />
                        <span className="text-sm font-medium truncate">{point.label}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${point.label}`}
                        onClick={() => removePoint(point.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="flex items-center gap-1">
                      <Label htmlFor={`role-${point.id}`} className="text-xs text-muted-foreground">
                        Patch
                      </Label>
                      <select
                        id={`role-${point.id}`}
                        className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
                        value={point.role ?? 'custom'}
                        onChange={(event) =>
                          updatePoint(point.id, { role: event.target.value as PresetRole })
                        }
                      >
                        <option value="white">White</option>
                        <option value="grey">Grey</option>
                        <option value="black">Black</option>
                        <option value="custom">Colour</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2 items-end">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Measured</Label>
                        <div className="text-xs font-mono">
                          {rgbToHex(quantiseColour(point.sampledColor))}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`target-${point.id}`} className="text-xs">
                          Should be
                        </Label>
                        <div className="flex items-center gap-1">
                          <input
                            type="color"
                            aria-label={`${point.label} target colour picker`}
                            className="h-8 w-8 rounded border bg-transparent"
                            value={/^#[0-9a-f]{6}$/i.test(point.targetHex) ? point.targetHex : '#808080'}
                            onChange={(event) =>
                              updatePoint(point.id, { targetHex: event.target.value.toUpperCase() })
                            }
                          />
                          <Input
                            id={`target-${point.id}`}
                            className="h-8 font-mono text-xs"
                            value={point.targetHex}
                            onChange={(event) => updatePoint(point.id, { targetHex: event.target.value })}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Your code</CardTitle>
                <CardDescription>{TIER_LABEL[tier]}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button className="w-full" onClick={generate} disabled={points.length === 0}>
                  Build calibration code
                </Button>
                {encodeError && (
                  <p className="text-sm text-destructive flex items-start gap-1">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    {encodeError}
                  </p>
                )}
                {code && (
                  <>
                    <code className="block break-all rounded bg-muted p-2 font-mono text-xs">
                      {formatPresetForDisplay(code)}
                    </code>
                    <Button variant="outline" className="w-full" onClick={copyCode}>
                      {copied ? <Check className="w-4 h-4 mr-2" /> : <Copy className="w-4 h-4 mr-2" />}
                      {copied ? 'Copied' : 'Copy code'}
                    </Button>
                  </>
                )}
                <p className="text-xs text-muted-foreground flex items-start gap-1">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  Give this code to whoever corrects your photos, or paste it when correcting an image.
                  It carries your measurements and each patch&apos;s role, not a fixed preset.
                </p>
                {points.length > 0 && neutralPoints === 0 && (
                  <p className="text-xs text-amber-600 flex items-start gap-1">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    Mark your white, grey and black patches — without an anchor the correction is
                    noticeably weaker, and a colour-only card cannot set exposure.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

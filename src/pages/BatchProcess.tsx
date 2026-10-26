import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { Header } from '@/components/colorCorrector/Header';
import { BatchProcessor } from '@/components/colorCorrector/BatchProcessor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CalibrationPreset,
  CalibrationRevision,
  CalibrationSelection,
} from '@/types/colorCorrector';
import { getAllPresets, isPresetPersisted } from '@/lib/presetStorage';
import {
  CalibrationApiError,
  getCalibrationProfile,
  getCalibrationRevision,
  listCalibrationProfiles,
  presetFromApiRevision,
  type ApiProfileDetail,
  type ApiProfileSummary,
} from '@/lib/calibrationApi';
import { Settings2, Check, AlertCircle, CloudDownload, Fingerprint } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

const API_BASE_KEY = 'colorApiBaseUrl';
const API_TOKEN_KEY = 'colorApiToken';

function revisionLabel(revision: CalibrationRevision): string {
  return `rev ${revision.revision} • ${revision.mode === 'advanced' ? 'multi-point' : '3-point'} • ${formatDistanceToNow(
    revision.createdAt,
    { addSuffix: true }
  )} • ${revision.fingerprint.slice(0, 8)}`;
}

export default function BatchProcess() {
  const location = useLocation();
  const [presets, setPresets] = useState<CalibrationPreset[]>([]);
  const [transientPresets, setTransientPresets] = useState<CalibrationPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [selectedRevisionNumber, setSelectedRevisionNumber] = useState<number | null>(null);

  const [apiBaseUrl, setApiBaseUrl] = useState(
    () => sessionStorage.getItem(API_BASE_KEY) || 'http://127.0.0.1:8081'
  );
  const [apiToken, setApiToken] = useState(() => sessionStorage.getItem(API_TOKEN_KEY) || '');
  const [apiProfiles, setApiProfiles] = useState<ApiProfileSummary[]>([]);
  const [apiProfileId, setApiProfileId] = useState('');
  const [apiProfile, setApiProfile] = useState<ApiProfileDetail | null>(null);
  const [apiRevisionNumber, setApiRevisionNumber] = useState<number | null>(null);
  const [apiPreset, setApiPreset] = useState<CalibrationPreset | null>(null);
  const [apiBusy, setApiBusy] = useState(false);

  useEffect(() => {
    const stored = getAllPresets();
    setPresets(stored);

    const incoming = location.state?.preset as CalibrationPreset | undefined;
    const incomingRevision = location.state?.revision as number | undefined;
    const incomingPresetId = location.state?.presetId as string | undefined;
    if (incoming) {
      // Only an explicit revision supplied by the calibrate page is selected.
      // No component here ever falls back to "latest".
      setSelectedPresetId(incoming.id);
      setSelectedRevisionNumber(
        Number.isInteger(incomingRevision) ? (incomingRevision as number) : null
      );
      if (!isPresetPersisted(incoming.id)) {
        setTransientPresets([incoming]);
      } else {
        setTransientPresets([]);
      }
      setApiPreset(null);
      setApiProfile(null);
      setApiRevisionNumber(null);
      return;
    }

    if (incomingPresetId && stored.some((p) => p.id === incomingPresetId)) {
      // Coming from the preset library: pick the profile, but require the user
      // to choose an explicit revision unless one was supplied deliberately.
      setSelectedPresetId(incomingPresetId);
      setSelectedRevisionNumber(
        Number.isInteger(incomingRevision) ? (incomingRevision as number) : null
      );
      setTransientPresets([]);
      setApiPreset(null);
      return;
    }

    setTransientPresets([]);
  }, [location.state]);

  const selectablePresets = useMemo(() => {
    if (transientPresets.length === 0) return presets;
    const ids = new Set(presets.map((p) => p.id));
    return [...transientPresets.filter((p) => !ids.has(p.id)), ...presets];
  }, [presets, transientPresets]);

  const selectedPreset = selectablePresets.find((p) => p.id === selectedPresetId) ?? null;

  const selectedRevision =
    selectedPreset?.revisions?.find((r) => r.revision === selectedRevisionNumber) ?? null;

  const selection: CalibrationSelection | null = useMemo(() => {
    if (apiPreset) {
      const revision = apiPreset.revisions?.[0];
      if (!revision) return null;
      return { presetId: apiPreset.id, presetName: apiPreset.name, revision };
    }
    if (!selectedPreset || !selectedRevision) return null;
    return {
      presetId: selectedPreset.id,
      presetName: selectedPreset.name,
      revision: selectedRevision,
    };
  }, [apiPreset, selectedPreset, selectedRevision]);

  const handlePresetChange = (presetId: string) => {
    setApiPreset(null);
    setSelectedPresetId(presetId);
    setSelectedRevisionNumber(null);
  };

  const rememberApiSettings = (baseUrl: string, token: string) => {
    sessionStorage.setItem(API_BASE_KEY, baseUrl);
    if (token) sessionStorage.setItem(API_TOKEN_KEY, token);
    else sessionStorage.removeItem(API_TOKEN_KEY);
  };

  const loadApiProfiles = useCallback(async () => {
    setApiBusy(true);
    try {
      rememberApiSettings(apiBaseUrl, apiToken);
      const profiles = await listCalibrationProfiles(apiBaseUrl, apiToken);
      setApiProfiles(profiles);
      setApiProfileId('');
      setApiProfile(null);
      setApiRevisionNumber(null);
      toast.success(`Loaded ${profiles.length} API calibration profile(s)`);
    } catch (error) {
      toast.error(error instanceof CalibrationApiError ? error.message : 'Failed to load profiles');
    } finally {
      setApiBusy(false);
    }
  }, [apiBaseUrl, apiToken]);

  const loadApiProfile = useCallback(
    async (profileId: string) => {
      setApiProfileId(profileId);
      setApiProfile(null);
      setApiRevisionNumber(null);
      setApiPreset(null);
      if (!profileId) return;
      setApiBusy(true);
      try {
        const profile = await getCalibrationProfile(apiBaseUrl, apiToken, profileId);
        setApiProfile(profile);
      } catch (error) {
        toast.error(error instanceof CalibrationApiError ? error.message : 'Failed to load profile');
      } finally {
        setApiBusy(false);
      }
    },
    [apiBaseUrl, apiToken]
  );

  const useApiRevision = useCallback(async () => {
    if (!apiProfileId || !apiRevisionNumber) return;
    setApiBusy(true);
    try {
      const revision = await getCalibrationRevision(
        apiBaseUrl,
        apiToken,
        apiProfileId,
        apiRevisionNumber
      );
      const profile =
        apiProfile ?? {
          id: apiProfileId,
          name: apiProfileId,
          createdAt: revision.createdAt,
          updatedAt: revision.createdAt,
          latestRevision: revision.revision,
          revisionCount: 1,
          revisions: [],
        };
      const preset = presetFromApiRevision(profile, revision);
      setApiPreset(preset);
      setSelectedPresetId('');
      setSelectedRevisionNumber(null);
      toast.success(`Selected ${profile.name} revision ${revision.revision}`);
    } catch (error) {
      toast.error(error instanceof CalibrationApiError ? error.message : 'Failed to load revision');
    } finally {
      setApiBusy(false);
    }
  }, [apiBaseUrl, apiToken, apiProfileId, apiRevisionNumber, apiProfile]);

  const hasAnyPreset = selectablePresets.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main id="main-content" className="container py-6 sm:py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold">Batch Processor</h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Select a saved calibration profile and an explicit revision, then correct locally in
              your browser.
            </p>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            {hasAnyPreset ? (
              <Select value={selectedPresetId || undefined} onValueChange={handlePresetChange}>
                <SelectTrigger className="w-full sm:w-[260px] min-h-10">
                  <SelectValue placeholder="Select a calibration preset" />
                </SelectTrigger>
                <SelectContent>
                  {selectablePresets.map((preset) => {
                    const unsaved =
                      transientPresets.some((p) => p.id === preset.id) &&
                      !isPresetPersisted(preset.id);
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
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="revision-select" className="text-xs text-muted-foreground">
                Revision (required — never implicit)
              </Label>
              <Select
                value={selectedRevisionNumber === null ? undefined : String(selectedRevisionNumber)}
                onValueChange={(v) => setSelectedRevisionNumber(Number(v))}
              >
                <SelectTrigger id="revision-select" className="w-full min-h-10">
                  <SelectValue placeholder="Select a revision" />
                </SelectTrigger>
                <SelectContent>
                  {(selectedPreset.revisions ?? [])
                    .slice()
                    .sort((a, b) => b.revision - a.revision)
                    .map((revision) => (
                      <SelectItem key={revision.revision} value={String(revision.revision)}>
                        {revisionLabel(revision)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {(selectedPreset.revisions?.length ?? 0) === 0 && (
                <p className="text-xs text-destructive">
                  This preset has no saved revisions. Reopen it in Calibrate and save once.
                </p>
              )}
            </div>
          </div>
        )}

        {selection && (
          <Card className="bg-success/5 border-success/20">
            <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 py-4">
              <div className="p-2 rounded-full bg-success/10 w-fit shrink-0">
                <Check className="w-5 h-5 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">
                  Using: {selection.presetName} — revision {selection.revision.revision}
                </p>
                <p className="text-sm text-muted-foreground">
                  {selection.revision.mode === 'advanced' ? 'Multi-point' : '3-point'} •{' '}
                  {selection.revision.points.length} points •{' '}
                  {selection.revision.provenance.warnings.length} warning
                  {selection.revision.provenance.warnings.length === 1 ? '' : 's'} • algorithm{' '}
                  {selection.revision.algorithmVersion}
                </p>
                <p className="text-xs text-muted-foreground font-mono truncate flex items-center gap-1 mt-1">
                  <Fingerprint className="w-3 h-3 shrink-0" aria-hidden="true" />
                  {selection.revision.fingerprint}
                </p>
              </div>
              {!apiPreset && (
                <Button variant="outline" size="sm" className="w-full sm:w-auto min-h-9" asChild>
                  <Link to="/calibrate" state={{ preset: selectedPreset }}>
                    Edit
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {hasAnyPreset && !selection && (
          <Card className="bg-warning/10 border-warning/30">
            <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 py-4">
              <div className="p-2 rounded-full bg-warning/15 w-fit shrink-0">
                <AlertCircle className="w-5 h-5 text-warning" />
              </div>
              <div className="min-w-0">
                <p className="font-medium">No revision selected</p>
                <p className="text-sm text-muted-foreground">
                  Choose a preset and then a specific revision. Batch results are always tied to that
                  revision's fingerprint.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CloudDownload className="w-4 h-4" aria-hidden="true" />
              Load calibration from API
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="api-base" className="text-xs text-muted-foreground">
                  API base URL (loopback)
                </Label>
                <Input
                  id="api-base"
                  value={apiBaseUrl}
                  onChange={(e) => setApiBaseUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8081"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="api-token" className="text-xs text-muted-foreground">
                  Bearer token (stored in this tab only)
                </Label>
                <Input
                  id="api-token"
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder="COLOR_API_KEY"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={loadApiProfiles}
                disabled={apiBusy || !apiToken.trim()}
              >
                Load profiles
              </Button>
              <Select
                value={apiProfileId || undefined}
                onValueChange={loadApiProfile}
                disabled={apiBusy || apiProfiles.length === 0}
              >
                <SelectTrigger className="w-full sm:w-[260px]">
                  <SelectValue placeholder="API profile" />
                </SelectTrigger>
                <SelectContent>
                  {apiProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name} ({profile.revisionCount} rev)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={apiRevisionNumber === null ? undefined : String(apiRevisionNumber)}
                onValueChange={(v) => setApiRevisionNumber(Number(v))}
                disabled={apiBusy || !apiProfile}
              >
                <SelectTrigger className="w-full sm:w-[220px]">
                  <SelectValue placeholder="API revision" />
                </SelectTrigger>
                <SelectContent>
                  {(apiProfile?.revisions ?? [])
                    .slice()
                    .sort((a, b) => b.revision - a.revision)
                    .map((revision) => (
                      <SelectItem key={revision.revision} value={String(revision.revision)}>
                        rev {revision.revision} • {revision.fingerprint.slice(0, 8)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                onClick={useApiRevision}
                disabled={apiBusy || !apiRevisionNumber || !apiProfileId}
              >
                Use revision
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Only calibration metadata is fetched. Product images are still corrected in this
              browser and never uploaded by this page.
            </p>
          </CardContent>
        </Card>

        {!hasAnyPreset && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Settings2 className="w-12 h-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No presets available</h3>
              <p className="text-muted-foreground mb-4">
                Create a calibration preset first, or load a saved profile from the API.
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

        {hasAnyPreset && <BatchProcessor selection={selection} />}
      </main>
    </div>
  );
}

import type {
  CalibrationPreset,
  CalibrationProvenance,
  CalibrationRevision,
  ColorMatrix,
  ColorPoint,
} from '@/types/colorCorrector';
import { presetFromRemoteRevision } from './presetStorage';

export interface ApiRevisionSummary {
  revision: number;
  createdAt: number;
  mode: 'simple' | 'advanced';
  algorithmVersion: string;
  fingerprint: string;
  contentHash: string;
  meanResidual: number;
}

export interface ApiProfileSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  latestRevision: number | null;
  revisionCount: number;
}

export interface ApiProfileDetail extends ApiProfileSummary {
  revisions: ApiRevisionSummary[];
}

export interface ApiRevision {
  profileId: string;
  revision: number;
  createdAt: number;
  points: ColorPoint[];
  matrix: ColorMatrix;
  mode: 'simple' | 'advanced';
  algorithmVersion: string;
  fingerprint: string;
  contentHash: string;
  meanResidual: number;
  provenance: CalibrationProvenance;
}

export class CalibrationApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CalibrationApiError';
    this.status = status;
    this.code = code;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CalibrationApiError(0, 'INVALID_BASE_URL', 'API base URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CalibrationApiError(0, 'INVALID_BASE_URL', 'API base URL must use http or https');
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const allowRemote =
    typeof import.meta !== 'undefined' &&
    (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_ALLOW_REMOTE_API ===
      'true';
  if (!loopbackHosts.has(url.hostname) && !allowRemote) {
    throw new CalibrationApiError(
      0,
      'INVALID_BASE_URL',
      'For safety the calibration token is only sent to a loopback API host. Set VITE_ALLOW_REMOTE_API=true only if you understand the risk.'
    );
  }
  return trimmed;
}

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!token.trim()) {
    throw new CalibrationApiError(0, 'MISSING_TOKEN', 'An API token is required');
  }
  const endpoint = `${normalizeBaseUrl(baseUrl)}${path}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new CalibrationApiError(0, 'NETWORK_ERROR', 'Could not reach the calibration API');
  }

  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    let message = `Calibration API returned ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep generic message
    }
    throw new CalibrationApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

export async function listCalibrationProfiles(
  baseUrl: string,
  token: string,
  limit = 100
): Promise<ApiProfileSummary[]> {
  const data = await request<{ profiles: ApiProfileSummary[] }>(
    baseUrl,
    token,
    `/v1/calibrations?limit=${Math.max(1, Math.min(200, limit))}`
  );
  return data.profiles;
}

export async function getCalibrationProfile(
  baseUrl: string,
  token: string,
  profileId: string
): Promise<ApiProfileDetail> {
  const data = await request<{ profile: ApiProfileDetail }>(
    baseUrl,
    token,
    `/v1/calibrations/${encodeURIComponent(profileId)}`
  );
  return data.profile;
}

export async function getCalibrationRevision(
  baseUrl: string,
  token: string,
  profileId: string,
  revision: number
): Promise<ApiRevision> {
  const data = await request<{ revision: ApiRevision }>(
    baseUrl,
    token,
    `/v1/calibrations/${encodeURIComponent(profileId)}/revisions/${revision}`
  );
  return data.revision;
}

export async function createCalibrationProfile(
  baseUrl: string,
  token: string,
  input: {
    name: string;
    points: ColorPoint[];
    mode: 'simple' | 'advanced';
    matrix: ColorMatrix;
    algorithmVersion: string;
    notes?: string[];
  }
): Promise<{ profile: ApiProfileSummary; revision: ApiRevision }> {
  return request<{ profile: ApiProfileSummary; revision: ApiRevision }>(
    baseUrl,
    token,
    '/v1/calibrations',
    { method: 'POST', body: JSON.stringify(input) }
  );
}

export async function appendCalibrationRevision(
  baseUrl: string,
  token: string,
  profileId: string,
  input: {
    points: ColorPoint[];
    mode: 'simple' | 'advanced';
    matrix: ColorMatrix;
    algorithmVersion: string;
    notes?: string[];
  }
): Promise<ApiRevision> {
  const data = await request<{ revision: ApiRevision }>(
    baseUrl,
    token,
    `/v1/calibrations/${encodeURIComponent(profileId)}/revisions`,
    { method: 'POST', body: JSON.stringify(input) }
  );
  return data.revision;
}

/** Convert an API revision into the local preset shape used by the workflow. */
export function presetFromApiRevision(
  profile: Pick<ApiProfileSummary, 'id' | 'name' | 'updatedAt'>,
  revision: ApiRevision
): CalibrationPreset {
  const localRevision: CalibrationRevision = {
    revision: revision.revision,
    createdAt: revision.createdAt,
    points: revision.points,
    matrix: revision.matrix,
    mode: revision.mode,
    algorithmVersion: revision.algorithmVersion,
    fingerprint: revision.fingerprint,
    contentHash: revision.contentHash,
    provenance: {
      ...revision.provenance,
      source: 'api',
      profileId: profile.id,
      revision: revision.revision,
      contentHash: revision.contentHash,
      createdAt: revision.createdAt,
    },
  };
  return presetFromRemoteRevision({
    profileId: profile.id,
    profileName: profile.name,
    updatedAt: profile.updatedAt,
    revision: localRevision,
  });
}

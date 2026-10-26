import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationApiError,
  listCalibrationProfiles,
} from '@/lib/calibrationApi';

describe('calibration API client safety', () => {
  it('refuses to send the bearer token to a non-loopback host by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      listCalibrationProfiles('https://example.invalid', 'secret-token')
    ).rejects.toBeInstanceOf(CalibrationApiError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects non-http schemes', async () => {
    await expect(listCalibrationProfiles('file:///tmp/api', 'secret-token')).rejects.toMatchObject({
      code: 'INVALID_BASE_URL',
    });
  });

  it('requires a token before making a request', async () => {
    await expect(listCalibrationProfiles('http://127.0.0.1:8081', '')).rejects.toMatchObject({
      code: 'MISSING_TOKEN',
    });
  });
});

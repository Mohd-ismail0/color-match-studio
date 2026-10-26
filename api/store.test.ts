// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { CalibrationStore } from './store';
import { describeStoreContract } from './testing/storeContract';

const dir = mkdtempSync(path.join(tmpdir(), 'color-store-contract-'));
const dbPath = path.join(dir, 'calibration.sqlite');

describeStoreContract('sqlite (development)', async () => new CalibrationStore(dbPath));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

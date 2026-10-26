// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRevisionDraft } from '../calibrationService';
import {
  StoreError,
  type CalibrationStoreAdapter,
  type RevisionDraft,
} from '../storeContract';
import type { ColorPoint } from '../../src/types/colorCorrector';

export const contractPoints: ColorPoint[] = [
  {
    id: 'p1',
    label: 'White',
    role: 'white',
    x: 0.1,
    y: 0.1,
    sampledColor: { r: 220, g: 210, b: 200 },
    targetColor: { r: 255, g: 255, b: 255 },
  },
  {
    id: 'p2',
    label: 'Grey',
    role: 'grey',
    x: 0.5,
    y: 0.5,
    sampledColor: { r: 120, g: 115, b: 110 },
    targetColor: { r: 128, g: 128, b: 128 },
  },
  {
    id: 'p3',
    label: 'Black',
    role: 'black',
    x: 0.9,
    y: 0.9,
    sampledColor: { r: 15, g: 12, b: 10 },
    targetColor: { r: 0, g: 0, b: 0 },
  },
];

export function contractDraft(points: ColorPoint[] = contractPoints): RevisionDraft {
  return buildRevisionDraft({ points, mode: 'simple' });
}

export function variedDraft(target = 141): RevisionDraft {
  const points = contractPoints.map((point) =>
    point.role === 'grey' ? { ...point, targetColor: { r: target, g: target, b: target } } : point
  );
  return buildRevisionDraft({ points, mode: 'simple' });
}

/**
 * The same behavioural contract is executed against the SQLite dev adapter and
 * (when an endpoint is supplied) the PostgreSQL adapter.
 */
export function describeStoreContract(
  label: string,
  open: () => Promise<CalibrationStoreAdapter>
): void {
  describe(`${label}: calibration store contract`, () => {
    it('stores revision 1 with explicit profile, revision and provenance', async () => {
      const store = await open();
      try {
        const draft = contractDraft();
        const created = await store.createProfile('Contract studio', draft);

        expect(created.profile.id).toMatch(/^cal_[a-z0-9_]+$/);
        expect(created.profile.revisionCount).toBe(1);
        expect(created.profile.latestRevision).toBe(1);
        expect(Number.isInteger(created.profile.createdAt)).toBe(true);
        expect(created.revision.profileId).toBe(created.profile.id);
        expect(created.revision.revision).toBe(1);
        expect(created.revision.provenance.profileId).toBe(created.profile.id);
        expect(created.revision.provenance.revision).toBe(1);
        expect(created.revision.provenance.contentHash).toBe(created.revision.contentHash);
        expect(created.revision.meanResidual).toBe(draft.meanResidual);

        const detail = await store.getProfile(created.profile.id);
        expect(detail?.revisions.map((entry) => entry.revision)).toEqual([1]);

        const fetched = await store.getRevision(created.profile.id, 1);
        expect(fetched?.contentHash).toBe(draft.contentHash);
        expect(fetched?.fingerprint).toBe(draft.fingerprint);
        expect(fetched?.matrix).toEqual(draft.matrix);
        expect(fetched?.points).toEqual(draft.points);
        expect(fetched?.algorithmVersion).toBe(draft.algorithmVersion);

        const listed = await store.listProfiles(50);
        expect(listed.some((profile) => profile.id === created.profile.id)).toBe(true);
        expect(await store.countProfiles()).toBeGreaterThanOrEqual(1);
      } finally {
        await store.close();
      }
    });

    it('appends immutable revisions without mutating earlier ones', async () => {
      const store = await open();
      try {
        const created = await store.createProfile('Append studio', contractDraft());
        const first = await store.getRevision(created.profile.id, 1);

        const second = await store.appendRevision(created.profile.id, variedDraft(141));
        expect(second.revision).toBe(2);

        const firstAfter = await store.getRevision(created.profile.id, 1);
        expect(firstAfter?.contentHash).toBe(first?.contentHash);
        expect(firstAfter?.matrix).toEqual(first?.matrix);
        expect(second.contentHash).not.toBe(first?.contentHash);

        const detail = await store.getProfile(created.profile.id);
        expect(detail?.latestRevision).toBe(2);
        expect(detail?.revisionCount).toBe(2);
        expect(detail?.revisions.map((entry) => entry.revision)).toEqual([1, 2]);
      } finally {
        await store.close();
      }
    });

    it('serialises concurrent appends into distinct revision numbers', async () => {
      const store = await open();
      try {
        const created = await store.createProfile('Concurrent studio', contractDraft());
        const appends = await Promise.all(
          [0, 1, 2, 3].map((index) =>
            store.appendRevision(created.profile.id, variedDraft(140 + index))
          )
        );
        expect(appends.map((revision) => revision.revision).sort((a, b) => a - b)).toEqual([
          2, 3, 4, 5,
        ]);
        const detail = await store.getProfile(created.profile.id);
        expect(detail?.revisionCount).toBe(5);
        expect(detail?.revisions.map((entry) => entry.revision)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        await store.close();
      }
    });

    it('returns null for absent profiles and revisions and refuses unknown appends', async () => {
      const store = await open();
      try {
        expect(await store.getProfile('cal_missing_000000')).toBeNull();
        expect(await store.getRevision('cal_missing_000000', 1)).toBeNull();
        await expect(
          store.appendRevision('cal_missing_000000', contractDraft())
        ).rejects.toBeInstanceOf(StoreError);
        await expect(
          store.appendRevision('cal_missing_000000', contractDraft())
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        await store.close();
      }
    });

    it('replays idempotent creates and appends instead of duplicating', async () => {
      const store = await open();
      try {
        const createKey = `create:${randomUUID()}`;
        const first = await store.createProfile('Idempotent studio', contractDraft(), {
          idempotencyKey: createKey,
        });
        const replay = await store.createProfile('Idempotent studio', contractDraft(), {
          idempotencyKey: createKey,
        });
        expect(replay.profile.id).toBe(first.profile.id);
        expect(replay.revision.revision).toBe(1);

        const appendKey = `append:${randomUUID()}`;
        const append = await store.appendRevision(first.profile.id, variedDraft(142), {
          idempotencyKey: appendKey,
        });
        const appendReplay = await store.appendRevision(first.profile.id, variedDraft(142), {
          idempotencyKey: appendKey,
        });
        expect(append.revision).toBe(2);
        expect(appendReplay.revision).toBe(2);

        const detail = await store.getProfile(first.profile.id);
        expect(detail?.revisionCount).toBe(2);
      } finally {
        await store.close();
      }
    });

    it('retains revisions unchanged across a reopen', async () => {
      const store = await open();
      let profileId: string;
      let expectedHash: string;
      try {
        const created = await store.createProfile('Durable studio', contractDraft());
        profileId = created.profile.id;
        expectedHash = created.revision.contentHash;
      } finally {
        await store.close();
      }

      const reopened = await open();
      try {
        const revision = await reopened.getRevision(profileId, 1);
        expect(revision?.profileId).toBe(profileId);
        expect(revision?.revision).toBe(1);
        expect(revision?.contentHash).toBe(expectedHash);
        const detail = await reopened.getProfile(profileId);
        expect(detail?.revisions).toHaveLength(1);
      } finally {
        await reopened.close();
      }
    });
  });
}

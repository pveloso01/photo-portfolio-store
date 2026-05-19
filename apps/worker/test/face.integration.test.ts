// F1.22 face worker — real DB integration test for the "no photo row" path.
//
// Re-enables 1 test skipped under #107:
//   - skips when the photo row does not exist
//
// The stub-DB skip happened because the chain returning `[]` vs `[row]`
// couldn't be disambiguated from the test harness. With real Postgres, the
// SELECT for a non-existent photo row returns [] naturally and the worker's
// early-return path runs end-to-end.

import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbClient } from '@pkg/db';
import { sql } from 'drizzle-orm';

import type { FaceJobData } from '../src/queues/face.js';
import { processFaceJob } from '../src/workers/face.js';

const buildJob = (photoId: string): Job<FaceJobData> =>
  ({
    data: { photoId },
    opts: { attempts: 3 },
    attemptsMade: 0,
  }) as unknown as Job<FaceJobData>;

const buildS3 = () => ({
  send: vi.fn().mockResolvedValue({
    Body: { transformToByteArray: async () => new Uint8Array() },
  }),
});

describe('processFaceJob — real Postgres', () => {
  let db: ReturnType<typeof createDbClient>;

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('integration globalSetup did not set DATABASE_URL');
    db = createDbClient(url);
  });

  afterAll(async () => {
    // pool teardown handled by process exit
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE app.face_vectors, app.photos, app.events, app.organizations, app.users RESTART IDENTITY CASCADE`,
    );
  });

  it('skips when the photo row does not exist', async () => {
    const missingPhotoId = '99999999-9999-4999-8999-999999999999';
    const s3 = buildS3();
    const detectAndEmbed = vi.fn();
    const ensureCollection = vi.fn();
    const upsertFaceVectors = vi.fn();

    const result = await processFaceJob(buildJob(missingPhotoId), {
      db,
      s3: s3 as never,
      detectAndEmbed,
      ensureCollection,
      upsertFaceVectors,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(detectAndEmbed).not.toHaveBeenCalled();
    expect(ensureCollection).not.toHaveBeenCalled();
    expect(upsertFaceVectors).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });
});

// F3.12 — quality worker (processQuality) with mocked sharp / S3 / DB.

import { Buffer } from 'node:buffer';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computePhashFromGray } from '../src/lib/quality.js';
import type { QualityJobData } from '../src/queues/quality.js';

const marker = (key: string): Record<string, unknown> => ({ __table: key });

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    photos: {
      photos: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        originalObjectKey: { column: 'originalObjectKey' },
        phash: { column: 'phash' },
        qualityFlags: { column: 'qualityFlags' },
      },
    },
    compliance: { auditLog: marker('auditLog') },
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...preds: unknown[]) => ({ and: preds }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: [...strings], vals }),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Deterministic 32x32 grayscale the sharp stub returns on the hash pass.
const HASH_BYTES = Buffer.alloc(32 * 32);
for (let i = 0; i < HASH_BYTES.length; i += 1) HASH_BYTES[i] = (i * 7) % 256;
const EXPECTED_PHASH = computePhashFromGray(HASH_BYTES, 32);

const makeSharpStub = () => {
  const pipeline: Record<string, unknown> = {};
  for (const fn of ['greyscale', 'resize', 'raw', 'rotate']) {
    pipeline[fn] = vi.fn(() => pipeline);
  }
  pipeline.toBuffer = vi.fn((opts?: { resolveWithObject?: boolean }) => {
    if (opts?.resolveWithObject) {
      // Blur pass — uniform 8x8 luma => Laplacian variance 0 (blurry).
      return Promise.resolve({
        data: Buffer.alloc(8 * 8, 120),
        info: { width: 8, height: 8, channels: 1 },
      });
    }
    // Hash pass — deterministic 32x32 buffer.
    return Promise.resolve(HASH_BYTES);
  });
  return vi.fn(() => pipeline) as unknown as typeof import('sharp').default;
};

const makeS3 = () => ({
  send: vi.fn().mockResolvedValue({ Body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
});

interface UpdateCall {
  set: Record<string, unknown>;
}

const makeDb = (photoRow: Record<string, unknown>, candidates: Record<string, unknown>[]) => {
  let selectCall = 0;
  const updates: UpdateCall[] = [];
  const inserts: Record<string, unknown>[] = [];

  const select = vi.fn(() => {
    const idx = selectCall;
    selectCall += 1;
    const result = idx === 0 ? [photoRow] : candidates;
    const builder: Record<string, unknown> = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    return builder;
  });

  const update = vi.fn(() => ({
    set: (set: Record<string, unknown>) => ({
      where: () => {
        updates.push({ set });
        return Promise.resolve();
      },
    }),
  }));

  const insert = vi.fn(() => ({
    values: (vals: Record<string, unknown>) => {
      inserts.push(vals);
      return Promise.resolve();
    },
  }));

  return { db: { select, update, insert } as never, updates, inserts };
};

const buildJob = (photoId: string): Job<QualityJobData> =>
  ({ data: { photoId }, opts: { attempts: 3 }, attemptsMade: 0 }) as unknown as Job<QualityJobData>;

const noEyesClosed = vi.fn(async () => ({
  faces: 1,
  eyes_closed_faces: 0,
  ear_threshold: 0.21,
  faces_detail: [],
  model_version: 'stub',
}));

const baseDeps = {
  s3: makeS3() as never,
  buckets: { originals: 'originals' },
  sharpFactory: makeSharpStub(),
  thresholds: { blurThreshold: 50, hammingMax: 6 },
  eyesClosedScorer: noEyesClosed,
};

let processQuality: typeof import('../src/workers/quality.js').processQuality;

beforeEach(async () => {
  ({ processQuality } = await import('../src/workers/quality.js'));
});

describe('processQuality', () => {
  it('skips when the photo does not exist', async () => {
    const { db } = makeDb(undefined as never, []);
    const result = await processQuality(buildJob('missing'), {
      ...baseDeps,
      sharpFactory: makeSharpStub(),
      s3: makeS3() as never,
      db,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not_found');
  });

  it('flags blur and writes scores when no near-duplicate exists', async () => {
    const photo = { id: 'p1', eventId: 'e1', originalObjectKey: 'originals/e1/p1.jpg' };
    const { db, updates, inserts } = makeDb(photo, []);
    const result = await processQuality(buildJob('p1'), {
      ...baseDeps,
      sharpFactory: makeSharpStub(),
      s3: makeS3() as never,
      db,
    });

    expect(result.status).toBe('scored');
    expect(result.flags?.blur).toBe(true); // variance 0 < threshold 50
    expect(result.flags?.near_duplicate_of).toBeUndefined();
    expect(result.phash).toBe(EXPECTED_PHASH.toString());
    // Only the photo itself is updated.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.set.phash).toBe(EXPECTED_PHASH);
    expect(updates[0]?.set.blurScore).toBe('0.00');
    // Audit row emitted.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.action).toBe('media.quality.scored');
  });

  it('marks both photos as near-duplicates under a shared duplicate_group_id', async () => {
    const photo = { id: 'p2', eventId: 'e1', originalObjectKey: 'originals/e1/p2.jpg' };
    // Candidate with an identical phash (Hamming distance 0) and no prior group.
    const candidates = [{ id: 'p1', phash: EXPECTED_PHASH, qualityFlags: null }];
    const { db, updates } = makeDb(photo, candidates);

    const result = await processQuality(buildJob('p2'), {
      ...baseDeps,
      sharpFactory: makeSharpStub(),
      s3: makeS3() as never,
      db,
    });

    expect(result.status).toBe('scored');
    expect(result.flags?.near_duplicate_of).toBe('p1');
    expect(result.flags?.duplicate_group_id).toBeTruthy();

    // Two updates: the matched photo (p1) first, then the subject (p2).
    expect(updates).toHaveLength(2);
    const matchFlags = updates[0]?.set.qualityFlags as Record<string, unknown>;
    const selfFlags = updates[1]?.set.qualityFlags as Record<string, unknown>;
    expect(matchFlags.near_duplicate_of).toBe('p2');
    expect(selfFlags.near_duplicate_of).toBe('p1');
    // Same group id stamped on both rows.
    expect(matchFlags.duplicate_group_id).toBe(selfFlags.duplicate_group_id);
  });

  it('sets eyes_closed with the affected face count from the inference scorer', async () => {
    const photo = { id: 'p4', eventId: 'e1', originalObjectKey: 'originals/e1/p4.jpg' };
    const { db, updates } = makeDb(photo, []);
    const eyesClosedScorer = vi.fn(async () => ({
      faces: 3,
      eyes_closed_faces: 2,
      ear_threshold: 0.21,
      faces_detail: [],
      model_version: 'stub',
    }));
    const result = await processQuality(buildJob('p4'), {
      ...baseDeps,
      sharpFactory: makeSharpStub(),
      s3: makeS3() as never,
      db,
      eyesClosedScorer,
    });
    expect(result.flags?.eyes_closed).toEqual({ faces: 2 });
    const selfFlags = updates[0]?.set.qualityFlags as Record<string, unknown>;
    expect(selfFlags.eyes_closed).toEqual({ faces: 2 });
  });

  it('continues without eyes_closed when the inference scorer throws', async () => {
    const photo = { id: 'p5', eventId: 'e1', originalObjectKey: 'originals/e1/p5.jpg' };
    const { db } = makeDb(photo, []);
    const eyesClosedScorer = vi.fn(async () => {
      throw new Error('inference down');
    });
    const result = await processQuality(buildJob('p5'), {
      ...baseDeps,
      sharpFactory: makeSharpStub(),
      s3: makeS3() as never,
      db,
      eyesClosedScorer,
    });
    expect(result.status).toBe('scored');
    expect(result.flags?.eyes_closed).toBeUndefined();
  });

  it('reuses an existing duplicate_group_id from the matched photo', async () => {
    const photo = { id: 'p3', eventId: 'e1', originalObjectKey: 'originals/e1/p3.jpg' };
    const candidates = [
      {
        id: 'p1',
        phash: EXPECTED_PHASH,
        qualityFlags: { blur: false, duplicate_group_id: 'group-existing' },
      },
    ];
    const { db, updates } = makeDb(photo, candidates);

    const result = await processQuality(buildJob('p3'), {
      ...baseDeps,
      sharpFactory: makeSharpStub(),
      s3: makeS3() as never,
      db,
    });

    expect(result.flags?.duplicate_group_id).toBe('group-existing');
    const selfFlags = updates[1]?.set.qualityFlags as Record<string, unknown>;
    expect(selfFlags.duplicate_group_id).toBe('group-existing');
  });
});

import { Buffer } from 'node:buffer';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { DerivativesJobData } from '../src/queues/index.js';
import { processDerivatives } from '../src/workers/derivatives.js';

interface ChainState {
  results: unknown[][];
  step: number;
}

const buildDb = () => {
  // Sequence of select results: [photo row], [event settings row].
  const selectResponses: unknown[][] = [
    [{ id: 'p1', eventId: 'e1', originalObjectKey: 'originals/e1/p1.jpg', status: 'processing' }],
    [{ previewMaxPixels: 1600 }],
  ];
  const selectCalls: number[] = [];
  const select = vi.fn(() => {
    const idx = selectCalls.length;
    selectCalls.push(idx);
    const result = selectResponses[idx] ?? [];
    const limit = vi.fn().mockResolvedValue(result);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  // Audit also uses insert(); reuse insert chain (values() resolves directly).
  // Switch insertValues to be polymorphic: if `.onConflictDoUpdate` is called
  // on the returned object, we already covered it; the audit caller awaits the
  // returned object directly. Wrap insertValues so its return is thenable.
  const thenable = {
    onConflictDoUpdate,
    then: (resolve: (v: unknown) => void) => resolve(undefined),
  };
  insertValues.mockReturnValue(thenable);

  return { select, insert, update, updateSet, onConflictDoUpdate, insertValues } as const;
};

const buildS3 = () => {
  const send = vi.fn().mockImplementation(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      return { Body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
    }
    return {};
  });
  return { send } as const;
};

const makeSharpStub = () => {
  // Build a chainable mock that returns itself for transform calls and
  // resolves toBuffer with a deterministic shape.
  const pipeline: Record<string, unknown> = {};
  const fns = ['rotate', 'resize', 'jpeg', 'withMetadata', 'composite'];
  for (const fn of fns) pipeline[fn] = vi.fn().mockReturnValue(pipeline);
  pipeline.metadata = vi.fn().mockResolvedValue({ width: 4000, height: 3000 });
  pipeline.toBuffer = vi.fn().mockResolvedValue({
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    info: { size: 1234, width: 1000, height: 750 },
  });
  return vi.fn(() => pipeline) as unknown as typeof import('sharp').default;
};

const buildJob = (): Job<DerivativesJobData> =>
  ({
    data: { photoId: 'p1' },
    opts: { attempts: 3 },
    attemptsMade: 0,
  }) as unknown as Job<DerivativesJobData>;

describe('processDerivatives', () => {
  it('produces all four derivatives and marks photo ready', async () => {
    const db = buildDb();
    const s3 = buildS3();
    const sharpFactory = makeSharpStub();
    const qualityQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const result = await processDerivatives(buildJob(), {
      db: db as never,
      s3: s3 as never,
      buckets: { originals: 'orig', derivatives: 'deriv' },
      sharpFactory,
      qualityQueue: qualityQueue as never,
    });

    expect(result.status).toBe('ready');
    expect(result.derivatives).toEqual(['thumb', 'preview', 'web', 'full']);
    // F3.12 — quality scoring enqueued after derivatives complete.
    expect(qualityQueue.add).toHaveBeenCalledTimes(1);

    // 1 GET + 4 PUTs = 5 S3 sends.
    expect(s3.send).toHaveBeenCalledTimes(5);

    // 4 upserts into photo_derivatives + 1 audit insert = 5 inserts.
    expect(db.insert).toHaveBeenCalledTimes(5);
    expect(db.onConflictDoUpdate).toHaveBeenCalledTimes(4);

    // photo updated to ready exactly once.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', width: 4000, height: 3000 }),
    );
  });
});

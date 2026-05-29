// F3.13 — photo-quality service tests (mapping, cursor, ownership, siblings).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    photos: {
      photos: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        status: { column: 'status' },
        hidden: { column: 'hidden' },
        blurScore: { column: 'blurScore' },
        phash: { column: 'phash' },
        qualityFlags: { column: 'qualityFlags' },
        photographerUserId: { column: 'photographerUserId' },
        createdAt: { column: 'createdAt' },
      },
    },
  },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }) },
}));

vi.mock('drizzle-orm', () => ({
  and: (...preds: unknown[]) => ({ and: preds }),
  desc: (c: unknown) => ({ desc: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: [...strings], vals }),
}));

// Fake db whose select() returns canned result sets in sequence.
const makeDb = (resultSets: unknown[][]) => {
  let call = 0;
  const select = vi.fn(() => {
    const idx = call;
    call += 1;
    const result = resultSets[idx] ?? [];
    const builder: Record<string, unknown> = {
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    return builder;
  });
  return { select } as never;
};

let svc: typeof import('../src/services/photo-quality.js');

beforeEach(async () => {
  svc = await import('../src/services/photo-quality.js');
});

const photoRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  eventId: 'e1',
  status: 'ready',
  hidden: false,
  blurScore: '42.50',
  qualityFlags: { blur: true },
  createdAt: new Date('2026-05-01T00:00:00Z'),
  ...over,
});

describe('listPhotographerPhotos', () => {
  it('maps rows and returns no cursor when under the limit', async () => {
    const db = makeDb([[photoRow(), photoRow({ id: 'p2', qualityFlags: null, blurScore: null })]]);
    const result = await svc.listPhotographerPhotos(db, 'u1', { limit: 50 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.blurScore).toBe(42.5);
    expect(result.items[0]?.qualityFlags).toEqual({ blur: true });
    expect(result.items[1]?.blurScore).toBeNull();
    expect(result.nextCursor).toBeNull();
  });

  it('returns a nextCursor when there are more rows than the limit', async () => {
    const rows = [
      photoRow({ id: 'a', createdAt: new Date('2026-05-03T00:00:00Z') }),
      photoRow({ id: 'b', createdAt: new Date('2026-05-02T00:00:00Z') }),
      photoRow({ id: 'c', createdAt: new Date('2026-05-01T00:00:00Z') }),
    ];
    // limit 2 -> service fetches 3, sees hasMore, slices to 2.
    const db = makeDb([rows]);
    const result = await svc.listPhotographerPhotos(db, 'u1', { limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeTruthy();
  });

  it('exposes duplicate_group_id for near-duplicate rows', async () => {
    const db = makeDb([
      [
        photoRow({
          qualityFlags: {
            blur: false,
            near_duplicate_of: 'p9',
            duplicate_group_id: 'grp-1',
          },
        }),
      ],
    ]);
    const result = await svc.listPhotographerPhotos(db, 'u1', { qualityFlag: 'near_duplicate' });
    expect(result.items[0]?.duplicateGroupId).toBe('grp-1');
  });
});

describe('getPhotoQuality', () => {
  it('returns null when the photo belongs to another photographer', async () => {
    const db = makeDb([[photoRow({ photographerUserId: 'someone-else' })]]);
    const detail = await svc.getPhotoQuality(db, 'p1', 'u1');
    expect(detail).toBeNull();
  });

  it('returns null when the photo does not exist', async () => {
    const db = makeDb([[]]);
    const detail = await svc.getPhotoQuality(db, 'missing', 'u1');
    expect(detail).toBeNull();
  });

  it('builds explanations per active flag and resolves duplicate siblings', async () => {
    const db = makeDb([
      [
        {
          id: 'p1',
          eventId: 'e1',
          photographerUserId: 'u1',
          blurScore: '10.00',
          phash: 123n,
          qualityFlags: {
            blur: true,
            eyes_closed: { faces: 2 },
            near_duplicate_of: 'p2',
            duplicate_group_id: 'grp-1',
          },
        },
      ],
      [{ id: 'p2' }, { id: 'p3' }],
    ]);
    const detail = await svc.getPhotoQuality(db, 'p1', 'u1');
    expect(detail).not.toBeNull();
    expect(detail?.blurScore).toBe(10);
    expect(detail?.phash).toBe('123');
    expect(detail?.explanation).toHaveLength(3);
    expect(detail?.duplicateGroupId).toBe('grp-1');
    expect(detail?.duplicateSiblings).toEqual(['p2', 'p3']);
  });

  it('returns no explanation and no siblings for an unflagged photo', async () => {
    const db = makeDb([
      [
        {
          id: 'p1',
          eventId: 'e1',
          photographerUserId: 'u1',
          blurScore: null,
          phash: null,
          qualityFlags: null,
        },
      ],
    ]);
    const detail = await svc.getPhotoQuality(db, 'p1', 'u1');
    expect(detail?.explanation).toEqual([]);
    expect(detail?.duplicateSiblings).toEqual([]);
    expect(detail?.phash).toBeNull();
  });
});

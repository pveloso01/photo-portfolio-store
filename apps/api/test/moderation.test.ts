// F3.2 — moderation service unit tests. Fake DB; storage + qdrant injected as
// spies via deps; audit mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  photos: Row[];
  photoReports: Row[];
  photoDerivatives: Row[];
  faceVectors: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    photos: {
      tables: {
        photos: tableMarker('photos'),
        photoReports: tableMarker('photoReports'),
        photoDerivatives: tableMarker('photoDerivatives'),
      },
    },
    search: { tables: { faceVectors: tableMarker('faceVectors') } },
  },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

vi.mock('../src/lib/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

// Avoid loading real storage/qdrant (env-gated singletons). deps inject spies.
vi.mock('../src/lib/storage.js', () => ({
  s3: { send: vi.fn(async () => ({})) },
  buckets: { originals: 'originals', derivatives: 'derivatives' },
}));
vi.mock('../src/lib/qdrant-client.js', () => ({
  qdrant: { delete: vi.fn(async () => ({})) },
  collectionName: (eventId: string) => `faces_event_${eventId}`,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const ne = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) !== valueOf(b, row);
  const gt = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number | Date) > (valueOf(b, row) as number | Date);
  const and =
    (...preds: Array<((r: Row) => boolean) | undefined>) =>
    (row: Row) =>
      preds.every((p) => (p ? p(row) : true));
  const or =
    (...preds: Array<((r: Row) => boolean) | undefined>) =>
    (row: Row) =>
      preds.some((p) => (p ? p(row) : false));
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  const desc = (field: Field) => ({ __desc: field.column });
  return { eq, ne, gt, and, or, inArray, desc, sql: () => ({}) };
});

let store: Store;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    let order: { __desc: string } | undefined;
    const project = (rows: Row[]): Row[] =>
      selection
        ? rows.map((r) => {
            const p: Row = {};
            for (const [alias, ref] of Object.entries(selection)) p[alias] = r[ref.column];
            return p;
          })
        : rows.map((r) => ({ ...r }));
    const exec = (): Row[] => {
      if (!bucket) return [];
      let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
      if (order) {
        const col = order.__desc;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as number;
          const bv = b[col] as number;
          return av > bv ? -1 : av < bv ? 1 : 0;
        });
      }
      if (limitN !== undefined) rows = rows.slice(0, limitN);
      return project(rows);
    };
    const api = {
      from(t: Row) {
        bucket = t[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      orderBy(o: { __desc: string }) {
        order = o;
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(exec());
      },
    };
    return api;
  };

  const updateBuilder = (t: Row) => {
    const bucket = t[TABLE_KEY] as keyof Store;
    let patch: Row = {};
    return {
      set(values: Row) {
        patch = values;
        return this;
      },
      where(pred: (r: Row) => boolean) {
        for (const row of store[bucket]) if (pred(row)) Object.assign(row, patch);
        return Promise.resolve(undefined);
      },
    };
  };

  const deleteBuilder = (t: Row) => {
    const bucket = t[TABLE_KEY] as keyof Store;
    return {
      where(pred: (r: Row) => boolean) {
        store[bucket] = store[bucket].filter((r) => !pred(r));
        return Promise.resolve(undefined);
      },
    };
  };

  return {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    update: (t: Row) => updateBuilder(t),
    delete: (t: Row) => deleteBuilder(t),
  };
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.photos.tables.photos as Record<string, unknown>, [
    'id',
    'eventId',
    'photographerUserId',
    'flagCount',
    'lastFlaggedAt',
    'moderationStatus',
    'status',
    'hidden',
    'originalObjectKey',
    'createdAt',
  ]);
  tag(schema.photos.tables.photoReports as Record<string, unknown>, ['photoId', 'reason']);
  tag(schema.photos.tables.photoDerivatives as Record<string, unknown>, ['photoId', 'objectKey']);
  tag(schema.search.tables.faceVectors as Record<string, unknown>, ['photoId']);
};

let db: ReturnType<typeof makeFakeDb>;

const newStore = (): Store => ({
  photos: [],
  photoReports: [],
  photoDerivatives: [],
  faceVectors: [],
});

beforeEach(async () => {
  store = newStore();
  await installFieldShims();
  db = makeFakeDb();
});

const seedPhoto = (id: string, overrides: Partial<Row> = {}): void => {
  store.photos.push({
    id,
    eventId: 'ev1',
    photographerUserId: 'ph1',
    flagCount: 0,
    lastFlaggedAt: null,
    moderationStatus: 'visible',
    status: 'ready',
    hidden: false,
    originalObjectKey: `originals/ev1/${id}.jpg`,
    createdAt: new Date(`2026-05-0${(store.photos.length % 9) + 1}T00:00:00Z`),
    ...overrides,
  });
};

describe('getModerationQueue', () => {
  it('returns flagged photos ordered by severity, with reasons', async () => {
    const { getModerationQueue } = await import('../src/services/moderation.js');
    seedPhoto('p1', { flagCount: 1 });
    seedPhoto('p2', { flagCount: 5 });
    seedPhoto('p3', { flagCount: 0 }); // visible + unflagged -> excluded
    store.photoReports.push(
      { photoId: 'p2', reason: 'inappropriate' },
      { photoId: 'p2', reason: 'copyright' },
    );

    const { items } = await getModerationQueue(db as never, {});
    expect(items.map((i) => i.photoId)).toEqual(['p2', 'p1']);
    expect(items[0]?.reasons.sort()).toEqual(['copyright', 'inappropriate']);
  });

  it('includes non-visible photos even with zero flags', async () => {
    const { getModerationQueue } = await import('../src/services/moderation.js');
    seedPhoto('p1', { flagCount: 0, moderationStatus: 'hidden' });
    const { items } = await getModerationQueue(db as never, {});
    expect(items.map((i) => i.photoId)).toEqual(['p1']);
  });
});

describe('bulkModerate', () => {
  it('hide sets moderation_status+hidden and audits each photo', async () => {
    const { bulkModerate } = await import('../src/services/moderation.js');
    const { writeAudit } = await import('../src/lib/audit.js');
    seedPhoto('p1');
    seedPhoto('p2');
    const result = await bulkModerate(db as never, 'hide', ['p1', 'p2'], { adminUserId: 'a1' });
    expect(result.updated).toBe(2);
    expect((store.photos[0] as Row).moderationStatus).toBe('hidden');
    expect((store.photos[0] as Row).hidden).toBe(true);
    expect(writeAudit).toHaveBeenCalledTimes(2);
  });

  it('show reverses hide', async () => {
    const { bulkModerate } = await import('../src/services/moderation.js');
    seedPhoto('p1', { moderationStatus: 'hidden', hidden: true });
    await bulkModerate(db as never, 'show', ['p1'], { adminUserId: 'a1' });
    expect((store.photos[0] as Row).moderationStatus).toBe('visible');
    expect((store.photos[0] as Row).hidden).toBe(false);
  });

  it('delete purges R2 + Qdrant and flips the row', async () => {
    const { bulkModerate } = await import('../src/services/moderation.js');
    seedPhoto('p1');
    store.photoDerivatives.push({ photoId: 'p1', objectKey: 'derivatives/ev1/p1/thumb.jpg' });
    store.faceVectors.push({ photoId: 'p1' });
    const s3Send = vi.fn(async () => ({}));
    const qdrantDelete = vi.fn(async () => ({}));

    const result = await bulkModerate(
      db as never,
      'delete',
      ['p1'],
      { adminUserId: 'a1' },
      {
        s3: { send: s3Send } as never,
        qdrant: { delete: qdrantDelete },
      },
    );

    expect(result.updated).toBe(1);
    expect(s3Send).toHaveBeenCalledTimes(2); // original + 1 derivative
    expect(qdrantDelete).toHaveBeenCalledTimes(1);
    expect((store.photos[0] as Row).moderationStatus).toBe('deleted');
    expect((store.photos[0] as Row).status).toBe('takedown');
    expect(store.faceVectors).toHaveLength(0);
  });

  it('delete leaves the photo untouched and reports it failed when purge throws', async () => {
    const { bulkModerate } = await import('../src/services/moderation.js');
    seedPhoto('p1');
    const result = await bulkModerate(
      db as never,
      'delete',
      ['p1'],
      { adminUserId: 'a1' },
      {
        s3: {
          send: vi.fn(async () => {
            throw new Error('R2 down');
          }),
        } as never,
        qdrant: { delete: vi.fn(async () => ({})) },
      },
    );
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual(['p1']);
    expect((store.photos[0] as Row).moderationStatus).toBe('visible');
  });

  it('rejects more than BULK_MAX ids', async () => {
    const { bulkModerate, ModerationError, BULK_MAX } = await import(
      '../src/services/moderation.js'
    );
    const ids = Array.from({ length: BULK_MAX + 1 }, (_, i) => `p${i}`);
    await expect(
      bulkModerate(db as never, 'hide', ids, { adminUserId: 'a1' }),
    ).rejects.toBeInstanceOf(ModerationError);
  });
});

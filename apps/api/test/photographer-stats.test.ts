// F3.10 — photographer stats service unit tests. Fake DB.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  photos: Row[];
  photoViews: Row[];
  orders: Row[];
  orderItems: Row[];
  payoutAccounts: Row[];
  payouts: Row[];
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
    photos: { tables: { photos: tableMarker('photos'), photoViews: tableMarker('photoViews') } },
    commerce: { tables: { orders: tableMarker('orders'), orderItems: tableMarker('orderItems') } },
    payouts: {
      tables: { payoutAccounts: tableMarker('payoutAccounts'), payouts: tableMarker('payouts') },
    },
  },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const ne = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) !== valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  return { eq, ne, and, inArray };
});

let store: Store;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      from(t: Row) {
        bucket = t[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        if (!bucket) return resolve([]);
        const rows = store[bucket].filter((r) => filters.every((f) => f(r)));
        const projected = selection
          ? rows.map((r) => {
              const p: Row = {};
              for (const [alias, ref] of Object.entries(selection)) p[alias] = r[ref.column];
              return p;
            })
          : rows.map((r) => ({ ...r }));
        return resolve(projected);
      },
    };
    return api;
  };
  const insertBuilder = (t: Row) => {
    const bucket = t[TABLE_KEY] as keyof Store;
    return {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        for (const row of arr) store[bucket].push({ id: `gen-${store[bucket].length}`, ...row });
        return Promise.resolve(undefined);
      },
    };
  };
  return {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
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
    'moderationStatus',
  ]);
  tag(schema.photos.tables.photoViews as Record<string, unknown>, [
    'photoId',
    'source',
    'viewedAt',
  ]);
  tag(schema.commerce.tables.orders as Record<string, unknown>, ['id', 'status', 'placedAt']);
  tag(schema.commerce.tables.orderItems as Record<string, unknown>, [
    'photoId',
    'orderId',
    'lineTotalCents',
  ]);
  tag(schema.payouts.tables.payoutAccounts as Record<string, unknown>, ['id', 'photographerId']);
  tag(schema.payouts.tables.payouts as Record<string, unknown>, [
    'payoutAccountId',
    'netCents',
    'status',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

const newStore = (): Store => ({
  photos: [],
  photoViews: [],
  orders: [],
  orderItems: [],
  payoutAccounts: [],
  payouts: [],
});

beforeEach(async () => {
  store = newStore();
  await installFieldShims();
  db = makeFakeDb();
  const { clearPhotographerStatsCache } = await import('../src/services/photographer-stats.js');
  clearPhotographerStatsCache();
});

const addViews = (photoId: string, n: number, source = 'direct'): void => {
  for (let i = 0; i < n; i += 1) {
    store.photoViews.push({ photoId, source, viewedAt: new Date('2026-05-20T00:00:00Z') });
  }
};

describe('getPhotographerStats', () => {
  it('aggregates photos, sales, earnings, top/bottom, conversion, payouts', async () => {
    const { getPhotographerStats } = await import('../src/services/photographer-stats.js');
    store.photos.push(
      { id: 'p1', eventId: 'ev1', photographerUserId: 'A', moderationStatus: 'visible' },
      { id: 'p2', eventId: 'ev1', photographerUserId: 'A', moderationStatus: 'visible' },
      { id: 'pX', eventId: 'ev1', photographerUserId: 'A', moderationStatus: 'deleted' }, // excluded
    );
    addViews('p1', 20); // converts
    addViews('p2', 15); // viewed, no sale -> bottom
    store.orders.push({ id: 'o1', status: 'paid', placedAt: new Date('2026-05-20T00:00:00Z') });
    store.orderItems.push({ photoId: 'p1', orderId: 'o1', lineTotalCents: 4000 });
    store.payoutAccounts.push({ id: 'pa1', photographerId: 'A' });
    store.payouts.push(
      { payoutAccountId: 'pa1', netCents: 1000, status: 'paid' },
      { payoutAccountId: 'pa1', netCents: 500, status: 'sent' },
    );

    const stats = await getPhotographerStats(db as never, 'A', { range: 'all' });
    expect(stats.totalPhotos).toBe(2); // deleted excluded
    expect(stats.totalSales).toBe(1);
    expect(stats.grossEarningsCents).toBe(4000);
    expect(stats.paidPayoutsCents).toBe(1000);
    expect(stats.pendingPayoutCents).toBe(500);
    expect(stats.topPhotos[0]?.photoId).toBe('p1');
    expect(stats.bottomPhotos[0]?.photoId).toBe('p2');
    // conversion: eligible photos with >=10 views: p1 (20 views,1 sale), p2 (15 views,0). 1/35.
    expect(stats.conversionRate).toBeCloseTo(1 / 35, 5);
  });

  it('excludes photos with <10 views from conversion', async () => {
    const { getPhotographerStats } = await import('../src/services/photographer-stats.js');
    store.photos.push({
      id: 'p1',
      eventId: 'ev1',
      photographerUserId: 'A',
      moderationStatus: 'visible',
    });
    addViews('p1', 3);
    const stats = await getPhotographerStats(db as never, 'A', { range: 'all' });
    expect(stats.conversionRate).toBe(0);
  });
});

describe('recordPhotoView', () => {
  it('appends a view row', async () => {
    const { recordPhotoView } = await import('../src/services/photographer-stats.js');
    await recordPhotoView(db as never, { photoId: 'p1', viewerHash: 'h1', source: 'qr' });
    expect(store.photoViews).toHaveLength(1);
    expect(store.photoViews[0]).toMatchObject({ photoId: 'p1', viewerHash: 'h1', source: 'qr' });
  });
});

describe('hashViewer', () => {
  it('is deterministic and contains no raw input', async () => {
    const { hashViewer } = await import('../src/services/photographer-stats.js');
    const h1 = hashViewer('1.2.3.4', 'UA');
    const h2 = hashViewer('1.2.3.4', 'UA');
    expect(h1).toBe(h2);
    expect(h1).not.toContain('1.2.3.4');
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});

// F3.9 — event stats service unit tests. Fake DB.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  photos: Row[];
  faceVectors: Row[];
  orders: Row[];
  orderItems: Row[];
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
    photos: { tables: { photos: tableMarker('photos') } },
    search: { tables: { faceVectors: tableMarker('faceVectors') } },
    commerce: { tables: { orders: tableMarker('orders'), orderItems: tableMarker('orderItems') } },
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
  const gte = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number | Date) >= (valueOf(b, row) as number | Date);
  const lte = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number | Date) <= (valueOf(b, row) as number | Date);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  return { eq, gte, lte, and, inArray };
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
  return { select: (s?: Record<string, { column: string }>) => selectBuilder(s) };
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
  ]);
  tag(schema.search.tables.faceVectors as Record<string, unknown>, ['photoId', 'eventId']);
  tag(schema.commerce.tables.orders as Record<string, unknown>, [
    'id',
    'eventId',
    'totalCents',
    'refundedCents',
    'currency',
    'status',
    'placedAt',
  ]);
  tag(schema.commerce.tables.orderItems as Record<string, unknown>, [
    'orderId',
    'photoId',
    'lineTotalCents',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

const newStore = (): Store => ({ photos: [], faceVectors: [], orders: [], orderItems: [] });

beforeEach(async () => {
  store = newStore();
  await installFieldShims();
  db = makeFakeDb();
  const { clearEventStatsCache } = await import('../src/services/event-stats.js');
  clearEventStatsCache();
});

describe('getEventStats', () => {
  it('aggregates photos, faces, orders, revenue, refunds, top photographers', async () => {
    const { getEventStats } = await import('../src/services/event-stats.js');
    store.photos.push(
      { id: 'p1', eventId: 'ev1', photographerUserId: 'A' },
      { id: 'p2', eventId: 'ev1', photographerUserId: 'A' },
      { id: 'p3', eventId: 'ev1', photographerUserId: 'B' },
    );
    store.faceVectors.push(
      { photoId: 'p1', eventId: 'ev1' },
      { photoId: 'p1', eventId: 'ev1' },
      { photoId: 'p2', eventId: 'ev1' },
    );
    store.orders.push(
      {
        id: 'o1',
        eventId: 'ev1',
        totalCents: 5000,
        refundedCents: 0,
        currency: 'eur',
        status: 'paid',
        placedAt: new Date('2026-05-10T09:30:00Z'),
      },
      {
        id: 'o2',
        eventId: 'ev1',
        totalCents: 3000,
        refundedCents: 1000,
        currency: 'eur',
        status: 'partially_refunded',
        placedAt: new Date('2026-05-10T10:15:00Z'),
      },
      {
        id: 'o3',
        eventId: 'ev1',
        totalCents: 2000,
        refundedCents: 0,
        currency: 'eur',
        status: 'pending_payment',
        placedAt: new Date('2026-05-10T11:00:00Z'),
      },
    );
    store.orderItems.push(
      { orderId: 'o1', photoId: 'p1', lineTotalCents: 5000 },
      { orderId: 'o2', photoId: 'p3', lineTotalCents: 3000 },
    );

    const stats = await getEventStats(db as never, 'ev1');
    expect(stats.totalPhotosUploaded).toBe(3);
    expect(stats.photosWithFaces).toBe(2);
    expect(stats.uniqueFacesDetected).toBe(3);
    expect(stats.totalOrders).toBe(2); // paid + partially_refunded; pending excluded
    expect(stats.grossRevenueCents).toBe(8000);
    expect(stats.refundAmountCents).toBe(1000);
    expect(stats.refundCount).toBe(1);
    expect(stats.netRevenueCents).toBe(7000);
    expect(stats.currency).toBe('eur');
    expect(stats.topPhotographersBySales[0]).toEqual({ photographerUserId: 'A', salesCents: 5000 });
    expect(stats.conversionRate).toBeCloseTo(2 / 3, 5);
    expect(stats.salesByHour).toHaveLength(2);
  });

  it('never returns PII (only the documented fields)', async () => {
    const { getEventStats } = await import('../src/services/event-stats.js');
    store.photos.push({ id: 'p1', eventId: 'ev1', photographerUserId: 'A' });
    const stats = await getEventStats(db as never, 'ev1');
    const keys = Object.keys(stats);
    expect(keys).not.toContain('buyerEmail');
    expect(JSON.stringify(stats)).not.toMatch(/@/); // no emails anywhere
  });

  it('caches within the TTL (same object returned)', async () => {
    const { getEventStats } = await import('../src/services/event-stats.js');
    store.photos.push({ id: 'p1', eventId: 'ev1', photographerUserId: 'A' });
    const now = new Date('2026-05-21T00:00:00Z');
    const a = await getEventStats(db as never, 'ev1', { now });
    store.photos.push({ id: 'p2', eventId: 'ev1', photographerUserId: 'A' });
    const b = await getEventStats(db as never, 'ev1', { now });
    expect(b).toBe(a); // cache hit; second photo not reflected
    expect(b.totalPhotosUploaded).toBe(1);
  });
});

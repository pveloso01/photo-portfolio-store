// Route tests for bundles routes. Uses the same in-memory fake DB pattern
// as pricing-route.test.ts. Tests POST /v1/bundles/:id/resolve and
// GET /v1/events/:eventId/foto-flat.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Types ----------

type Row = Record<string, unknown>;

interface Store {
  bundles: Row[];
  bundleItems: Row[];
  products: Row[];
  photos: Row[];
  bibTags: Row[];
  licenseTiers: Row[];
}

const newStore = (): Store => ({
  bundles: [],
  bundleItems: [],
  products: [],
  photos: [],
  bibTags: [],
  licenseTiers: [],
});

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const catalogTables = {
    bundles: tableMarker('bundles'),
    bundleItems: tableMarker('bundleItems'),
    products: tableMarker('products'),
    licenseTiers: tableMarker('licenseTiers'),
    pricingRules: tableMarker('licenseTiers'),
    pricingRuleTargets: tableMarker('licenseTiers'),
  };
  const photosTables = {
    photos: tableMarker('photos'),
    photoDerivatives: tableMarker('photos'),
  };
  const searchTables = {
    bibTags: tableMarker('bibTags'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      catalog: { tables: catalogTables },
      photos: { tables: photosTables },
      search: { tables: searchTables },
      commerce: { tables: {} },
      events: { tables: {} },
      compliance: { tables: {} },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({ min: () => ({}) }),
  },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[(v as Field).column] : v);

  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const desc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column] as number;
    const bv = b[field.column] as number;
    return av > bv ? -1 : av < bv ? 1 : 0;
  };
  const sqlTag = ((_strings: TemplateStringsArray) => ({ __sql: '' })) as unknown as Record<
    string,
    unknown
  >;
  return { eq, and, desc, sql: sqlTag };
});

// ---------- Fake DB ----------

let store: Store = newStore();

const makeFakeDb = (): unknown => {
  const runSelect = (
    bucket: keyof Store,
    filterFn: (r: Row) => boolean,
    sortFn?: (a: Row, b: Row) => number,
    limit?: number,
  ): Row[] => {
    let rows = store[bucket].filter(filterFn);
    if (sortFn) rows = [...rows].sort(sortFn);
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map((r) => ({ ...r }));
  };

  const selectBuilder = (_selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let sortFn: ((a: Row, b: Row) => number) | undefined;
    let limitN: number | undefined;
    let joinBucket: keyof Store | null = null;
    let joinOnFn: ((mergedRow: Row) => boolean) | null = null;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      innerJoin(table: Row, on: (mergedRow: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinOnFn = on;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      orderBy(...args: Array<((a: Row, b: Row) => number) | { column: string }>) {
        const comparators = args.map((arg) => {
          if (typeof arg === 'function') return arg;
          const col = arg.column;
          return (a: Row, b: Row) => {
            const av = a[col] as number | string;
            const bv = b[col] as number | string;
            return av > bv ? 1 : av < bv ? -1 : 0;
          };
        });
        sortFn = (a, b) => {
          for (const c of comparators) {
            const v = c(a, b);
            if (v !== 0) return v;
          }
          return 0;
        };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          if (!bucket) return resolve([]);
          const filterFn = (r: Row) => filters.every((f) => f(r));
          let rows: Row[];
          if (joinBucket && joinOnFn) {
            const primary = store[bucket];
            const secondary = store[joinBucket];
            rows = primary
              .flatMap((p) =>
                secondary.map((s) => ({ ...s, ...p })).filter((merged) => joinOnFn!(merged)),
              )
              .filter(filterFn);
          } else {
            rows = runSelect(bucket, filterFn, sortFn, limitN);
          }
          if (sortFn) rows = [...rows].sort(sortFn);
          if (limitN !== undefined) rows = rows.slice(0, limitN);
          return resolve(rows.map((r) => ({ ...r })));
        } catch (e) {
          return reject(e);
        }
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let toInsert: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        toInsert = arr.map((row) => ({
          id: fakeUuid(),
          createdAt: new Date(),
          ...row,
        }));
        store[bucket].push(...toInsert.map((r) => ({ ...r })));
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(toInsert.map((r) => ({ ...r })));
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
    insert: (table: Row) => insertBuilder(table),
  };
};

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const bundlesTbl = schema.catalog.tables.bundles as Record<string, unknown>;
  const bundleItemsTbl = schema.catalog.tables.bundleItems as Record<string, unknown>;
  const productsTbl = schema.catalog.tables.products as Record<string, unknown>;
  const photosTbl = schema.photos.tables.photos as Record<string, unknown>;
  const bibTagsTbl = schema.search.tables.bibTags as Record<string, unknown>;

  for (const col of [
    'id',
    'eventId',
    'kind',
    'selector',
    'basePriceCents',
    'currency',
    'licenseTierId',
    'active',
    'createdAt',
  ]) {
    bundlesTbl[col] = { column: col };
  }
  for (const col of ['bundleId', 'photoId']) {
    bundleItemsTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'eventId',
    'kind',
    'sku',
    'name',
    'priceCents',
    'currency',
    'licenseTierId',
    'configJsonb',
    'photoId',
    'active',
    'createdAt',
    'updatedAt',
  ]) {
    productsTbl[col] = { column: col };
  }
  for (const col of ['id', 'eventId', 'status', 'hidden', 'featured', 'createdAt', 'updatedAt']) {
    photosTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'photoId',
    'eventId',
    'bibNumber',
    'confidence',
    'source',
    'createdAt',
  ]) {
    bibTagsTbl[col] = { column: col };
  }
};

// ---------- Seed helpers ----------

const EVENT_ID = '00000000-0000-4000-8000-0000000000aa';
const TIER_ID = '00000000-0000-4000-8000-000000000001';
const BUNDLE_CUSTOM_ID = '00000000-0000-4000-8000-000000000012';
const BUNDLE_FLAT_ID = '00000000-0000-4000-8000-000000000011';
const PHOTO_A = '00000000-0000-4000-8000-000000000a01';
const PHOTO_B = '00000000-0000-4000-8000-000000000a02';

const seedCustomBundle = (id = BUNDLE_CUSTOM_ID): void => {
  store.bundles.push({
    id,
    eventId: EVENT_ID,
    kind: 'custom',
    selector: {},
    basePriceCents: 3000,
    currency: 'USD',
    licenseTierId: TIER_ID,
    active: true,
  });
};

const seedFlatBundle = (): void => {
  store.bundles.push({
    id: BUNDLE_FLAT_ID,
    eventId: EVENT_ID,
    kind: 'foto_flat',
    selector: { all: true },
    basePriceCents: 5000,
    currency: 'USD',
    licenseTierId: TIER_ID,
    active: true,
  });
};

const seedPhoto = (id: string, status = 'ready'): void => {
  store.photos.push({ id, eventId: EVENT_ID, status, createdAt: new Date() });
};

// ---------- Lifecycle ----------

let app: FastifyInstance;
let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();

  const { default: bundleRoutes } = await import('../src/routes/bundles.js');
  app = Fastify({ logger: false });
  await app.register(async (instance) => {
    await bundleRoutes(instance, { db: db as never });
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});

// ---------- POST /v1/bundles/:id/resolve ----------

describe('POST /v1/bundles/:id/resolve', () => {
  it('returns 200 with photoIds for a valid custom bundle', async () => {
    seedCustomBundle();
    store.bundleItems.push({ bundleId: BUNDLE_CUSTOM_ID, photoId: PHOTO_A });
    store.bundleItems.push({ bundleId: BUNDLE_CUSTOM_ID, photoId: PHOTO_B });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bundles/${BUNDLE_CUSTOM_ID}/resolve`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      photoIds: string[];
      count: number;
      totalCents: number;
      currency: string;
    };
    expect(body.count).toBe(2);
    expect(body.photoIds).toContain(PHOTO_A);
    expect(body.photoIds).toContain(PHOTO_B);
    expect(body.totalCents).toBe(3000);
    expect(body.currency).toBe('USD');
  });

  it('returns 409 BUNDLE_EMPTY when bundle has no items', async () => {
    seedCustomBundle();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bundles/${BUNDLE_CUSTOM_ID}/resolve`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string };
    expect(body.error).toBe('BUNDLE_EMPTY');
  });

  it('returns 404 for an unknown bundle id', async () => {
    const unknownId = '00000000-0000-4000-8000-000000ffffff';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/bundles/${unknownId}/resolve`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a non-UUID bundle id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bundles/not-a-uuid/resolve',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------- GET /v1/events/:eventId/foto-flat ----------

describe('GET /v1/events/:eventId/foto-flat', () => {
  it('returns 200 with summary for an event that has a foto-flat bundle', async () => {
    seedFlatBundle();
    seedPhoto(PHOTO_A);
    seedPhoto(PHOTO_B);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EVENT_ID}/foto-flat`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bundleId: string;
      photoCount: number;
      priceCents: number;
      currency: string;
      licenseTierId: string;
    };
    expect(body.bundleId).toBe(BUNDLE_FLAT_ID);
    expect(body.photoCount).toBe(2);
    expect(body.priceCents).toBe(5000);
    expect(body.currency).toBe('USD');
  });

  it('returns 404 when no foto-flat bundle exists for the event', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EVENT_ID}/foto-flat`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid eventId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/not-a-uuid/foto-flat',
    });
    expect(res.statusCode).toBe(400);
  });
});

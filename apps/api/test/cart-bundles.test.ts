// Unit tests for the bundle-to-cart path in services/carts.ts.
// Mirrors the in-memory store pattern from pricing-tiers.test.ts.
// Does NOT edit or conflict with cart.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Types ----------

type Row = Record<string, unknown>;

interface Store {
  bundles: Row[];
  bundleItems: Row[];
  products: Row[];
  photos: Row[];
  bibTags: Row[];
  licenseTiers: Row[];
  carts: Row[];
  cartItems: Row[];
  auditLog: Row[];
  events: Row[];
}

const newStore = (): Store => ({
  bundles: [],
  bundleItems: [],
  products: [],
  photos: [],
  bibTags: [],
  licenseTiers: [],
  carts: [],
  cartItems: [],
  auditLog: [],
  events: [],
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
  const commerceTables = {
    carts: tableMarker('carts'),
    cartItems: tableMarker('cartItems'),
    orders: tableMarker('carts'),
    orderItems: tableMarker('carts'),
    fulfillments: tableMarker('carts'),
  };
  const eventsTables = {
    events: tableMarker('events'),
    eventSettings: tableMarker('events'),
    eventMembers: tableMarker('events'),
  };
  const complianceTables = {
    auditLog: tableMarker('auditLog'),
    consents: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      catalog: { tables: catalogTables },
      photos: { tables: photosTables },
      search: { tables: searchTables },
      commerce: { tables: commerceTables },
      events: { tables: eventsTables },
      compliance: { tables: complianceTables },
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
  // sql.raw is used in carts.ts for void sql keep-alive.
  const sqlProxy = new Proxy(sqlTag, { apply: () => ({ __sql: '' }) });
  return { eq, and, desc, sql: sqlProxy };
});

// ---------- Fake DB builder ----------

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

  const updateBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let setPatch: Record<string, unknown> = {};
    const filters: Array<(r: Row) => boolean> = [];
    let toReturn: Row[] = [];
    const api = {
      set(patch: Record<string, unknown>) {
        setPatch = patch;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      returning() {
        // Apply update and return.
        const filterFn = (r: Row) => filters.every((f) => f(r));
        toReturn = [];
        for (let i = 0; i < store[bucket].length; i++) {
          const r = store[bucket][i];
          if (r && filterFn(r)) {
            const updated = { ...r, ...setPatch };
            store[bucket][i] = updated;
            toReturn.push({ ...updated });
          }
        }
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(toReturn);
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
    insert: (table: Row) => insertBuilder(table),
    update: (table: Row) => updateBuilder(table),
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
  const cartsTbl = schema.commerce.tables.carts as Record<string, unknown>;
  const cartItemsTbl = schema.commerce.tables.cartItems as Record<string, unknown>;
  const auditLogTbl = schema.compliance.tables.auditLog as Record<string, unknown>;

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

  for (const col of [
    'id',
    'anonymousToken',
    'userId',
    'eventId',
    'currency',
    'status',
    'expiresAt',
    'convertedAt',
    'createdAt',
    'updatedAt',
  ]) {
    cartsTbl[col] = { column: col };
  }

  for (const col of [
    'id',
    'cartId',
    'productId',
    'photoId',
    'licenseTierId',
    'quantity',
    'unitPriceCents',
    'currency',
    'createdAt',
  ]) {
    cartItemsTbl[col] = { column: col };
  }

  for (const col of [
    'id',
    'action',
    'actorKind',
    'actorUserId',
    'targetKind',
    'targetId',
    'eventId',
    'payloadJsonb',
    'payloadHash',
    'ipHash',
    'userAgent',
    'createdAt',
  ]) {
    auditLogTbl[col] = { column: col };
  }
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const EVENT_ID = '00000000-0000-4000-8000-0000000000aa';
const TIER_ID = '00000000-0000-4000-8000-000000000001';
const CART_ID = '00000000-0000-4000-8000-000000000099';
const BUNDLE_ID = '00000000-0000-4000-8000-000000000010';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000020';
const PHOTO_A = '00000000-0000-4000-8000-000000000a01';

const seedActiveCart = (): void => {
  store.carts.push({
    id: CART_ID,
    anonymousToken: 'a'.repeat(64),
    userId: null,
    eventId: EVENT_ID,
    currency: 'USD',
    status: 'active',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const seedCustomBundle = (): void => {
  store.bundles.push({
    id: BUNDLE_ID,
    eventId: EVENT_ID,
    kind: 'custom',
    selector: {},
    basePriceCents: 2000,
    currency: 'USD',
    licenseTierId: TIER_ID,
    active: true,
    createdAt: new Date(),
  });
};

const seedBundleProduct = (): void => {
  store.products.push({
    id: PRODUCT_ID,
    eventId: EVENT_ID,
    kind: 'digital_bundle',
    sku: 'bndl-custom-test',
    name: 'Test Bundle',
    priceCents: 2000,
    currency: 'USD',
    licenseTierId: TIER_ID,
    configJsonb: { bundleId: BUNDLE_ID },
    photoId: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
};

const seedBundleItem = (photoId: string): void => {
  store.bundleItems.push({ bundleId: BUNDLE_ID, photoId });
};

const seedPhoto = (id: string, status = 'ready'): void => {
  store.photos.push({ id, eventId: EVENT_ID, status, createdAt: new Date() });
};

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

// ---------- addBundleToCart ----------

describe('addBundleToCart', () => {
  it('happy path: inserts a cart_items row with photoId=null', async () => {
    const { addBundleToCart } = await import('../src/services/carts.js');
    seedActiveCart();
    seedCustomBundle();
    seedBundleProduct();
    seedBundleItem(PHOTO_A);
    seedPhoto(PHOTO_A);

    const result = await addBundleToCart(db as never, CART_ID, { bundleId: BUNDLE_ID });
    expect(result.cartItemId).toBeTruthy();
    expect(result.snapshotCount).toBe(1);

    expect(store.cartItems).toHaveLength(1);
    const item = store.cartItems[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.productId).toBe(PRODUCT_ID);
    expect(item.photoId).toBeNull();
    expect(item.licenseTierId).toBe(TIER_ID);
    expect(item.unitPriceCents).toBe(2000);
    expect(item.currency).toBe('USD');
  });

  it('throws conflict (BUNDLE_EMPTY) when bundle has no items', async () => {
    const { addBundleToCart, CartServiceError } = await import('../src/services/carts.js');
    seedActiveCart();
    seedCustomBundle();
    seedBundleProduct();
    // No bundleItems seeded.

    await expect(
      addBundleToCart(db as never, CART_ID, { bundleId: BUNDLE_ID }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      addBundleToCart(db as never, CART_ID, { bundleId: BUNDLE_ID }),
    ).rejects.toBeInstanceOf(CartServiceError);
  });

  it('throws unprocessable when bundle product is not found', async () => {
    const { addBundleToCart } = await import('../src/services/carts.js');
    seedActiveCart();
    seedCustomBundle();
    seedBundleItem(PHOTO_A);
    seedPhoto(PHOTO_A);
    // No bundle product seeded.

    await expect(
      addBundleToCart(db as never, CART_ID, { bundleId: BUNDLE_ID }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('throws unprocessable when bundle event does not match cart event', async () => {
    const { addBundleToCart } = await import('../src/services/carts.js');
    seedActiveCart();
    seedCustomBundle();
    seedBundleItem(PHOTO_A);
    seedPhoto(PHOTO_A);
    // Product belongs to a different event.
    store.products.push({
      id: PRODUCT_ID,
      eventId: '00000000-0000-4000-8000-000000009999', // different event
      kind: 'digital_bundle',
      sku: 'bndl-custom-other',
      name: 'Other Event Bundle',
      priceCents: 2000,
      currency: 'USD',
      licenseTierId: TIER_ID,
      configJsonb: { bundleId: BUNDLE_ID },
      photoId: null,
      active: true,
    });

    await expect(
      addBundleToCart(db as never, CART_ID, { bundleId: BUNDLE_ID }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('bumps quantity on duplicate bundle in cart', async () => {
    const { addBundleToCart } = await import('../src/services/carts.js');
    seedActiveCart();
    seedCustomBundle();
    seedBundleProduct();
    seedBundleItem(PHOTO_A);
    seedPhoto(PHOTO_A);

    await addBundleToCart(db as never, CART_ID, { bundleId: BUNDLE_ID, quantity: 1 });
    const result2 = await addBundleToCart(db as never, CART_ID, {
      bundleId: BUNDLE_ID,
      quantity: 2,
    });
    // Should have deduplicated rather than inserted a second row.
    expect(store.cartItems).toHaveLength(1);
    const item = store.cartItems[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.quantity).toBe(3);
    expect(result2.snapshotCount).toBe(1);
  });
});

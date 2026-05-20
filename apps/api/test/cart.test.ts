// Cart service + route tests. Uses the same in-memory fake DbClient shape as
// events.test.ts / products.test.ts — @pkg/db and drizzle-orm are mocked so
// the service runs without Postgres.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  carts: Row[];
  cartItems: Row[];
  products: Row[];
  photos: Row[];
  events: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({
  carts: [],
  cartItems: [],
  products: [],
  photos: [],
  events: [],
  auditLog: [],
});

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store) => {
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
  const commerceTables = {
    carts: tableMarker('carts'),
    cartItems: tableMarker('cartItems'),
    orders: tableMarker('carts'),
    orderItems: tableMarker('carts'),
    fulfillments: tableMarker('carts'),
  };
  const catalogTables = {
    products: tableMarker('products'),
    licenseTiers: tableMarker('products'),
    bundles: tableMarker('bundles'),
    bundleItems: tableMarker('bundles'),
    pricingRules: tableMarker('products'),
    pricingRuleTargets: tableMarker('products'),
  };
  const searchTables = {
    bibTags: tableMarker('bibTags'),
  };
  const photoTables = {
    photos: tableMarker('photos'),
    uploadSessions: tableMarker('photos'),
    photoDerivatives: tableMarker('photos'),
  };
  const eventTables = {
    events: tableMarker('events'),
    eventMembers: tableMarker('events'),
    eventSettings: tableMarker('events'),
    eventFtpCredentials: tableMarker('events'),
  };
  const complianceTables = {
    auditLog: tableMarker('auditLog'),
    consents: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      commerce: { tables: commerceTables },
      catalog: { tables: catalogTables },
      photos: { tables: photoTables },
      events: { tables: eventTables },
      search: { tables: searchTables },
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

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      orderBy(...comparators: Array<(a: Row, b: Row) => number>) {
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
          return resolve(runSelect(bucket, filterFn, sortFn, limitN));
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
          updatedAt: new Date(),
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
    let setPayload: Row = {};
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      set(payload: Row) {
        setPayload = payload;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        const filterFn = (r: Row) => filters.every((f) => f(r));
        const updated: Row[] = [];
        for (const row of store[bucket]) {
          if (filterFn(row)) {
            Object.assign(row, setPayload);
            updated.push({ ...row });
          }
        }
        return resolve(updated);
      },
    };
    return api;
  };

  const deleteBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      returning() {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        const filterFn = (r: Row) => filters.every((f) => f(r));
        const removed: Row[] = [];
        store[bucket] = store[bucket].filter((row) => {
          if (filterFn(row)) {
            removed.push({ ...row });
            return false;
          }
          return true;
        });
        return resolve(removed);
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
    insert: (table: Row) => insertBuilder(table),
    update: (table: Row) => updateBuilder(table),
    delete: (table: Row) => deleteBuilder(table),
  };
};

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
  const or =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.some((p) => p(row));
  const lt = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row);
    const bv = valueOf(b, row);
    if (av instanceof Date && bv instanceof Date) return av.getTime() < bv.getTime();
    return (av as number) < (bv as number);
  };
  const gte = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row);
    const bv = valueOf(b, row);
    return (av as number) >= (bv as number);
  };
  const sqlTag = ((strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sql: strings.join(''),
  })) as unknown as Record<string, unknown>;
  sqlTag.join = (_arr: unknown[], _sep: unknown) => ({ __sql: 'joined' });
  return { eq, and, or, lt, gte, sql: sqlTag };
});

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const cartsTbl = schema.commerce.tables.carts as Record<string, unknown>;
  const cartItemsTbl = schema.commerce.tables.cartItems as Record<string, unknown>;
  const productsTbl = schema.catalog.tables.products as Record<string, unknown>;
  const photosTbl = schema.photos.tables.photos as Record<string, unknown>;
  const eventsTbl = schema.events.tables.events as Record<string, unknown>;
  const auditTbl = schema.compliance.tables.auditLog as Record<string, unknown>;

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
    'eventId',
    'priceCents',
    'currency',
    'licenseTierId',
    'photoId',
    'active',
    'kind',
  ]) {
    productsTbl[col] = { column: col };
  }
  for (const col of ['id', 'eventId', 'status']) {
    photosTbl[col] = { column: col };
  }
  for (const col of ['id', 'orgId', 'status', 'currency']) {
    eventsTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'actorUserId',
    'actorKind',
    'action',
    'targetKind',
    'targetId',
    'eventId',
    'payloadJsonb',
  ]) {
    auditTbl[col] = { column: col };
  }
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const EVENT_A = '00000000-0000-4000-8000-0000000000aa';
const EVENT_B = '00000000-0000-4000-8000-0000000000bb';
const PRODUCT_1 = '00000000-0000-4000-8000-000000000d01';
const PRODUCT_OTHER_EVENT = '00000000-0000-4000-8000-000000000d02';
const PHOTO_1 = '00000000-0000-4000-8000-000000000111';
const TIER_PERSONAL = '00000000-0000-4000-8000-0000000aaaa1';

const seedEvent = (id: string, currency = 'USD'): void => {
  store.events.push({ id, orgId: 'org-1', status: 'published', currency });
};

const seedPhoto = (id: string, eventId: string, status = 'ready'): void => {
  store.photos.push({ id, eventId, status });
};

const seedProduct = (args: {
  id: string;
  eventId: string;
  photoId?: string | null;
  licenseTierId?: string;
  active?: boolean;
  priceCents?: number;
  currency?: string;
}): void => {
  store.products.push({
    id: args.id,
    eventId: args.eventId,
    photoId: args.photoId ?? null,
    licenseTierId: args.licenseTierId ?? TIER_PERSONAL,
    priceCents: args.priceCents ?? 1500,
    currency: args.currency ?? 'USD',
    active: args.active ?? true,
    kind: 'digital_single',
  });
};

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const importService = async () => await import('../src/services/carts.js');

// ---------- Service tests ----------

describe('carts service', () => {
  it('creates a cart bound to an event with a 64-hex token and 7-day TTL', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);

    const result = await svc.createCart(db as never, { eventId: EVENT_A });
    expect(result.eventId).toBe(EVENT_A);
    expect(result.currency).toBe('USD');
    expect(result.anonymousToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(store.auditLog.some((r) => r.action === 'cart.created')).toBe(true);
  });

  it('createCart rejects unknown event with 422', async () => {
    const svc = await importService();
    await expect(svc.createCart(db as never, { eventId: EVENT_A })).rejects.toMatchObject({
      code: 'unprocessable',
    });
  });

  it('addCartItem validates product existence (422)', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });

    await expect(
      svc.addCartItem(db as never, cart.id, {
        productId: PRODUCT_1,
        licenseTierId: TIER_PERSONAL,
      }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('addCartItem rejects product from a different event (422)', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    seedEvent(EVENT_B);
    seedProduct({ id: PRODUCT_OTHER_EVENT, eventId: EVENT_B });
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });

    await expect(
      svc.addCartItem(db as never, cart.id, {
        productId: PRODUCT_OTHER_EVENT,
        licenseTierId: TIER_PERSONAL,
      }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('addCartItem bumps quantity on duplicate triplet (no duplicate row)', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    seedPhoto(PHOTO_1, EVENT_A);
    seedProduct({ id: PRODUCT_1, eventId: EVENT_A, photoId: PHOTO_1 });
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });

    await svc.addCartItem(db as never, cart.id, {
      productId: PRODUCT_1,
      photoId: PHOTO_1,
      licenseTierId: TIER_PERSONAL,
    });
    await svc.addCartItem(db as never, cart.id, {
      productId: PRODUCT_1,
      photoId: PHOTO_1,
      licenseTierId: TIER_PERSONAL,
      quantity: 2,
    });

    expect(store.cartItems).toHaveLength(1);
    expect(store.cartItems[0]?.quantity).toBe(3);
  });

  it('updateCartItem with quantity <= 0 throws unprocessable', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    seedProduct({ id: PRODUCT_1, eventId: EVENT_A });
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });
    const item = await svc.addCartItem(db as never, cart.id, {
      productId: PRODUCT_1,
      licenseTierId: TIER_PERSONAL,
    });

    await expect(svc.updateCartItem(db as never, item.id, { quantity: 0 })).rejects.toMatchObject({
      code: 'unprocessable',
    });
    await expect(svc.updateCartItem(db as never, item.id, { quantity: -3 })).rejects.toMatchObject({
      code: 'unprocessable',
    });
  });

  it('removeCartItem deletes the row and bumps cart.updated_at', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    seedProduct({ id: PRODUCT_1, eventId: EVENT_A });
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });
    const item = await svc.addCartItem(db as never, cart.id, {
      productId: PRODUCT_1,
      licenseTierId: TIER_PERSONAL,
    });

    const before = store.carts.find((r) => r.id === cart.id)?.updatedAt as Date;
    // Tick clock minimally
    await new Promise((r) => setTimeout(r, 5));
    await svc.removeCartItem(db as never, item.id);

    expect(store.cartItems).toHaveLength(0);
    const after = store.carts.find((r) => r.id === cart.id)?.updatedAt as Date;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(store.auditLog.some((r) => r.action === 'cart.item.removed')).toBe(true);
  });

  it('getCart returns 410-equivalent for expired carts and marks them expired', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });
    // Force expiry in the store directly.
    const row = store.carts.find((r) => r.id === cart.id);
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    await expect(svc.getCart(db as never, cart.anonymousToken)).rejects.toMatchObject({
      code: 'expired',
    });
    const after = store.carts.find((r) => r.id === cart.id);
    expect(after?.status).toBe('expired');
  });

  it('audit logs cover create / add / update / remove', async () => {
    const svc = await importService();
    seedEvent(EVENT_A);
    seedProduct({ id: PRODUCT_1, eventId: EVENT_A });
    const cart = await svc.createCart(db as never, { eventId: EVENT_A });
    const item = await svc.addCartItem(db as never, cart.id, {
      productId: PRODUCT_1,
      licenseTierId: TIER_PERSONAL,
    });
    await svc.updateCartItem(db as never, item.id, { quantity: 4 });
    await svc.removeCartItem(db as never, item.id);

    const actions = store.auditLog.map((r) => r.action);
    expect(actions).toContain('cart.created');
    expect(actions).toContain('cart.item.added');
    expect(actions).toContain('cart.item.updated');
    expect(actions).toContain('cart.item.removed');
  });
});

// ---------- Route wiring smoke test ----------

const extractCookie = (res: { headers: Record<string, unknown> }): string | undefined => {
  const raw = res.headers['set-cookie'];
  if (!raw) return undefined;
  const headerLine = Array.isArray(raw) ? raw[0] : (raw as string);
  // First segment: pps_cart=<token>
  const first = headerLine?.split(';')[0];
  return first;
};

describe('cart routes (HTTP)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { default: cartRoutes } = await import('../src/routes/cart.js');
    app = Fastify({ logger: false });
    await app.register(async (instance) => {
      await cartRoutes(instance, { db: db as never });
    });
    await app.ready();
    seedEvent(EVENT_A);
    seedEvent(EVENT_B);
    seedPhoto(PHOTO_1, EVENT_A);
    seedProduct({ id: PRODUCT_1, eventId: EVENT_A, photoId: PHOTO_1 });
    seedProduct({ id: PRODUCT_OTHER_EVENT, eventId: EVENT_B });
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /v1/cart → 201 sets the cart cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    expect(res.statusCode).toBe(201);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const headerLine = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    expect(headerLine).toMatch(/^pps_cart=[0-9a-f]{64}/);
    expect(headerLine).toContain('HttpOnly');
    expect(headerLine).toContain('SameSite=Lax');
    expect(headerLine).toContain('Path=/');
  });

  it('GET /v1/cart without cookie → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/cart' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/cart with valid cookie → 200', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: { cookie: cookie ?? '' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cart.eventId).toBe(EVENT_A);
    expect(body.items).toEqual([]);
  });

  it('POST /v1/cart/items with non-existent product → 422', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { cookie: cookie ?? '' },
      payload: {
        productId: '00000000-0000-4000-8000-00000000dead',
        licenseTierId: TIER_PERSONAL,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('POST /v1/cart/items with product from different event → 422', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { cookie: cookie ?? '' },
      payload: {
        productId: PRODUCT_OTHER_EVENT,
        licenseTierId: TIER_PERSONAL,
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('POST /v1/cart/items duplicate triplet bumps quantity (no duplicate row)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { cookie: cookie ?? '' },
      payload: { productId: PRODUCT_1, photoId: PHOTO_1, licenseTierId: TIER_PERSONAL },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { cookie: cookie ?? '' },
      payload: {
        productId: PRODUCT_1,
        photoId: PHOTO_1,
        licenseTierId: TIER_PERSONAL,
        quantity: 2,
      },
    });
    expect(second.statusCode).toBe(201);
    expect(store.cartItems).toHaveLength(1);
    expect(store.cartItems[0]?.quantity).toBe(3);
  });

  it('PATCH /v1/cart/items/:itemId with quantity=0 → 422', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);
    const add = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { cookie: cookie ?? '' },
      payload: { productId: PRODUCT_1, photoId: PHOTO_1, licenseTierId: TIER_PERSONAL },
    });
    expect(add.statusCode).toBe(201);
    const itemId = store.cartItems[0]?.id as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/cart/items/${itemId}`,
      headers: { cookie: cookie ?? '' },
      payload: { quantity: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('DELETE /v1/cart/items/:itemId → 204 and bumps cart.updated_at', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);
    await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: { cookie: cookie ?? '' },
      payload: { productId: PRODUCT_1, photoId: PHOTO_1, licenseTierId: TIER_PERSONAL },
    });
    const itemId = store.cartItems[0]?.id as string;
    const cartRow = store.carts[0];
    const before = cartRow?.updatedAt as Date;
    await new Promise((r) => setTimeout(r, 5));

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/cart/items/${itemId}`,
      headers: { cookie: cookie ?? '' },
    });
    expect(res.statusCode).toBe(204);
    const after = store.carts[0]?.updatedAt as Date;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('Expired cart on GET → 410 and clears cookie', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_A },
    });
    const cookie = extractCookie(created as never);
    const cartRow = store.carts[0];
    if (cartRow) cartRow.expiresAt = new Date(Date.now() - 1000);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/cart',
      headers: { cookie: cookie ?? '' },
    });
    expect(res.statusCode).toBe(410);
    const setCookieHeader = res.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
  });
});

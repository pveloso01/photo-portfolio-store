// Checkout service + route tests. Uses the same in-memory fake DbClient
// shape as cart.test.ts and mocks the Stripe SDK so no network is touched.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  carts: Row[];
  cartItems: Row[];
  products: Row[];
  orders: Row[];
  orderItems: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({
  carts: [],
  cartItems: [],
  products: [],
  orders: [],
  orderItems: [],
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

// ---------- Stripe mock ----------

const stripeCreate = vi.fn();
const stripeRetrieve = vi.fn();

vi.mock('../src/lib/stripe.js', () => ({
  stripe: {
    paymentIntents: {
      create: (...args: unknown[]) => stripeCreate(...args),
      retrieve: (...args: unknown[]) => stripeRetrieve(...args),
    },
  },
  webhookSecret: undefined,
}));

// ---------- pkg mocks ----------

vi.mock('@pkg/db', () => {
  const commerceTables = {
    carts: tableMarker('carts'),
    cartItems: tableMarker('cartItems'),
    orders: tableMarker('orders'),
    orderItems: tableMarker('orderItems'),
    fulfillments: tableMarker('orders'),
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
    photos: tableMarker('products'),
    uploadSessions: tableMarker('products'),
    photoDerivatives: tableMarker('products'),
  };
  const eventTables = {
    events: tableMarker('products'),
    eventMembers: tableMarker('products'),
    eventSettings: tableMarker('products'),
    eventFtpCredentials: tableMarker('products'),
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
      compliance: { tables: complianceTables, auditLog: complianceTables.auditLog },
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

// ---------- Fake DB ----------

let store: Store = newStore();

const makeFakeDb = (): unknown => {
  const runSelect = (bucket: keyof Store, filterFn: (r: Row) => boolean, limit?: number): Row[] => {
    let rows = store[bucket].filter(filterFn);
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map((r) => ({ ...r }));
  };

  const selectBuilder = (_selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
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
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          if (!bucket) return resolve([]);
          const filterFn = (r: Row) => filters.every((f) => f(r));
          return resolve(runSelect(bucket, filterFn, limitN));
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
      then(resolve: (v: Row[]) => unknown) {
        const filterFn = (r: Row) => filters.every((f) => f(r));
        store[bucket] = store[bucket].filter((row) => !filterFn(row));
        return resolve([]);
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

// ---------- drizzle-orm mock ----------

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
  const sqlTag = ((strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sql: strings.join(''),
  })) as unknown as Record<string, unknown>;
  return { eq, and, sql: sqlTag };
});

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const cartsTbl = schema.commerce.tables.carts as Record<string, unknown>;
  const cartItemsTbl = schema.commerce.tables.cartItems as Record<string, unknown>;
  const ordersTbl = schema.commerce.tables.orders as Record<string, unknown>;
  const orderItemsTbl = schema.commerce.tables.orderItems as Record<string, unknown>;
  const productsTbl = schema.catalog.tables.products as Record<string, unknown>;
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
    'cartId',
    'eventId',
    'buyerEmail',
    'buyerUserId',
    'subtotalCents',
    'taxCents',
    'totalCents',
    'currency',
    'stripePaymentIntentId',
    'stripeChargeId',
    'status',
    'placedAt',
    'paidAt',
    'updatedAt',
  ]) {
    ordersTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'orderId',
    'productId',
    'photoId',
    'licenseTierId',
    'quantity',
    'unitPriceCents',
    'lineTotalCents',
    'currency',
    'metadataJsonb',
  ]) {
    orderItemsTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'eventId',
    'sku',
    'name',
    'kind',
    'configJsonb',
    'priceCents',
    'currency',
    'licenseTierId',
    'photoId',
    'active',
  ]) {
    productsTbl[col] = { column: col };
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
    'payloadHash',
    'ipHash',
    'userAgent',
  ]) {
    auditTbl[col] = { column: col };
  }
};

// ---------- Seed helpers ----------

const EVENT_A = '00000000-0000-4000-8000-0000000000aa';
const PRODUCT_1 = '00000000-0000-4000-8000-000000000d01';
const PRODUCT_2 = '00000000-0000-4000-8000-000000000d02';
const TIER_PERSONAL = '00000000-0000-4000-8000-0000000aaaa1';

let db: ReturnType<typeof makeFakeDb>;

const seedCart = (args: {
  status?: string;
  expiresAt?: Date;
  currency?: string;
}): Row => {
  const cart: Row = {
    id: fakeUuid(),
    anonymousToken: 'a'.repeat(64),
    userId: null,
    eventId: EVENT_A,
    currency: args.currency ?? 'USD',
    status: args.status ?? 'active',
    expiresAt: args.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    convertedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.carts.push(cart);
  return cart;
};

const seedCartItem = (
  cartId: string,
  args: { quantity?: number; unitPriceCents?: number; currency?: string; productId?: string },
): Row => {
  const row: Row = {
    id: fakeUuid(),
    cartId,
    productId: args.productId ?? PRODUCT_1,
    photoId: null,
    licenseTierId: TIER_PERSONAL,
    quantity: args.quantity ?? 1,
    unitPriceCents: args.unitPriceCents ?? 1500,
    currency: args.currency ?? 'USD',
    createdAt: new Date(),
  };
  store.cartItems.push(row);
  return row;
};

const seedProduct = (args: { id: string; priceCents?: number; currency?: string }): void => {
  store.products.push({
    id: args.id,
    eventId: EVENT_A,
    sku: `SKU-${args.id.slice(-4)}`,
    name: `Product ${args.id.slice(-4)}`,
    kind: 'digital_single',
    configJsonb: {},
    priceCents: args.priceCents ?? 1500,
    currency: args.currency ?? 'USD',
    licenseTierId: TIER_PERSONAL,
    photoId: null,
    active: true,
  });
};

// ---------- Lifecycle ----------

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  stripeCreate.mockReset();
  stripeRetrieve.mockReset();
  await installFieldShims();
  db = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const importService = async () => await import('../src/services/checkout.js');

// ---------- Service tests ----------

describe('createOrderFromCart', () => {
  it('happy path: 2 items → creates order, snapshots items, returns clientSecret, marks cart converted', async () => {
    const svc = await importService();
    const cart = seedCart({});
    seedCartItem(cart.id as string, { quantity: 2, unitPriceCents: 1500, productId: PRODUCT_1 });
    seedCartItem(cart.id as string, { quantity: 1, unitPriceCents: 2500, productId: PRODUCT_2 });
    seedProduct({ id: PRODUCT_1, priceCents: 1500 });
    seedProduct({ id: PRODUCT_2, priceCents: 2500 });

    stripeCreate.mockResolvedValue({
      id: 'pi_test_123',
      client_secret: 'pi_test_123_secret_abc',
    });

    const result = await svc.createOrderFromCart(db as never, cart.id as string, {
      buyerEmail: 'buyer@example.com',
    });

    // 2*1500 + 1*2500 = 5500
    expect(result.totalCents).toBe(5500);
    expect(result.currency).toBe('USD');
    expect(result.clientSecret).toBe('pi_test_123_secret_abc');
    expect(typeof result.orderId).toBe('string');

    // Order row exists with PI id and pending_payment.
    expect(store.orders).toHaveLength(1);
    const order = store.orders[0] as Row;
    expect(order.stripePaymentIntentId).toBe('pi_test_123');
    expect(order.status).toBe('pending_payment');
    expect(order.totalCents).toBe(5500);
    expect(order.buyerEmail).toBe('buyer@example.com');

    // Order items snapshotted.
    expect(store.orderItems).toHaveLength(2);
    const orderItem = store.orderItems[0] as Row;
    expect(orderItem.lineTotalCents).toBe(
      (orderItem.unitPriceCents as number) * (orderItem.quantity as number),
    );

    // Cart converted.
    const cartAfter = store.carts.find((r) => r.id === cart.id);
    expect(cartAfter?.status).toBe('converted');
    expect(cartAfter?.convertedAt).toBeInstanceOf(Date);

    // Stripe called with correct args.
    expect(stripeCreate).toHaveBeenCalledTimes(1);
    const [intentArgs, intentOpts] = stripeCreate.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(intentArgs.amount).toBe(5500);
    expect(intentArgs.currency).toBe('usd');
    expect((intentArgs.metadata as Record<string, string>).orderId).toBe(order.id);
    expect((intentArgs.metadata as Record<string, string>).cartId).toBe(cart.id);
    expect(intentOpts.idempotencyKey).toBe(order.id);

    // Audit log entries.
    const actions = store.auditLog.map((r) => r.action);
    expect(actions).toContain('order.created');
    expect(actions).toContain('checkout.intent_created');
  });

  it('empty cart → 422', async () => {
    const svc = await importService();
    const cart = seedCart({});

    await expect(
      svc.createOrderFromCart(db as never, cart.id as string, {
        buyerEmail: 'buyer@example.com',
      }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
    expect(stripeCreate).not.toHaveBeenCalled();
  });

  it('expired cart → 410', async () => {
    const svc = await importService();
    const cart = seedCart({ expiresAt: new Date(Date.now() - 1000) });
    seedCartItem(cart.id as string, {});
    seedProduct({ id: PRODUCT_1 });

    await expect(
      svc.createOrderFromCart(db as never, cart.id as string, {
        buyerEmail: 'buyer@example.com',
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(stripeCreate).not.toHaveBeenCalled();
  });

  it('cart not found → 404', async () => {
    const svc = await importService();
    await expect(
      svc.createOrderFromCart(db as never, '00000000-0000-4000-8000-deaddeaddead', {
        buyerEmail: 'buyer@example.com',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('Stripe failure → 503, order marked failed, cart NOT converted', async () => {
    const svc = await importService();
    const cart = seedCart({});
    seedCartItem(cart.id as string, {});
    seedProduct({ id: PRODUCT_1 });

    stripeCreate.mockRejectedValue(new Error('stripe down'));

    await expect(
      svc.createOrderFromCart(db as never, cart.id as string, {
        buyerEmail: 'buyer@example.com',
      }),
    ).rejects.toMatchObject({ code: 'stripe_unavailable' });

    // Cart NOT converted.
    const cartAfter = store.carts.find((r) => r.id === cart.id);
    expect(cartAfter?.status).toBe('active');

    // Order present but failed.
    expect(store.orders).toHaveLength(1);
    expect((store.orders[0] as Row).status).toBe('failed');

    const actions = store.auditLog.map((r) => r.action);
    expect(actions).toContain('checkout.intent_failed');
  });

  it('mixed-currency cart → 422', async () => {
    const svc = await importService();
    const cart = seedCart({ currency: 'USD' });
    seedCartItem(cart.id as string, { currency: 'USD' });
    seedCartItem(cart.id as string, { currency: 'BRL', productId: PRODUCT_2 });
    seedProduct({ id: PRODUCT_1 });
    seedProduct({ id: PRODUCT_2 });

    await expect(
      svc.createOrderFromCart(db as never, cart.id as string, {
        buyerEmail: 'buyer@example.com',
      }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
    expect(stripeCreate).not.toHaveBeenCalled();
  });

  it('idempotent: re-checkout of converted cart returns existing PaymentIntent', async () => {
    const svc = await importService();
    const cart = seedCart({});
    seedCartItem(cart.id as string, {});
    seedProduct({ id: PRODUCT_1 });

    stripeCreate.mockResolvedValue({
      id: 'pi_idem_1',
      client_secret: 'pi_idem_1_secret',
    });

    const first = await svc.createOrderFromCart(db as never, cart.id as string, {
      buyerEmail: 'buyer@example.com',
    });

    stripeRetrieve.mockResolvedValue({
      id: 'pi_idem_1',
      client_secret: 'pi_idem_1_secret',
    });

    const second = await svc.createOrderFromCart(db as never, cart.id as string, {
      buyerEmail: 'buyer@example.com',
    });

    expect(second.orderId).toBe(first.orderId);
    expect(second.clientSecret).toBe('pi_idem_1_secret');
    // Stripe create called only once across both invocations.
    expect(stripeCreate).toHaveBeenCalledTimes(1);
    expect(stripeRetrieve).toHaveBeenCalledTimes(1);
  });

  it('records buyerUserId when provided', async () => {
    const svc = await importService();
    const cart = seedCart({});
    seedCartItem(cart.id as string, {});
    seedProduct({ id: PRODUCT_1 });

    stripeCreate.mockResolvedValue({
      id: 'pi_user_1',
      client_secret: 'pi_user_1_secret',
    });

    const userId = '00000000-0000-4000-8000-00000000beef';
    await svc.createOrderFromCart(db as never, cart.id as string, {
      buyerEmail: 'buyer@example.com',
      buyerUserId: userId,
    });

    expect((store.orders[0] as Row).buyerUserId).toBe(userId);
  });
});

// ---------- Route tests ----------

describe('POST /v1/cart/:cartId/checkout', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { default: checkoutRoutes } = await import('../src/routes/checkout.js');
    app = Fastify({ logger: false });
    await app.register(async (instance) => {
      await checkoutRoutes(instance, { db: db as never });
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('happy path → 201 with clientSecret', async () => {
    const cart = seedCart({});
    seedCartItem(cart.id as string, { quantity: 1, unitPriceCents: 4200 });
    seedProduct({ id: PRODUCT_1, priceCents: 4200 });

    stripeCreate.mockResolvedValue({
      id: 'pi_route_1',
      client_secret: 'pi_route_1_secret',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/cart/${cart.id}/checkout`,
      payload: { buyerEmail: 'buyer@example.com' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.clientSecret).toBe('pi_route_1_secret');
    expect(body.totalCents).toBe(4200);
    expect(body.currency).toBe('USD');
    expect(typeof body.orderId).toBe('string');
  });

  it('invalid email → 400', async () => {
    const cart = seedCart({});
    const res = await app.inject({
      method: 'POST',
      url: `/v1/cart/${cart.id}/checkout`,
      payload: { buyerEmail: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('empty cart → 422', async () => {
    const cart = seedCart({});
    const res = await app.inject({
      method: 'POST',
      url: `/v1/cart/${cart.id}/checkout`,
      payload: { buyerEmail: 'buyer@example.com' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('expired cart → 410', async () => {
    const cart = seedCart({ expiresAt: new Date(Date.now() - 1000) });
    seedCartItem(cart.id as string, {});
    seedProduct({ id: PRODUCT_1 });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/cart/${cart.id}/checkout`,
      payload: { buyerEmail: 'buyer@example.com' },
    });
    expect(res.statusCode).toBe(410);
  });

  it('Stripe failure → 503', async () => {
    const cart = seedCart({});
    seedCartItem(cart.id as string, {});
    seedProduct({ id: PRODUCT_1 });

    stripeCreate.mockRejectedValue(new Error('stripe down'));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/cart/${cart.id}/checkout`,
      payload: { buyerEmail: 'buyer@example.com' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('cart not found → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cart/00000000-0000-4000-8000-00000000dead/checkout',
      payload: { buyerEmail: 'buyer@example.com' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('invalid cartId param → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cart/not-a-uuid/checkout',
      payload: { buyerEmail: 'buyer@example.com' },
    });
    expect(res.statusCode).toBe(400);
  });
});

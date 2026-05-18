// F1.30 — Stripe webhook handler tests.
//
// All external surfaces are stubbed: @pkg/db, @pkg/env, drizzle-orm, the Stripe
// SDK, and the fulfillment queue. The fake DB enforces a unique-PK constraint
// on stripe_webhook_events.id so we exercise the real idempotency path.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  orders: Row[];
  stripeWebhookEvents: Row[];
  auditLog: Row[];
  fulfillmentJobs: Row[];
}

const newStore = (): Store => ({
  orders: [],
  stripeWebhookEvents: [],
  auditLog: [],
  fulfillmentJobs: [],
});

let store: Store = newStore();

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store) => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

// ---------- Module mocks ----------

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://stub',
    STRIPE_SECRET_KEY: 'sk_test_xxx',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({ min: () => ({ optional: () => ({}) }) }),
  },
}));

vi.mock('@pkg/db', () => {
  const commerceTables = {
    orders: tableMarker('orders'),
    stripeWebhookEvents: tableMarker('stripeWebhookEvents'),
    carts: tableMarker('orders'),
    cartItems: tableMarker('orders'),
    orderItems: tableMarker('orders'),
    fulfillments: tableMarker('orders'),
  };
  const complianceTables = {
    auditLog: tableMarker('auditLog'),
    consents: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      commerce: { tables: commerceTables },
      compliance: { auditLog: complianceTables.auditLog, tables: complianceTables },
    },
  };
});

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

// Stripe SDK mock: webhooks.constructEvent is the only surface used.
const constructEventMock = vi.fn();
vi.mock('stripe', () => {
  class StripeMock {
    public webhooks = { constructEvent: constructEventMock };
  }
  return { default: StripeMock };
});

// ---------- Fake DB ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const ordersTbl = schema.commerce.tables.orders as Record<string, unknown>;
  for (const col of [
    'id',
    'cartId',
    'eventId',
    'buyerEmail',
    'status',
    'stripePaymentIntentId',
    'stripeChargeId',
    'paidAt',
    'totalCents',
    'updatedAt',
  ]) {
    ordersTbl[col] = { column: col };
  }
  const eventsTbl = schema.commerce.tables.stripeWebhookEvents as Record<string, unknown>;
  for (const col of ['id', 'type', 'payloadJsonb', 'processedAt', 'result', 'receivedAt']) {
    eventsTbl[col] = { column: col };
  }
};

const makeFakeDb = (): unknown => {
  const selectBuilder = (_sel?: Record<string, unknown>) => {
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
      orderBy() {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          if (!bucket) return resolve([]);
          let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
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
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        for (const row of arr) {
          // Enforce PK uniqueness for stripeWebhookEvents.
          if (bucket === 'stripeWebhookEvents' && row.id !== undefined) {
            const dup = store[bucket].find((r) => r.id === row.id);
            if (dup) {
              const err = new Error(
                'duplicate key value violates unique constraint "stripe_webhook_events_pkey"',
              ) as Error & { code?: string };
              err.code = '23505';
              throw err;
            }
          }
          store[bucket].push({ ...row });
        }
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          return resolve([]);
        } catch (e) {
          return reject(e);
        }
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
      then(resolve: (v: Row[]) => unknown) {
        const updated: Row[] = [];
        for (const row of store[bucket]) {
          if (filters.every((f) => f(row))) {
            Object.assign(row, setPayload);
            updated.push({ ...row });
          }
        }
        return resolve(updated);
      },
    };
    return api;
  };

  return {
    select: (sel?: Record<string, unknown>) => selectBuilder(sel),
    insert: (table: Row) => insertBuilder(table),
    update: (table: Row) => updateBuilder(table),
  };
};

// ---------- Helpers ----------

const seedPendingOrder = (overrides: Partial<Row> = {}): Row => {
  const order: Row = {
    id: 'order_1',
    cartId: 'cart_1',
    eventId: 'event_1',
    buyerEmail: 'buyer@example.com',
    status: 'pending_payment',
    stripePaymentIntentId: 'pi_test_123',
    stripeChargeId: null,
    paidAt: null,
    totalCents: 5000,
    updatedAt: new Date(),
    ...overrides,
  };
  store.orders.push(order);
  return order;
};

const paymentSucceededEvent = (overrides: Partial<Row> = {}): Record<string, unknown> => ({
  id: 'evt_pi_succeeded_1',
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_test_123',
      latest_charge: 'ch_test_abc',
      ...overrides,
    },
  },
});

const paymentFailedEvent = (): Record<string, unknown> => ({
  id: 'evt_pi_failed_1',
  type: 'payment_intent.payment_failed',
  data: {
    object: {
      id: 'pi_test_123',
      last_payment_error: { message: 'card declined' },
    },
  },
});

const unknownEvent = (): Record<string, unknown> => ({
  id: 'evt_unknown_1',
  type: 'invoice.upcoming',
  data: { object: { id: 'in_test' } },
});

// ---------- Setup ----------

let app: FastifyInstance | null = null;
const enqueueMock = vi.fn(async () => undefined);

beforeEach(async () => {
  store = newStore();
  vi.clearAllMocks();
  await installFieldShims();
  const fakeDb = makeFakeDb();
  const { setFulfillmentEnqueuer } = await import('../src/services/stripe-webhook.js');
  setFulfillmentEnqueuer(enqueueMock);

  const webhooksStripeRoutes = (await import('../src/routes/webhooks-stripe.js')).default;
  app = Fastify({ logger: false });
  await app.register(webhooksStripeRoutes, { db: fakeDb as never });
  await app.ready();
});

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

const postWebhook = async (event: Record<string, unknown>, signature = 'sig_ok') => {
  const raw = Buffer.from(JSON.stringify(event));
  // constructEvent receives raw body + sig; return the event when sig matches.
  constructEventMock.mockImplementationOnce((body: Buffer, sig: string, _secret: string) => {
    if (sig !== 'sig_ok') {
      throw new Error('No signatures found matching the expected signature for payload');
    }
    return JSON.parse(body.toString('utf8'));
  });
  return app!.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload: raw,
  });
};

// ---------- Tests ----------

describe('POST /v1/webhooks/stripe', () => {
  it('payment_intent.succeeded marks order paid and enqueues fulfillment', async () => {
    seedPendingOrder();
    const res = await postWebhook(paymentSucceededEvent());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { received: boolean; idempotent: boolean; result: string };
    expect(body.received).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.result).toBe('success');

    const order = store.orders[0];
    expect(order.status).toBe('paid');
    expect(order.paidAt).toBeInstanceOf(Date);
    expect(order.stripeChargeId).toBe('ch_test_abc');

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ orderId: 'order_1' });

    expect(store.stripeWebhookEvents).toHaveLength(1);
    expect(store.stripeWebhookEvents[0].result).toBe('success');
    expect(store.stripeWebhookEvents[0].processedAt).toBeInstanceOf(Date);
  });

  it('replay of the same event id is idempotent — no double-process, single row', async () => {
    seedPendingOrder();
    const event = paymentSucceededEvent();

    const first = await postWebhook(event);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { idempotent: boolean }).idempotent).toBe(false);

    const second = await postWebhook(event);
    expect(second.statusCode).toBe(200);
    const body = second.json() as { idempotent: boolean; result: string };
    expect(body.idempotent).toBe(true);
    expect(body.result).toBe('success');

    // Single insert for the event id.
    expect(store.stripeWebhookEvents).toHaveLength(1);
    // Fulfillment enqueued exactly once.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it('bad signature returns 401 and writes nothing', async () => {
    seedPendingOrder();
    const event = paymentSucceededEvent();
    const raw = Buffer.from(JSON.stringify(event));

    constructEventMock.mockImplementationOnce(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });

    const res = await app!.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'sig_bad',
      },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
    expect(store.stripeWebhookEvents).toHaveLength(0);
    expect(store.orders[0].status).toBe('pending_payment');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('payment_intent.payment_failed marks order failed', async () => {
    seedPendingOrder();
    const res = await postWebhook(paymentFailedEvent());
    expect(res.statusCode).toBe(200);
    expect(store.orders[0].status).toBe('failed');
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(store.stripeWebhookEvents[0].result).toBe('success');
  });

  it('unknown event type returns 200 and stores row with result=ignored', async () => {
    const res = await postWebhook(unknownEvent());
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: string }).result).toBe('ignored');
    expect(store.stripeWebhookEvents).toHaveLength(1);
    expect(store.stripeWebhookEvents[0].result).toBe('ignored');
    expect(store.stripeWebhookEvents[0].processedAt).toBeInstanceOf(Date);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

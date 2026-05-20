// Route tests for POST /v1/pricing/evaluate.
// Uses the same in-memory fake DB pattern as pricing-route.test.ts.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Types ----------

type Row = Record<string, unknown>;

interface Store {
  licenseTiers: Row[];
  pricingRules: Row[];
  pricingRuleTargets: Row[];
  events: Row[];
}

const newStore = (): Store => ({
  licenseTiers: [],
  pricingRules: [],
  pricingRuleTargets: [],
  events: [],
});

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const catalogTables = {
    licenseTiers: tableMarker('licenseTiers'),
    pricingRules: tableMarker('pricingRules'),
    pricingRuleTargets: tableMarker('pricingRuleTargets'),
    products: tableMarker('licenseTiers'),
    bundles: tableMarker('licenseTiers'),
    bundleItems: tableMarker('licenseTiers'),
  };
  const eventsTables = {
    events: tableMarker('events'),
    eventMembers: tableMarker('events'),
    eventSettings: tableMarker('events'),
    eventFtpCredentials: tableMarker('events'),
    eventRosterEntries: tableMarker('events'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      catalog: { tables: catalogTables },
      commerce: { tables: {} },
      photos: { tables: {} },
      events: { tables: eventsTables },
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
  const inArray = (field: unknown, values: unknown[]) => (row: Row) =>
    values.includes(valueOf(field, row));
  const desc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column] as number;
    const bv = b[field.column] as number;
    return av > bv ? -1 : av < bv ? 1 : 0;
  };
  const asc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column] as number;
    const bv = b[field.column] as number;
    return av < bv ? -1 : av > bv ? 1 : 0;
  };
  const sqlTag = ((_strings: TemplateStringsArray) => ({ __sql: '' })) as unknown as Record<
    string,
    unknown
  >;
  return { eq, and, inArray, desc, asc, sql: sqlTag };
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
      // drizzle .orderBy accepts comparator functions (e.g. desc(col)) or a
      // raw column Field for ascending order (e.g. orderBy(table.col)).
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

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
  };
};

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const ruleTbl = schema.catalog.tables.pricingRules as Record<string, unknown>;
  const targetTbl = schema.catalog.tables.pricingRuleTargets as Record<string, unknown>;
  const tierTbl = schema.catalog.tables.licenseTiers as Record<string, unknown>;
  const eventTbl = schema.events.tables.events as Record<string, unknown>;

  for (const col of ['id', 'code', 'name', 'description', 'sortOrder', 'createdAt']) {
    tierTbl[col] = { column: col };
  }
  for (const col of [
    'id',
    'scope',
    'kind',
    'params',
    'priority',
    'startsAt',
    'endsAt',
    'active',
    'createdAt',
  ]) {
    ruleTbl[col] = { column: col };
  }
  for (const col of ['ruleId', 'targetType', 'targetId']) {
    targetTbl[col] = { column: col };
  }
  for (const col of ['id', 'eventDate', 'orgId', 'name', 'slug', 'status', 'currency']) {
    eventTbl[col] = { column: col };
  }
};

// ---------- Constants ----------

const RULE_ID = '00000000-0000-4000-8000-000000000010';

// ---------- Lifecycle ----------

let app: FastifyInstance;
let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = newStore();
  await installFieldShims();
  db = makeFakeDb();

  const { default: pricingRoutes } = await import('../src/routes/pricing.js');
  app = Fastify({ logger: false });
  await app.register(async (instance) => {
    await pricingRoutes(instance, { db: db as never });
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});

// ---------- Tests ----------

describe('POST /v1/pricing/evaluate', () => {
  it('returns 200 with subtotal, discounts, total, currency for valid request (no rules)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [{ unitPriceCents: 2000, quantity: 2 }],
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subtotalCents: number;
      discounts: unknown[];
      totalCents: number;
      currency: string;
    };
    expect(body.subtotalCents).toBe(4000);
    expect(body.discounts).toHaveLength(0);
    expect(body.totalCents).toBe(4000);
    expect(body.currency).toBe('USD');
  });

  it('applies a matching time_window rule and returns breakdown', async () => {
    store.pricingRules.push({
      id: RULE_ID,
      scope: 'global',
      kind: 'time_window',
      params: { pct: 10 },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [{ unitPriceCents: 1000, quantity: 1 }],
        currency: 'USD',
        context: {
          now: new Date('2024-06-15T12:00:00Z').toISOString(),
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subtotalCents: number;
      discounts: Array<{ ruleId: string; label: string; amountCents: number }>;
      totalCents: number;
    };
    expect(body.subtotalCents).toBe(1000);
    expect(body.discounts).toHaveLength(1);
    const [d] = body.discounts;
    expect(d?.ruleId).toBe(RULE_ID);
    expect(d?.amountCents).toBe(100);
    expect(d?.label).toBe('discount_time_window_10pct');
    expect(body.totalCents).toBe(900);
  });

  it('returns 400 with error:invalid_request when items is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [],
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when body is missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: { currency: 'USD' }, // missing items
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 when unitPriceCents is negative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [{ unitPriceCents: -1, quantity: 1 }],
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when quantity is zero', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [{ unitPriceCents: 100, quantity: 0 }],
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts optional context.eventId as UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [{ unitPriceCents: 500, quantity: 1 }],
        currency: 'USD',
        context: {
          eventId: '00000000-0000-4000-8000-0000000000aa',
        },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 when context.eventId is not a valid UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [{ unitPriceCents: 500, quantity: 1 }],
        currency: 'USD',
        context: { eventId: 'not-a-uuid' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('existing GET /v1/pricing/tiers is still reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/pricing/tiers' });
    // No tier rows seeded so returns 200 with empty array.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tiers: unknown[] };
    expect(Array.isArray(body.tiers)).toBe(true);
  });

  it('multi-item cart: subtotal is sum of all line totals', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pricing/evaluate',
      payload: {
        items: [
          { unitPriceCents: 500, quantity: 2 },
          { unitPriceCents: 750, quantity: 3 },
        ],
        currency: 'EUR',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { subtotalCents: number; currency: string };
    expect(body.subtotalCents).toBe(3250); // 500*2 + 750*3
    expect(body.currency).toBe('EUR');
  });
});

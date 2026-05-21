// F2.13 — me-payouts route tests.
//
// Uses Fastify inject. Auth is simulated by reading the 'x-test-user' JSON
// header in an onRequest hook (same pattern as audit.test.ts buildTestApp).
// The service layer is exercised via a fake db injected into the plugin opts.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory store types (mirror payout-dashboard.test.ts) ----------

type Row = Record<string, unknown>;

interface Store {
  ledgerAccounts: Row[];
  ledgerEntries: Row[];
  payoutAccounts: Row[];
  payouts: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
};

// ---------- Module mocks ----------

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    payouts: {
      tables: {
        ledgerAccounts: tableMarker('ledgerAccounts'),
        ledgerEntries: tableMarker('ledgerEntries'),
        payoutAccounts: tableMarker('payoutAccounts'),
        payouts: tableMarker('payouts'),
      },
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
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const or =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.some((p) => p(row));
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  const desc = (field: unknown) => ({ field, direction: 'desc' as const });
  return { eq, and, or, inArray, desc };
});

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  const t = schema.payouts.tables as Record<string, Record<string, unknown>>;
  tag(t.ledgerAccounts, ['id', 'kind', 'photographerId', 'createdAt']);
  tag(t.ledgerEntries, [
    'id',
    'accountId',
    'orderId',
    'refundId',
    'payoutId',
    'direction',
    'amountCents',
    'currency',
    'kind',
    'memo',
    'createdAt',
  ]);
  tag(t.payoutAccounts, [
    'id',
    'photographerId',
    'stripeAccountId',
    'currency',
    'status',
    'createdAt',
    'updatedAt',
  ]);
  tag(t.payouts, [
    'id',
    'payoutAccountId',
    'periodStart',
    'periodEnd',
    'grossCents',
    'feesCents',
    'netCents',
    'currency',
    'stripeTransferId',
    'status',
    'createdAt',
    'sentAt',
    'paidAt',
  ]);
};

// ---------- Fake DB ----------

let store: Store;

const newStore = (): Store => ({
  ledgerAccounts: [],
  ledgerEntries: [],
  payoutAccounts: [],
  payouts: [],
});

type OrderBySpec = { field: { column?: string }; direction: 'desc' | 'asc' };

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    let orderBySpec: OrderBySpec | null = null;

    const exec = (): Row[] => {
      if (!bucket) return [];
      let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
      if (orderBySpec) {
        const col = orderBySpec.field.column;
        if (col) {
          rows = [...rows].sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av instanceof Date && bv instanceof Date) {
              return orderBySpec!.direction === 'desc'
                ? bv.getTime() - av.getTime()
                : av.getTime() - bv.getTime();
            }
            return 0;
          });
        }
      }
      if (limitN !== undefined) rows = rows.slice(0, limitN);
      if (selection) {
        rows = rows.map((r) => {
          const p: Row = {};
          for (const [alias, ref] of Object.entries(selection)) p[alias] = r[ref.column];
          return p;
        });
      }
      return rows.map((r) => ({ ...r }));
    };

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      orderBy(spec: OrderBySpec) {
        orderBySpec = spec;
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

  return { select: (s?: Record<string, { column: string }>) => selectBuilder(s) };
};

// ---------- Seed helpers ----------

const seedPayoutAccount = (photographerId: string, currency = 'usd'): string => {
  const id = fakeUuid();
  store.payoutAccounts.push({
    id,
    photographerId,
    currency,
    stripeAccountId: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
};

const seedLedgerAccount = (kind: string, photographerId?: string): string => {
  const id = fakeUuid();
  store.ledgerAccounts.push({
    id,
    kind,
    photographerId: photographerId ?? null,
    createdAt: new Date(),
  });
  return id;
};

const seedLedgerEntry = (opts: {
  accountId: string;
  direction: 'credit' | 'debit';
  amountCents: number;
  kind: string;
  payoutId?: string;
}): void => {
  store.ledgerEntries.push({
    id: fakeUuid(),
    accountId: opts.accountId,
    direction: opts.direction,
    amountCents: opts.amountCents,
    currency: 'usd',
    kind: opts.kind,
    payoutId: opts.payoutId ?? null,
    memo: '',
    createdAt: new Date(),
    orderId: null,
    refundId: null,
  });
};

const seedPayout = (opts: {
  payoutAccountId: string;
  status: string;
  netCents: number;
  stripeTransferId?: string;
}): string => {
  const id = fakeUuid();
  store.payouts.push({
    id,
    payoutAccountId: opts.payoutAccountId,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-07',
    grossCents: opts.netCents + 100,
    feesCents: 100,
    netCents: opts.netCents,
    currency: 'usd',
    stripeTransferId: opts.stripeTransferId ?? null,
    status: opts.status,
    createdAt: new Date(),
    sentAt: null,
    paidAt: null,
  });
  return id;
};

// ---------- Test app builder ----------

interface FakeUser {
  id: string;
  role: string;
}

const buildApp = async (
  db: ReturnType<typeof makeFakeDb>,
  userId?: string,
): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  // Simulate auth plugin: decorate request.user, then set it from header.
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string' && raw.length > 0) {
      (req as unknown as { user: FakeUser }).user = JSON.parse(raw) as FakeUser;
    } else if (userId) {
      (req as unknown as { user: FakeUser }).user = { id: userId, role: 'photographer' };
    }
  });

  const { default: mePayoutsRoutes } = await import('../src/routes/me-payouts.js');
  await app.register(mePayoutsRoutes, { db: db as never });
  return app;
};

// ---------- Lifecycle ----------

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
});

afterEach(() => {
  vi.clearAllMocks();
});

const PH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ---------- GET /v1/me/payouts/balance ----------

describe('GET /v1/me/payouts/balance', () => {
  it('returns 200 with zero balance for a photographer with no data', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db, PH_ID);

    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts/balance' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      availableCents: number;
      pendingCents: number;
      nextPayoutEstimateCents: number;
      nextPayoutDate: string;
      currency: string;
    }>();
    expect(body.availableCents).toBe(0);
    expect(body.pendingCents).toBe(0);
    expect(body.nextPayoutEstimateCents).toBe(0);
    expect(body.currency).toBe('usd');
    expect(typeof body.nextPayoutDate).toBe('string');
    await app.close();
  });

  it('returns 200 with correct balance when ledger has entries', async () => {
    const db = makeFakeDb();
    const payoutAccountId = seedPayoutAccount(PH_ID);
    const accountId = seedLedgerAccount('photographer', PH_ID);
    seedLedgerEntry({ accountId, direction: 'credit', amountCents: 5000, kind: 'sale' });
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 500, kind: 'platform_fee' });
    store.payouts.push({
      id: fakeUuid(),
      payoutAccountId,
      status: 'pending',
      netCents: 2000,
      grossCents: 2100,
      feesCents: 100,
      currency: 'usd',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-07',
      stripeTransferId: null,
      createdAt: new Date(),
      sentAt: null,
      paidAt: null,
    });

    const app = await buildApp(db, PH_ID);
    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts/balance' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ availableCents: number; pendingCents: number }>();
    expect(body.availableCents).toBe(4500); // 5000 - 500
    expect(body.pendingCents).toBe(2000);
    await app.close();
  });

  it('returns 401 when not authenticated', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db); // no userId, no header

    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts/balance' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ---------- GET /v1/me/payouts ----------

describe('GET /v1/me/payouts', () => {
  it('returns 200 with items and null nextCursor when no payouts', async () => {
    const db = makeFakeDb();
    seedPayoutAccount(PH_ID);
    const app = await buildApp(db, PH_ID);

    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; nextCursor: null }>();
    expect(body.items).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
    await app.close();
  });

  it('returns 200 with payouts list', async () => {
    const db = makeFakeDb();
    const payoutAccountId = seedPayoutAccount(PH_ID);
    seedPayout({ payoutAccountId, status: 'paid', netCents: 1000 });
    seedPayout({ payoutAccountId, status: 'pending', netCents: 2000 });
    const app = await buildApp(db, PH_ID);

    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ netCents: number }>; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    await app.close();
  });

  it('returns 401 when not authenticated', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db);

    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ---------- GET /v1/me/payouts/:id ----------

describe('GET /v1/me/payouts/:id', () => {
  it('returns 200 with payout detail and entriesByKind', async () => {
    const db = makeFakeDb();
    const payoutAccountId = seedPayoutAccount(PH_ID);
    const accountId = seedLedgerAccount('photographer', PH_ID);
    const payoutId = seedPayout({
      payoutAccountId,
      status: 'paid',
      netCents: 800,
      stripeTransferId: 'tr_test',
    });
    seedLedgerEntry({ accountId, direction: 'credit', amountCents: 800, kind: 'sale', payoutId });

    const app = await buildApp(db, PH_ID);
    const res = await app.inject({ method: 'GET', url: `/v1/me/payouts/${payoutId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      payout: { id: string; status: string; stripeReceiptUrl?: string };
      entriesByKind: Record<string, unknown[]>;
    }>();
    expect(body.payout.id).toBe(payoutId);
    expect(body.payout.status).toBe('paid');
    expect(body.payout.stripeReceiptUrl).toBe('https://dashboard.stripe.com/transfers/tr_test');
    expect(body.entriesByKind.sale).toHaveLength(1);
    await app.close();
  });

  it('returns 404 for a payout owned by a different photographer (anti-enumeration)', async () => {
    const db = makeFakeDb();
    const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const otherPayoutAccountId = seedPayoutAccount(OTHER_ID);
    const payoutId = seedPayout({
      payoutAccountId: otherPayoutAccountId,
      status: 'paid',
      netCents: 500,
    });
    // caller is PH_ID who owns no payout account
    const app = await buildApp(db, PH_ID);

    const res = await app.inject({ method: 'GET', url: `/v1/me/payouts/${payoutId}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for a non-existent payout id', async () => {
    const db = makeFakeDb();
    seedPayoutAccount(PH_ID);
    const app = await buildApp(db, PH_ID);

    const nonExistentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const res = await app.inject({ method: 'GET', url: `/v1/me/payouts/${nonExistentId}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for an invalid (non-uuid) payout id', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db, PH_ID);

    const res = await app.inject({ method: 'GET', url: '/v1/me/payouts/not-a-uuid' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 401 when not authenticated', async () => {
    const db = makeFakeDb();
    const app = await buildApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/payouts/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

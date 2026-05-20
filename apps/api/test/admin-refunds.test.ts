// F2.7 — admin refund decision unit tests. Captures the reversal batch handed
// to postLedgerBatch and asserts it balances cents-exactly. Stripe, email, and
// audit are mocked; allocateProportional runs for real.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  orders: Row[];
  refundRequests: Row[];
  ledgerEntries: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

const hoisted = vi.hoisted(() => ({
  postLedgerBatchMock: vi.fn(async () => undefined),
  stripeRefundCreate: vi.fn(async () => ({ id: 're_test_1' })),
  sendMailMock: vi.fn(async () => undefined),
}));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    commerce: {
      tables: { orders: tableMarker('orders'), refundRequests: tableMarker('refundRequests') },
    },
    payouts: { tables: { ledgerEntries: tableMarker('ledgerEntries') } },
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
  const isNull = (a: unknown) => (row: Row) => valueOf(a, row) == null;
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  return { eq, and, isNull, inArray };
});

vi.mock('../src/lib/stripe.js', () => ({
  stripe: { refunds: { create: hoisted.stripeRefundCreate } },
  webhookSecret: 'whsec_dummy',
}));

vi.mock('../src/lib/email.js', () => ({ sendMail: hoisted.sendMailMock }));

vi.mock('../src/lib/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

// Keep allocateProportional real; stub the account resolver + capture the batch.
vi.mock('../src/services/ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ledger.js')>();
  return {
    ...actual,
    getPlatformAccountId: vi.fn(async (_db: unknown, kind: string) => `platform:${kind}`),
    postLedgerBatch: hoisted.postLedgerBatchMock,
  };
});

let store: Store;
let uuidCounter = 0;
const fakeUuid = () => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
};

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    const exec = (): Row[] => {
      if (!bucket) return [];
      let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
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

  const updateBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let patch: Row = {};
    const api = {
      set(values: Row) {
        patch = values;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        for (const row of store[bucket]) {
          if (pred(row)) Object.assign(row, patch);
        }
        return Promise.resolve(undefined);
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let pending: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        pending = Array.isArray(payload) ? payload : [payload];
        return api;
      },
      then(resolve: (v: unknown) => unknown) {
        for (const row of pending) store[bucket].push({ id: fakeUuid(), ...row });
        return resolve(undefined);
      },
    };
    return api;
  };

  return {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    update: (t: Row) => updateBuilder(t),
    insert: (t: Row) => insertBuilder(t),
  };
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.commerce.tables.orders as Record<string, unknown>, [
    'id',
    'buyerEmail',
    'buyerUserId',
    'totalCents',
    'refundedCents',
    'currency',
    'stripeChargeId',
    'status',
  ]);
  tag(schema.commerce.tables.refundRequests as Record<string, unknown>, [
    'id',
    'orderId',
    'buyerId',
    'status',
    'refundAttempts',
    'stripeRefundId',
    'approvedAmountCents',
    'adminNote',
  ]);
  tag(schema.payouts.tables.ledgerEntries as Record<string, unknown>, [
    'id',
    'accountId',
    'orderId',
    'refundId',
    'direction',
    'amountCents',
    'currency',
    'kind',
    'memo',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

const newStore = (): Store => ({ orders: [], refundRequests: [], ledgerEntries: [] });

const sum = (arr: Array<{ amountCents: number }>) => arr.reduce((s, e) => s + e.amountCents, 0);

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  hoisted.postLedgerBatchMock.mockClear();
  hoisted.stripeRefundCreate.mockClear();
  hoisted.stripeRefundCreate.mockResolvedValue({ id: 're_test_1' });
  hoisted.sendMailMock.mockClear();
  await installFieldShims();
  db = makeFakeDb();
});

// Seed a paid order plus its sale CREDIT ledger entries (stripe_fee + platform
// + photographer) summing to gross, mirroring what the splitter posts.
const seedPaidOrderWithSale = (gross: number): void => {
  store.orders.push({
    id: 'o1',
    buyerEmail: 'buyer@example.com',
    buyerUserId: 'u1',
    totalCents: gross,
    refundedCents: 0,
    currency: 'eur',
    stripeChargeId: 'ch_1',
    status: 'paid',
  });
  store.refundRequests.push({
    id: 'rr1',
    orderId: 'o1',
    buyerId: 'u1',
    status: 'pending',
    refundAttempts: 0,
    stripeRefundId: null,
    approvedAmountCents: null,
    adminNote: null,
  });
  // credit-side sale entries summing to gross (S=320, P=1000, A=8680 for 10000).
  const S = 320;
  const P = 1000;
  const photog = gross - S - P;
  store.ledgerEntries.push(
    {
      id: 'le1',
      accountId: 'platform:stripe_fee',
      orderId: 'o1',
      refundId: null,
      direction: 'credit',
      amountCents: S,
      currency: 'eur',
      kind: 'stripe_fee',
    },
    {
      id: 'le2',
      accountId: 'platform:platform_revenue',
      orderId: 'o1',
      refundId: null,
      direction: 'credit',
      amountCents: P,
      currency: 'eur',
      kind: 'platform_fee',
    },
    {
      id: 'le3',
      accountId: 'photog:A',
      orderId: 'o1',
      refundId: null,
      direction: 'credit',
      amountCents: photog,
      currency: 'eur',
      kind: 'sale',
    },
    {
      id: 'le0',
      accountId: 'platform:platform_cash',
      orderId: 'o1',
      refundId: null,
      direction: 'debit',
      amountCents: gross,
      currency: 'eur',
      kind: 'sale',
    },
  );
};

describe('decideRefund — approve', () => {
  it('full refund: Stripe called, status processed, balanced reversal summing to R', async () => {
    const { decideRefund } = await import('../src/services/admin-refunds.js');
    seedPaidOrderWithSale(10_000);

    const result = await decideRefund(
      db as never,
      'rr1',
      { decision: 'approve' },
      { adminUserId: 'admin' },
    );

    expect(hoisted.stripeRefundCreate).toHaveBeenCalledTimes(1);
    const stripeArgs = hoisted.stripeRefundCreate.mock.calls[0];
    expect((stripeArgs?.[1] as { idempotencyKey: string }).idempotencyKey).toBe('refund:rr1:1');
    expect(result.status).toBe('processed');
    expect(result.refundedCents).toBe(10_000);

    const order = store.orders[0] as { status: string; refundedCents: number };
    expect(order.status).toBe('refunded');
    expect(order.refundedCents).toBe(10_000);

    // Reversal batch balances and the debits sum to R.
    const batch = hoisted.postLedgerBatchMock.mock.calls[0]?.[1] as Array<{
      direction: string;
      amountCents: number;
      refundId?: string;
    }>;
    const debits = batch.filter((e) => e.direction === 'debit');
    const credits = batch.filter((e) => e.direction === 'credit');
    expect(sum(debits)).toBe(10_000);
    expect(sum(credits)).toBe(10_000);
    expect(batch.every((e) => e.refundId === 'rr1')).toBe(true);
  });

  it('partial refund: status partially_refunded, reversal sums to the partial amount', async () => {
    const { decideRefund } = await import('../src/services/admin-refunds.js');
    seedPaidOrderWithSale(10_000);

    const result = await decideRefund(
      db as never,
      'rr1',
      { decision: 'approve', amountCents: 3000 },
      { adminUserId: 'admin' },
    );

    expect(result.refundedCents).toBe(3000);
    expect((store.orders[0] as { status: string }).status).toBe('partially_refunded');

    const batch = hoisted.postLedgerBatchMock.mock.calls[0]?.[1] as Array<{
      direction: string;
      amountCents: number;
    }>;
    expect(sum(batch.filter((e) => e.direction === 'debit'))).toBe(3000);
    expect(sum(batch.filter((e) => e.direction === 'credit'))).toBe(3000);
  });

  it('rejects an amount over the remaining refundable balance', async () => {
    const { decideRefund, AdminRefundError } = await import('../src/services/admin-refunds.js');
    seedPaidOrderWithSale(10_000);
    await expect(
      decideRefund(
        db as never,
        'rr1',
        { decision: 'approve', amountCents: 20_000 },
        { adminUserId: 'a' },
      ),
    ).rejects.toBeInstanceOf(AdminRefundError);
    expect(hoisted.stripeRefundCreate).not.toHaveBeenCalled();
  });
});

describe('decideRefund — deny', () => {
  it('marks denied, emails the buyer, calls no Stripe', async () => {
    const { decideRefund } = await import('../src/services/admin-refunds.js');
    seedPaidOrderWithSale(10_000);

    const result = await decideRefund(
      db as never,
      'rr1',
      { decision: 'deny', adminNote: 'out of policy' },
      { adminUserId: 'admin' },
    );

    expect(result.status).toBe('denied');
    expect(hoisted.stripeRefundCreate).not.toHaveBeenCalled();
    expect(hoisted.sendMailMock).toHaveBeenCalledTimes(1);
    expect((store.refundRequests[0] as { adminNote: string }).adminNote).toBe('out of policy');
  });
});

describe('decideRefund — guards', () => {
  it('404s an unknown refund request', async () => {
    const { decideRefund, AdminRefundError } = await import('../src/services/admin-refunds.js');
    await expect(
      decideRefund(db as never, 'missing', { decision: 'approve' }, { adminUserId: 'a' }),
    ).rejects.toBeInstanceOf(AdminRefundError);
  });

  it('rejects re-deciding an already-processed request', async () => {
    const { decideRefund, AdminRefundError } = await import('../src/services/admin-refunds.js');
    seedPaidOrderWithSale(10_000);
    (store.refundRequests[0] as { status: string }).status = 'processed';
    await expect(
      decideRefund(db as never, 'rr1', { decision: 'approve' }, { adminUserId: 'a' }),
    ).rejects.toBeInstanceOf(AdminRefundError);
  });
});

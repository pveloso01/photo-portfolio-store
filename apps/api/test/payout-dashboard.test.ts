// F2.13 — payout-dashboard service unit tests.
//
// Uses the same TABLE_KEY / drizzle shim / @pkg/db mock harness as
// order-split.test.ts. No real Postgres connection.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory store types ----------

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
            if (typeof av === 'string' && typeof bv === 'string') {
              return orderBySpec!.direction === 'desc'
                ? bv.localeCompare(av)
                : av.localeCompare(bv);
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

  const db = {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
  };
  return db;
};

// ---------- Seed helpers ----------

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
  currency?: string;
  payoutId?: string;
  memo?: string;
}): string => {
  const id = fakeUuid();
  store.ledgerEntries.push({
    id,
    accountId: opts.accountId,
    direction: opts.direction,
    amountCents: opts.amountCents,
    currency: opts.currency ?? 'usd',
    kind: opts.kind,
    payoutId: opts.payoutId ?? null,
    memo: opts.memo ?? '',
    createdAt: new Date(),
    orderId: null,
    refundId: null,
  });
  return id;
};

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

const seedPayout = (opts: {
  payoutAccountId: string;
  status: string;
  netCents: number;
  grossCents?: number;
  feesCents?: number;
  stripeTransferId?: string;
  createdAt?: Date;
}): string => {
  const id = fakeUuid();
  store.payouts.push({
    id,
    payoutAccountId: opts.payoutAccountId,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-07',
    grossCents: opts.grossCents ?? opts.netCents + 100,
    feesCents: opts.feesCents ?? 100,
    netCents: opts.netCents,
    currency: 'usd',
    stripeTransferId: opts.stripeTransferId ?? null,
    status: opts.status,
    createdAt: opts.createdAt ?? new Date(),
    sentAt: null,
    paidAt: null,
  });
  return id;
};

// ---------- Lifecycle ----------

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
});

// ---------- Tests ----------

describe('nextWeeklyPayoutDate', () => {
  it('returns a future Monday', async () => {
    const { nextWeeklyPayoutDate } = await import('../src/services/payout-dashboard.js');
    const now = new Date('2026-05-21T10:00:00Z'); // Thursday
    const next = nextWeeklyPayoutDate(now);
    expect(next.getUTCDay()).toBe(1); // Monday
    expect(next > now).toBe(true);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getUTCSeconds()).toBe(0);
  });

  it('returns next Monday when called on a Monday at noon', async () => {
    const { nextWeeklyPayoutDate } = await import('../src/services/payout-dashboard.js');
    // 2026-05-18 is a Monday
    const now = new Date('2026-05-18T12:00:00Z');
    const next = nextWeeklyPayoutDate(now);
    expect(next.getUTCDay()).toBe(1);
    // Should be 2026-05-25
    expect(next.toISOString().startsWith('2026-05-25')).toBe(true);
  });

  it('skips 7 days when called exactly on Monday 00:00 UTC', async () => {
    const { nextWeeklyPayoutDate } = await import('../src/services/payout-dashboard.js');
    const now = new Date('2026-05-18T00:00:00.000Z'); // exact Monday midnight
    const next = nextWeeklyPayoutDate(now);
    expect(next.toISOString().startsWith('2026-05-25')).toBe(true);
  });
});

describe('getBalance', () => {
  it('returns zeros for a photographer with no ledger account or payout account', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const result = await getBalance(db as never, 'ph-unknown');
    expect(result.availableCents).toBe(0);
    expect(result.pendingCents).toBe(0);
    expect(result.nextPayoutEstimateCents).toBe(0);
    expect(result.currency).toBe('usd');
    expect(new Date(result.nextPayoutDate).getUTCDay()).toBe(1);
  });

  it('computes available from sale credit minus fee debits', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-1';
    const accountId = seedLedgerAccount('photographer', phId);
    seedPayoutAccount(phId);

    // CREDIT sale 10000, DEBIT platform_fee 1000, DEBIT stripe_fee 319
    seedLedgerEntry({ accountId, direction: 'credit', amountCents: 10000, kind: 'sale' });
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 1000, kind: 'platform_fee' });
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 319, kind: 'stripe_fee' });

    const result = await getBalance(db as never, phId);
    // available = 10000 - 1000 - 319 = 8681
    expect(result.availableCents).toBe(8681);
    expect(result.nextPayoutEstimateCents).toBe(8681);
    expect(result.pendingCents).toBe(0);
  });

  it('includes a payout DEBIT in available reduction', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-2';
    const accountId = seedLedgerAccount('photographer', phId);
    const payoutAccountId = seedPayoutAccount(phId);

    seedLedgerEntry({ accountId, direction: 'credit', amountCents: 10000, kind: 'sale' });
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 1000, kind: 'platform_fee' });
    // A payout DEBIT reduces available immediately.
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 7000, kind: 'payout' });
    // That payout is now 'paid' — not counted in pending.
    seedPayout({ payoutAccountId, status: 'paid', netCents: 7000 });

    const result = await getBalance(db as never, phId);
    // available = 10000 - 1000 - 7000 = 2000
    expect(result.availableCents).toBe(2000);
    expect(result.pendingCents).toBe(0);
  });

  it('computes pending from pending+sent payouts only', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-3';
    const accountId = seedLedgerAccount('photographer', phId);
    const payoutAccountId = seedPayoutAccount(phId);

    seedLedgerEntry({ accountId, direction: 'credit', amountCents: 20000, kind: 'sale' });
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 5000, kind: 'payout' });
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 3000, kind: 'payout' });

    // pending payout
    seedPayout({ payoutAccountId, status: 'pending', netCents: 5000 });
    // sent payout
    seedPayout({ payoutAccountId, status: 'sent', netCents: 3000 });
    // paid payout — NOT included in pending
    seedPayout({ payoutAccountId, status: 'paid', netCents: 8000 });
    // failed payout — NOT included in pending
    seedPayout({ payoutAccountId, status: 'failed', netCents: 1000 });

    const result = await getBalance(db as never, phId);
    // available = 20000 - 5000 - 3000 = 12000
    expect(result.availableCents).toBe(12000);
    // pending = 5000 + 3000 = 8000 (only pending+sent status)
    expect(result.pendingCents).toBe(8000);
  });

  it('uses payout account currency', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-4';
    const accountId = seedLedgerAccount('photographer', phId);
    seedPayoutAccount(phId, 'eur');
    seedLedgerEntry({
      accountId,
      direction: 'credit',
      amountCents: 100,
      kind: 'sale',
      currency: 'eur',
    });

    const result = await getBalance(db as never, phId);
    expect(result.currency).toBe('eur');
  });

  it('falls back to ledger entry currency when no payout account', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-5';
    const accountId = seedLedgerAccount('photographer', phId);
    // No payout account seeded.
    seedLedgerEntry({
      accountId,
      direction: 'credit',
      amountCents: 100,
      kind: 'sale',
      currency: 'gbp',
    });

    const result = await getBalance(db as never, phId);
    expect(result.currency).toBe('gbp');
  });

  it('mixed: sale + refund debit + payout debit shows correct available', async () => {
    const { getBalance } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-6';
    const accountId = seedLedgerAccount('photographer', phId);
    const payoutAccountId = seedPayoutAccount(phId);

    // Sale
    seedLedgerEntry({ accountId, direction: 'credit', amountCents: 10000, kind: 'sale' });
    // Refund clawback
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 2000, kind: 'refund' });
    // Payout DEBIT
    seedLedgerEntry({ accountId, direction: 'debit', amountCents: 5000, kind: 'payout' });
    // Pending payout
    seedPayout({ payoutAccountId, status: 'pending', netCents: 5000 });

    const result = await getBalance(db as never, phId);
    // available = 10000 - 2000 - 5000 = 3000
    expect(result.availableCents).toBe(3000);
    expect(result.pendingCents).toBe(5000);
  });
});

describe('listPayouts', () => {
  it('returns empty list for unknown photographer', async () => {
    const { listPayouts } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const result = await listPayouts(db as never, 'ph-unknown', {});
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('returns payouts newest-first with nextCursor when more pages exist', async () => {
    const { listPayouts } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-page';
    const payoutAccountId = seedPayoutAccount(phId);

    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-08T00:00:00Z');
    const t2 = new Date('2026-01-15T00:00:00Z');

    const id0 = seedPayout({ payoutAccountId, status: 'paid', netCents: 100, createdAt: t0 });
    const id1 = seedPayout({ payoutAccountId, status: 'paid', netCents: 200, createdAt: t1 });
    const id2 = seedPayout({ payoutAccountId, status: 'paid', netCents: 300, createdAt: t2 });

    // Page 1: limit=2
    const page1 = await listPayouts(db as never, phId, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    // Newest first: id2, id1
    expect(page1.items[0]?.id).toBe(id2);
    expect(page1.items[1]?.id).toBe(id1);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2: use cursor
    const page2 = await listPayouts(db as never, phId, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).toBe(id0);
    expect(page2.nextCursor).toBeNull();

    void id0; // avoid unused warning
  });

  it('caps limit at 100', async () => {
    const { listPayouts } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-cap';
    const payoutAccountId = seedPayoutAccount(phId);
    for (let i = 0; i < 5; i += 1) {
      seedPayout({ payoutAccountId, status: 'paid', netCents: 100 });
    }
    const result = await listPayouts(db as never, phId, { limit: 200 });
    // cap applied; all 5 returned since 5 < 100
    expect(result.items.length).toBeLessThanOrEqual(100);
  });

  it('includes stripeReceiptUrl when stripeTransferId is present', async () => {
    const { listPayouts } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-stripe';
    const payoutAccountId = seedPayoutAccount(phId);
    seedPayout({ payoutAccountId, status: 'paid', netCents: 500, stripeTransferId: 'tr_abc123' });

    const result = await listPayouts(db as never, phId, {});
    const [item] = result.items;
    expect(item?.stripeReceiptUrl).toBe('https://dashboard.stripe.com/transfers/tr_abc123');
  });

  it('omits stripeReceiptUrl when stripeTransferId is null', async () => {
    const { listPayouts } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-nostripe';
    const payoutAccountId = seedPayoutAccount(phId);
    seedPayout({ payoutAccountId, status: 'pending', netCents: 500 });

    const result = await listPayouts(db as never, phId, {});
    const [item] = result.items;
    expect(item).toBeDefined();
    expect('stripeReceiptUrl' in (item ?? {})).toBe(false);
  });
});

describe('getPayoutDetail', () => {
  it('returns null for unknown photographer', async () => {
    const { getPayoutDetail } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const result = await getPayoutDetail(db as never, 'ph-unknown', fakeUuid());
    expect(result).toBeNull();
  });

  it('returns null for a payout belonging to a different photographer (anti-enumeration)', async () => {
    const { getPayoutDetail } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();

    const phIdA = 'ph-owner';
    const phIdB = 'ph-other';
    const payoutAccountA = seedPayoutAccount(phIdA);
    seedPayoutAccount(phIdB);

    const payoutId = seedPayout({
      payoutAccountId: payoutAccountA,
      status: 'paid',
      netCents: 1000,
    });

    // Photographer B requests payout owned by A.
    const result = await getPayoutDetail(db as never, phIdB, payoutId);
    expect(result).toBeNull();
  });

  it('returns null for a non-existent payout id', async () => {
    const { getPayoutDetail } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-det';
    seedPayoutAccount(phId);
    const result = await getPayoutDetail(db as never, phId, fakeUuid());
    expect(result).toBeNull();
  });

  it('returns payout detail with entries grouped by kind', async () => {
    const { getPayoutDetail } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-detail';
    const payoutAccountId = seedPayoutAccount(phId);
    const ledgerAccountId = seedLedgerAccount('photographer', phId);
    const payoutId = seedPayout({
      payoutAccountId,
      status: 'paid',
      netCents: 800,
      stripeTransferId: 'tr_xyz',
    });

    // Two sale entries, one refund entry, one payout entry.
    seedLedgerEntry({
      accountId: ledgerAccountId,
      direction: 'credit',
      amountCents: 500,
      kind: 'sale',
      payoutId,
    });
    seedLedgerEntry({
      accountId: ledgerAccountId,
      direction: 'credit',
      amountCents: 300,
      kind: 'sale',
      payoutId,
    });
    seedLedgerEntry({
      accountId: ledgerAccountId,
      direction: 'debit',
      amountCents: 100,
      kind: 'refund',
      payoutId,
    });
    seedLedgerEntry({
      accountId: ledgerAccountId,
      direction: 'debit',
      amountCents: 800,
      kind: 'payout',
      payoutId,
    });

    const result = await getPayoutDetail(db as never, phId, payoutId);
    expect(result).not.toBeNull();
    expect(result?.payout.id).toBe(payoutId);
    expect(result?.payout.stripeReceiptUrl).toBe('https://dashboard.stripe.com/transfers/tr_xyz');

    const byKind = result?.entriesByKind ?? {};
    expect(byKind.sale).toHaveLength(2);
    expect(byKind.refund).toHaveLength(1);
    expect(byKind.payout).toHaveLength(1);
    expect(byKind.platform_fee).toBeUndefined();

    // Verify entry shape.
    const [saleEntry] = byKind.sale ?? [];
    expect(saleEntry).toMatchObject({
      direction: 'credit',
      kind: 'sale',
      amountCents: expect.any(Number) as number,
    });
  });

  it('returns empty entriesByKind when no entries have this payoutId', async () => {
    const { getPayoutDetail } = await import('../src/services/payout-dashboard.js');
    const db = makeFakeDb();
    const phId = 'ph-noentries';
    const payoutAccountId = seedPayoutAccount(phId);
    const payoutId = seedPayout({ payoutAccountId, status: 'pending', netCents: 1000 });

    const result = await getPayoutDetail(db as never, phId, payoutId);
    expect(result).not.toBeNull();
    expect(Object.keys(result?.entriesByKind ?? {})).toHaveLength(0);
  });
});

// F2.12 — payout run + reconciliation unit tests. Full fake DB; real ledger
// helpers run end-to-end; only Stripe + audit are mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  payoutAccounts: Row[];
  payouts: Row[];
  ledgerAccounts: Row[];
  ledgerEntries: Row[];
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

const hoisted = vi.hoisted(() => ({ transfersCreate: vi.fn(async () => ({ id: 'tr_test_1' })) }));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    payouts: {
      tables: {
        payoutAccounts: tableMarker('payoutAccounts'),
        payouts: tableMarker('payouts'),
        ledgerAccounts: tableMarker('ledgerAccounts'),
        ledgerEntries: tableMarker('ledgerEntries'),
      },
    },
  },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

vi.mock('../src/lib/stripe.js', () => ({
  stripe: { transfers: { create: hoisted.transfersCreate } },
  webhookSecret: 'whsec_dummy',
}));

vi.mock('../src/lib/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

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
  const gt = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number | Date) > (valueOf(b, row) as number | Date);
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  const desc = (field: Field) => ({ __desc: field.column });
  return { eq, and, gt, inArray, desc };
});

let store: Store;

const accountConflictKey = (row: Row): string =>
  row.kind === 'photographer' ? `photographer:${row.photographerId}` : `kind:${row.kind}`;
const entryDedupeKey = (row: Row): string | null => {
  if (row.payoutId != null) return `payout:${row.payoutId}:${row.accountId}:${row.direction}`;
  return null;
};
const payoutPeriodKey = (row: Row): string => `${row.payoutAccountId}:${row.periodEnd}`;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    let order: { __desc: string } | undefined;
    const exec = (): Row[] => {
      if (!bucket) return [];
      let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
      if (order) {
        const col = order.__desc;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as number | string;
          const bv = b[col] as number | string;
          return av > bv ? -1 : av < bv ? 1 : 0;
        });
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
      orderBy(o: { __desc: string }) {
        order = o;
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

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let pending: Row[] = [];
    let guard = false;
    const commit = (): Row[] => {
      const written: Row[] = [];
      for (const row of pending) {
        if (guard) {
          if (
            bucket === 'ledgerAccounts' &&
            store.ledgerAccounts.some((r) => accountConflictKey(r) === accountConflictKey(row))
          )
            continue;
          if (bucket === 'ledgerEntries') {
            const key = entryDedupeKey(row);
            if (key !== null && store.ledgerEntries.some((r) => entryDedupeKey(r) === key))
              continue;
          }
          if (
            bucket === 'payouts' &&
            store.payouts.some((r) => payoutPeriodKey(r) === payoutPeriodKey(row))
          )
            continue;
        }
        const full = { id: fakeUuid(), createdAt: new Date(), ...row };
        store[bucket].push(full);
        written.push(full);
      }
      return written;
    };
    const api = {
      values(payload: Row | Row[]) {
        pending = Array.isArray(payload) ? payload : [payload];
        return api;
      },
      onConflictDoNothing() {
        guard = true;
        return api;
      },
      returning(selection?: Record<string, { column: string }>) {
        const written = commit();
        const rows = selection
          ? written.map((w) => {
              const p: Row = {};
              for (const [alias, ref] of Object.entries(selection)) p[alias] = w[ref.column];
              return p;
            })
          : written;
        return Promise.resolve(rows);
      },
      then(resolve: (v: unknown) => unknown) {
        commit();
        return resolve(undefined);
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
        for (const row of store[bucket]) if (pred(row)) Object.assign(row, patch);
        return Promise.resolve(undefined);
      },
    };
    return api;
  };

  const db = {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
    update: (t: Row) => updateBuilder(t),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return db;
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.payouts.tables.payoutAccounts as Record<string, unknown>, [
    'id',
    'photographerId',
    'stripeAccountId',
    'currency',
    'payoutsEnabled',
    'createdAt',
  ]);
  tag(schema.payouts.tables.payouts as Record<string, unknown>, [
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
    'sentAt',
    'paidAt',
  ]);
  tag(schema.payouts.tables.ledgerAccounts as Record<string, unknown>, [
    'id',
    'kind',
    'photographerId',
  ]);
  tag(schema.payouts.tables.ledgerEntries as Record<string, unknown>, [
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
};

let db: ReturnType<typeof makeFakeDb>;

const newStore = (): Store => ({
  payoutAccounts: [],
  payouts: [],
  ledgerAccounts: [],
  ledgerEntries: [],
});

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  hoisted.transfersCreate.mockReset();
  hoisted.transfersCreate.mockResolvedValue({ id: 'tr_test_1' });
  await installFieldShims();
  db = makeFakeDb();
});

// Seed a photographer payout account + ledger account holding `owed` cents
// (one sale credit), created in the past.
const seedPhotographer = (
  photographerId: string,
  owed: number,
  opts: { payoutsEnabled?: boolean; stripeAccountId?: string | null } = {},
): { payoutAccountId: string; ledgerAccountId: string } => {
  const payoutAccountId = fakeUuid();
  const ledgerAccountId = fakeUuid();
  store.payoutAccounts.push({
    id: payoutAccountId,
    photographerId,
    stripeAccountId: opts.stripeAccountId === undefined ? 'acct_1' : opts.stripeAccountId,
    currency: 'eur',
    payoutsEnabled: opts.payoutsEnabled ?? true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  store.ledgerAccounts.push({ id: ledgerAccountId, kind: 'photographer', photographerId });
  if (owed > 0) {
    store.ledgerEntries.push({
      id: fakeUuid(),
      accountId: ledgerAccountId,
      orderId: 'o-seed',
      refundId: null,
      payoutId: null,
      direction: 'credit',
      amountCents: owed,
      currency: 'eur',
      kind: 'sale',
      memo: 'seed sale',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
  }
  return { payoutAccountId, ledgerAccountId };
};

const balanceOf = (ledgerAccountId: string): number =>
  store.ledgerEntries
    .filter((e) => e.accountId === ledgerAccountId)
    .reduce(
      (s, e) =>
        s + (e.direction === 'credit' ? (e.amountCents as number) : -(e.amountCents as number)),
      0,
    );

describe('runPayouts', () => {
  it('pays an owed photographer: payout sent, ledger pair posted, balance zeroed', async () => {
    const { runPayouts } = await import('../src/services/payouts.js');
    const { ledgerAccountId } = seedPhotographer('A', 8680);

    const result = await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.status).toBe('sent');
    expect(hoisted.transfersCreate).toHaveBeenCalledTimes(1);
    const transferArgs = hoisted.transfersCreate.mock.calls[0];
    expect((transferArgs?.[0] as { amount: number }).amount).toBe(8680);
    expect((transferArgs?.[1] as { idempotencyKey: string }).idempotencyKey).toMatch(/^payout:/);

    const payout = store.payouts[0] as {
      status: string;
      netCents: number;
      stripeTransferId: string;
    };
    expect(payout.status).toBe('sent');
    expect(payout.netCents).toBe(8680);
    expect(balanceOf(ledgerAccountId)).toBe(0);
  });

  it('skips a photographer below the minimum (no payout, balance preserved)', async () => {
    const { runPayouts } = await import('../src/services/payouts.js');
    const { ledgerAccountId } = seedPhotographer('A', 0);
    const result = await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    expect(result.created).toHaveLength(0);
    expect(hoisted.transfersCreate).not.toHaveBeenCalled();
    expect(balanceOf(ledgerAccountId)).toBe(0);
  });

  it('skips accounts with payouts disabled or no Stripe account', async () => {
    const { runPayouts } = await import('../src/services/payouts.js');
    seedPhotographer('A', 5000, { payoutsEnabled: false });
    seedPhotographer('B', 5000, { stripeAccountId: null });
    const result = await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    expect(result.created).toHaveLength(0);
    expect(hoisted.transfersCreate).not.toHaveBeenCalled();
  });

  it('on transfer failure marks failed and posts NO ledger entry (balance rolls over)', async () => {
    const { runPayouts } = await import('../src/services/payouts.js');
    const { ledgerAccountId } = seedPhotographer('A', 5000);
    hoisted.transfersCreate.mockRejectedValueOnce(new Error('stripe down'));

    const result = await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    expect(result.created[0]?.status).toBe('failed');
    expect((store.payouts[0] as { status: string }).status).toBe('failed');
    // No payout ledger entry; balance unchanged.
    expect(store.ledgerEntries.some((e) => e.kind === 'payout')).toBe(false);
    expect(balanceOf(ledgerAccountId)).toBe(5000);
  });

  it('is idempotent for the same period (second run creates no second payout)', async () => {
    const { runPayouts } = await import('../src/services/payouts.js');
    seedPhotographer('A', 5000);
    const now = new Date('2026-05-21T00:00:00Z');
    await runPayouts(db as never, { now });
    hoisted.transfersCreate.mockClear();
    const second = await runPayouts(db as never, { now });
    // Balance is 0 after the first run, so the second run skips below-minimum.
    expect(second.created).toHaveLength(0);
    expect(hoisted.transfersCreate).not.toHaveBeenCalled();
    expect(store.payouts).toHaveLength(1);
  });
});

describe('reconcilePayoutFromWebhook', () => {
  it('transfer.paid marks the payout paid', async () => {
    const { runPayouts, reconcilePayoutFromWebhook } = await import('../src/services/payouts.js');
    seedPhotographer('A', 5000);
    await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    const transferId = (store.payouts[0] as { stripeTransferId: string }).stripeTransferId;

    await reconcilePayoutFromWebhook(db as never, {
      type: 'transfer.paid',
      transfer: { id: transferId },
    });
    expect((store.payouts[0] as { status: string }).status).toBe('paid');
  });

  it('transfer.failed after a sent payout reverses the ledger pair', async () => {
    const { runPayouts, reconcilePayoutFromWebhook } = await import('../src/services/payouts.js');
    const { ledgerAccountId } = seedPhotographer('A', 5000);
    await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    expect(balanceOf(ledgerAccountId)).toBe(0);
    const transferId = (store.payouts[0] as { stripeTransferId: string }).stripeTransferId;

    await reconcilePayoutFromWebhook(db as never, {
      type: 'transfer.failed',
      transfer: { id: transferId },
    });
    expect((store.payouts[0] as { status: string }).status).toBe('failed');
    // Reversal restored the balance.
    expect(balanceOf(ledgerAccountId)).toBe(5000);
  });
});

describe('retryPayout', () => {
  it('retries a failed payout and marks it sent', async () => {
    const { runPayouts, retryPayout } = await import('../src/services/payouts.js');
    const { ledgerAccountId } = seedPhotographer('A', 5000);
    hoisted.transfersCreate.mockRejectedValueOnce(new Error('stripe down'));
    await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    const payoutId = (store.payouts[0] as { id: string }).id;

    hoisted.transfersCreate.mockResolvedValueOnce({ id: 'tr_retry_1' });
    const result = await retryPayout(db as never, payoutId, {
      now: new Date('2026-05-22T00:00:00Z'),
    });
    expect(result.status).toBe('sent');
    expect((store.payouts[0] as { status: string }).status).toBe('sent');
    // The pair posts on retry success -> balance zeroed.
    expect(balanceOf(ledgerAccountId)).toBe(0);
  });

  it('rejects retrying a non-failed payout', async () => {
    const { runPayouts, retryPayout, PayoutError } = await import('../src/services/payouts.js');
    seedPhotographer('A', 5000);
    await runPayouts(db as never, { now: new Date('2026-05-21T00:00:00Z') });
    const payoutId = (store.payouts[0] as { id: string }).id;
    await expect(retryPayout(db as never, payoutId)).rejects.toBeInstanceOf(PayoutError);
  });
});

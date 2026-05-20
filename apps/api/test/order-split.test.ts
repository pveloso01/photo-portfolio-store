// F2.10 — order split engine unit tests. In-memory fake DB with full
// select/insert/transaction support so the real ledger account resolution and
// postLedgerBatch run end-to-end (no ledger mock needed).

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  orders: Row[];
  orderItems: Row[];
  photos: Row[];
  eventMembers: Row[];
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

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    commerce: { tables: { orders: tableMarker('orders'), orderItems: tableMarker('orderItems') } },
    photos: { tables: { photos: tableMarker('photos') } },
    events: { tables: { eventMembers: tableMarker('eventMembers') } },
    payouts: {
      tables: {
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
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  return { eq, and, inArray };
});

let store: Store;

const accountConflictKey = (row: Row): string =>
  row.kind === 'photographer' ? `photographer:${row.photographerId}` : `kind:${row.kind}`;
const entryDedupeKey = (row: Row): string | null =>
  row.orderId == null ? null : `${row.orderId}:${row.kind}:${row.accountId}:${row.direction}`;

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

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let pending: Row[] = [];
    let conflictGuard = false;
    const commit = (): Row[] => {
      const written: Row[] = [];
      for (const row of pending) {
        if (conflictGuard) {
          if (bucket === 'ledgerAccounts') {
            const key = accountConflictKey(row);
            if (store.ledgerAccounts.some((r) => accountConflictKey(r) === key)) continue;
          } else if (bucket === 'ledgerEntries') {
            const key = entryDedupeKey(row);
            if (key !== null && store.ledgerEntries.some((r) => entryDedupeKey(r) === key))
              continue;
          }
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
        conflictGuard = true;
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

  const db = {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    insert: (t: Row) => insertBuilder(t),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return db;
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.commerce.tables.orders as Record<string, unknown>, [
    'id',
    'totalCents',
    'currency',
    'eventId',
  ]);
  tag(schema.commerce.tables.orderItems as Record<string, unknown>, [
    'id',
    'orderId',
    'photoId',
    'lineTotalCents',
    'metadataJsonb',
  ]);
  tag(schema.photos.tables.photos as Record<string, unknown>, ['id', 'photographerUserId']);
  tag(schema.events.tables.eventMembers as Record<string, unknown>, [
    'eventId',
    'userId',
    'splitPct',
    'role',
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
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

const newStore = (): Store => ({
  orders: [],
  orderItems: [],
  photos: [],
  eventMembers: [],
  ledgerAccounts: [],
  ledgerEntries: [],
});

const sumDirection = (entries: Array<{ direction: string; amountCents: number }>, dir: string) =>
  entries.filter((e) => e.direction === dir).reduce((s, e) => s + e.amountCents, 0);

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

const seedOrder = (id: string, totalCents: number, eventId = 'ev1', currency = 'eur'): void => {
  store.orders.push({ id, totalCents, currency, eventId });
};
const seedPhoto = (id: string, photographerUserId: string, eventId = 'ev1'): void => {
  store.photos.push({ id, photographerUserId, eventId });
};
const seedSinglePhotoItem = (orderId: string, photoId: string, lineTotalCents: number): void => {
  store.orderItems.push({
    id: `oi-${store.orderItems.length}`,
    orderId,
    photoId,
    lineTotalCents,
    metadataJsonb: {},
  });
};

describe('computeOrderSplit', () => {
  it('splits a multi-photographer order cents-exactly and balances', async () => {
    const { computeOrderSplit } = await import('../src/services/order-split.js');
    const { estimatePlatformFeeCents, estimateStripeFeeCents } = await import(
      '../src/services/ledger.js'
    );

    seedOrder('o1', 10_000);
    for (let i = 0; i < 8; i += 1) {
      seedPhoto(`pA${i}`, 'A');
      seedSinglePhotoItem('o1', `pA${i}`, 1000);
    }
    for (let i = 0; i < 2; i += 1) {
      seedPhoto(`pB${i}`, 'B');
      seedSinglePhotoItem('o1', `pB${i}`, 1000);
    }

    const result = await computeOrderSplit(db as never, 'o1');

    const P = estimatePlatformFeeCents(10_000);
    const S = estimateStripeFeeCents(10_000);
    const distributable = 10_000 - P - S;

    expect(sumDirection(result.entries, 'debit')).toBe(10_000);
    expect(sumDirection(result.entries, 'credit')).toBe(10_000);

    const nets = Object.values(result.photographerNetByUserId);
    expect(nets.reduce((s, n) => s + n, 0)).toBe(distributable);
    expect(result.photographerNetByUserId.A).toBeGreaterThan(result.photographerNetByUserId.B ?? 0);

    const saleCredits = result.entries.filter((e) => e.kind === 'sale' && e.direction === 'credit');
    expect(saleCredits).toHaveLength(2);
  });

  it('aggregates multiple line items by the same photographer into one entry', async () => {
    const { computeOrderSplit } = await import('../src/services/order-split.js');
    seedOrder('o2', 3000);
    seedPhoto('p1', 'A');
    seedPhoto('p2', 'A');
    seedPhoto('p3', 'A');
    seedSinglePhotoItem('o2', 'p1', 1000);
    seedSinglePhotoItem('o2', 'p2', 1000);
    seedSinglePhotoItem('o2', 'p3', 1000);

    const result = await computeOrderSplit(db as never, 'o2');
    const saleCredits = result.entries.filter((e) => e.kind === 'sale' && e.direction === 'credit');
    expect(saleCredits).toHaveLength(1);
  });

  it('weights bundle revenue by photo count across photographers', async () => {
    const { computeOrderSplit } = await import('../src/services/order-split.js');
    seedOrder('o3', 10_000);
    seedPhoto('bp1', 'A');
    seedPhoto('bp2', 'A');
    seedPhoto('bp3', 'A');
    seedPhoto('bp4', 'C');
    store.orderItems.push({
      id: 'oi-bundle',
      orderId: 'o3',
      photoId: null,
      lineTotalCents: 10_000,
      metadataJsonb: { bundleId: 'b1', bundleSnapshot: ['bp1', 'bp2', 'bp3', 'bp4'] },
    });

    const result = await computeOrderSplit(db as never, 'o3');
    expect(sumDirection(result.entries, 'debit')).toBe(sumDirection(result.entries, 'credit'));
    expect(result.photographerNetByUserId.A).toBeGreaterThan(result.photographerNetByUserId.C ?? 0);
  });

  it('throws for a missing order', async () => {
    const { computeOrderSplit } = await import('../src/services/order-split.js');
    await expect(computeOrderSplit(db as never, 'nope')).rejects.toThrow(/not found/);
  });

  it('property: random multi-photographer orders always conserve cents', async () => {
    const { computeOrderSplit } = await import('../src/services/order-split.js');
    for (let t = 0; t < 60; t += 1) {
      store = newStore();
      uuidCounter = 0;
      await installFieldShims();
      db = makeFakeDb();
      const photographers = ['A', 'B', 'C', 'D'].slice(0, 1 + Math.floor(Math.random() * 4));
      const itemCount = 1 + Math.floor(Math.random() * 12);
      let gross = 0;
      for (let i = 0; i < itemCount; i += 1) {
        const owner = photographers[Math.floor(Math.random() * photographers.length)] ?? 'A';
        const price = 100 + Math.floor(Math.random() * 5000);
        seedPhoto(`p${i}`, owner);
        seedSinglePhotoItem('ord', `p${i}`, price);
        gross += price;
      }
      seedOrder('ord', gross);

      const result = await computeOrderSplit(db as never, 'ord');
      expect(sumDirection(result.entries, 'debit')).toBe(gross);
      expect(sumDirection(result.entries, 'credit')).toBe(gross);
      const nets = Object.values(result.photographerNetByUserId).reduce((s, n) => s + n, 0);
      expect(nets).toBe(gross - result.platformFeeCents - result.stripeFeeCents);
    }
  });
});

describe('recordOrderSale', () => {
  it('posts a balanced batch to the ledger (idempotent on replay)', async () => {
    const { recordOrderSale } = await import('../src/services/order-split.js');
    seedOrder('o9', 5000);
    seedPhoto('p1', 'A');
    seedSinglePhotoItem('o9', 'p1', 5000);

    await recordOrderSale(db as never, 'o9');
    const afterFirst = store.ledgerEntries.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(sumDirection(store.ledgerEntries as never, 'debit')).toBe(
      sumDirection(store.ledgerEntries as never, 'credit'),
    );

    // Replay — dedupe index makes it a no-op.
    await recordOrderSale(db as never, 'o9');
    expect(store.ledgerEntries).toHaveLength(afterFirst);
  });
});

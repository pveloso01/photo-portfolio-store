// F3.5 — fulfillment service unit tests. bulkModerate is stubbed (it has its
// own suite); we assert the takedown row, audit_trail entry, and email.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  takedownRequests: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

const hoisted = vi.hoisted(() => ({
  bulkModerate: vi.fn(),
}));

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: { compliance: { tables: { takedownRequests: tableMarker('takedownRequests') } } },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

vi.mock('../src/lib/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
  hashIp: (ip: string) => `iphash:${ip}`,
}));

vi.mock('../src/services/moderation.js', () => {
  class ModerationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { BULK_MAX: 100, ModerationError, bulkModerate: hoisted.bulkModerate };
});

vi.mock('../src/services/takedowns.js', () => {
  class TakedownError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { TakedownError };
});

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  return { eq };
});

let store: Store;
const mailer = vi.fn(async () => undefined);

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    const api = {
      from(t: Row) {
        bucket = t[TABLE_KEY] as keyof Store;
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
        if (!bucket) return resolve([]);
        let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
        if (limitN !== undefined) rows = rows.slice(0, limitN);
        const projected = selection
          ? rows.map((r) => {
              const p: Row = {};
              for (const [alias, ref] of Object.entries(selection)) p[alias] = r[ref.column];
              return p;
            })
          : rows.map((r) => ({ ...r }));
        return resolve(projected);
      },
    };
    return api;
  };
  const updateBuilder = (t: Row) => {
    const bucket = t[TABLE_KEY] as keyof Store;
    let patch: Row = {};
    return {
      set(values: Row) {
        patch = values;
        return this;
      },
      where(pred: (r: Row) => boolean) {
        for (const row of store[bucket]) if (pred(row)) Object.assign(row, patch);
        return Promise.resolve(undefined);
      },
    };
  };
  return {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    update: (t: Row) => updateBuilder(t),
  };
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.compliance.tables.takedownRequests as Record<string, unknown>, [
    'id',
    'subjectEmail',
    'status',
    'auditTrail',
    'fulfilledAt',
    'fulfilledBy',
    'rejectionReason',
    'notes',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = { takedownRequests: [] };
  mailer.mockClear();
  hoisted.bulkModerate.mockReset();
  await installFieldShims();
  db = makeFakeDb();
});

const seedTakedown = (overrides: Partial<Row> = {}): string => {
  const id = '10000000-1000-4000-8000-000000000001';
  store.takedownRequests.push({
    id,
    subjectEmail: 'foo@example.com',
    status: 'verifying',
    auditTrail: [],
    fulfilledAt: null,
    fulfilledBy: null,
    ...overrides,
  });
  return id;
};

describe('fulfillTakedown', () => {
  it('on full success: status -> fulfilled, audit_trail appended, email sent', async () => {
    const { fulfillTakedown } = await import('../src/services/takedown-fulfillment.js');
    hoisted.bulkModerate.mockResolvedValue({ updated: 2, failed: [] });
    const id = seedTakedown();

    const result = await fulfillTakedown(
      db as never,
      id,
      {
        approvedPhotoIds: [
          '10000000-1000-4000-8000-000000000010',
          '10000000-1000-4000-8000-000000000011',
        ],
      },
      { adminUserId: 'admin1' },
      undefined,
      mailer as never,
    );

    expect(result.status).toBe('fulfilled');
    expect(result.fulfilled).toHaveLength(2);
    const row = store.takedownRequests[0] as Row;
    expect(row.status).toBe('fulfilled');
    expect(row.fulfilledAt).toBeInstanceOf(Date);
    expect((row.auditTrail as unknown[]).length).toBe(1);
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it('partial purge failure leaves status untouched and surfaces failed[]', async () => {
    const { fulfillTakedown } = await import('../src/services/takedown-fulfillment.js');
    hoisted.bulkModerate.mockResolvedValue({
      updated: 1,
      failed: ['10000000-1000-4000-8000-000000000011'],
    });
    const id = seedTakedown();

    const result = await fulfillTakedown(
      db as never,
      id,
      {
        approvedPhotoIds: [
          '10000000-1000-4000-8000-000000000010',
          '10000000-1000-4000-8000-000000000011',
        ],
      },
      { adminUserId: 'admin1' },
      undefined,
      mailer as never,
    );

    expect(result.failed).toHaveLength(1);
    expect((store.takedownRequests[0] as Row).status).toBe('verifying'); // not yet fulfilled
    expect(mailer).not.toHaveBeenCalled(); // confirmation only on full success
  });

  it('rejects fulfilling an already-fulfilled takedown', async () => {
    const { fulfillTakedown } = await import('../src/services/takedown-fulfillment.js');
    const { TakedownError } = await import('../src/services/takedowns.js');
    const id = seedTakedown({ status: 'fulfilled' });
    await expect(
      fulfillTakedown(
        db as never,
        id,
        { approvedPhotoIds: ['10000000-1000-4000-8000-000000000010'] },
        { adminUserId: 'a' },
      ),
    ).rejects.toBeInstanceOf(TakedownError);
  });
});

describe('rejectTakedown', () => {
  it('marks rejected, emails the subject, audits', async () => {
    const { rejectTakedown } = await import('../src/services/takedown-fulfillment.js');
    const id = seedTakedown();
    const result = await rejectTakedown(
      db as never,
      id,
      { rejectionReason: 'no standing' },
      { adminUserId: 'admin1' },
      mailer as never,
    );
    expect(result.status).toBe('rejected');
    const row = store.takedownRequests[0] as Row;
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('no standing');
    expect(mailer).toHaveBeenCalledTimes(1);
  });
});

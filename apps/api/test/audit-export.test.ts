// F3.11 — audit export service unit tests. Fake DB; storage injected.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  auditExports: Row[];
  auditLog: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = () => {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
};

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    compliance: {
      tables: { auditExports: tableMarker('auditExports'), auditLog: tableMarker('auditLog') },
    },
  },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

vi.mock('../src/lib/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/storage.js', () => ({
  s3: { send: vi.fn(async () => ({})) },
  buckets: { originals: 'originals', derivatives: 'derivatives' },
}));
vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const gte = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number | Date) >= (valueOf(b, row) as number | Date);
  const lte = (a: unknown, b: unknown) => (row: Row) =>
    (valueOf(a, row) as number | Date) <= (valueOf(b, row) as number | Date);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const desc = (field: Field) => ({ __desc: field.column });
  return { eq, gte, lte, and, desc };
});

let store: Store;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | undefined;
    const run = (): Row[] => {
      if (!bucket) return [];
      let rows = store[bucket].filter((r) => filters.every((f) => f(r)));
      if (limitN !== undefined) rows = rows.slice(0, limitN);
      return selection
        ? rows.map((r) => {
            const p: Row = {};
            for (const [alias, ref] of Object.entries(selection)) p[alias] = r[ref.column];
            return p;
          })
        : rows.map((r) => ({ ...r }));
    };
    const api = {
      from(t: Row) {
        bucket = t[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      orderBy() {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(run());
      },
    };
    return api;
  };
  const insertBuilder = (t: Row) => {
    const bucket = t[TABLE_KEY] as keyof Store;
    let inserted: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        inserted = arr.map((r) => ({ id: fakeUuid(), createdAt: new Date(), ...r }));
        store[bucket].push(...inserted.map((r) => ({ ...r })));
        return api;
      },
      returning(selection?: Record<string, { column: string }>) {
        return Promise.resolve(
          selection
            ? inserted.map((r) => {
                const p: Row = {};
                for (const [alias, ref] of Object.entries(selection)) p[alias] = r[ref.column];
                return p;
              })
            : inserted,
        );
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
    insert: (t: Row) => insertBuilder(t),
    update: (t: Row) => updateBuilder(t),
  };
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.compliance.tables.auditExports as Record<string, unknown>, [
    'id',
    'requestedBy',
    'filters',
    'status',
    'rowCount',
    'fileKey',
    'expiresAt',
    'createdAt',
  ]);
  tag(schema.compliance.tables.auditLog as Record<string, unknown>, [
    'id',
    'actorUserId',
    'actorKind',
    'action',
    'targetKind',
    'targetId',
    'createdAt',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = { auditExports: [], auditLog: [] };
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

describe('createExport + runExport', () => {
  it('creates a pending row, audits, then runExport writes CSV and marks ready', async () => {
    const { createExport, runExport } = await import('../src/services/audit-export.js');
    const { writeAudit } = await import('../src/lib/audit.js');
    store.auditLog.push(
      {
        id: 'a1',
        actorUserId: 'u1',
        actorKind: 'user',
        action: 'order.paid',
        targetKind: 'order',
        targetId: 'o1',
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
      {
        id: 'a2',
        actorUserId: 'u2',
        actorKind: 'webhook',
        action: 'order.refunded',
        targetKind: 'order',
        targetId: 'o2',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    );

    const { jobId } = await createExport(db as never, {}, { adminUserId: 'admin1' });
    expect(store.auditExports[0]).toMatchObject({ status: 'pending', requestedBy: 'admin1' });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'audit.export.requested' }),
    );

    const s3 = (await import('../src/lib/storage.js')).s3;
    await runExport(db as never, jobId);
    const job = store.auditExports[0] as Row;
    expect(job.status).toBe('ready');
    expect(job.rowCount).toBe(2);
    expect(job.fileKey).toBe(`audit-exports/${jobId}.csv`);
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it('applies filters (action) to the exported rows', async () => {
    const { createExport, runExport } = await import('../src/services/audit-export.js');
    store.auditLog.push(
      {
        id: 'a1',
        actorUserId: 'u1',
        actorKind: 'user',
        action: 'order.paid',
        targetKind: 'order',
        targetId: 'o1',
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
      {
        id: 'a2',
        actorUserId: 'u2',
        actorKind: 'webhook',
        action: 'order.refunded',
        targetKind: 'order',
        targetId: 'o2',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    );
    const { jobId } = await createExport(
      db as never,
      { action: 'order.paid' },
      { adminUserId: 'admin1' },
    );
    await runExport(db as never, jobId);
    expect((store.auditExports[0] as Row).rowCount).toBe(1);
  });
});

describe('getExportStatus', () => {
  it('returns a signed URL + audits the download when ready', async () => {
    const { createExport, runExport, getExportStatus } = await import(
      '../src/services/audit-export.js'
    );
    const { writeAudit } = await import('../src/lib/audit.js');
    store.auditLog.push({
      id: 'a1',
      actorUserId: 'u1',
      actorKind: 'user',
      action: 'x',
      targetKind: 't',
      targetId: 'i',
      createdAt: new Date(),
    });
    const { jobId } = await createExport(db as never, {}, { adminUserId: 'admin1' });
    await runExport(db as never, jobId);

    const status = await getExportStatus(
      db as never,
      jobId,
      { adminUserId: 'admin1' },
      {
        signUrl: async (k) => `https://signed/${k}`,
      },
    );
    expect(status?.status).toBe('ready');
    expect(status?.downloadUrl).toBe(`https://signed/audit-exports/${jobId}.csv`);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'audit.export.downloaded' }),
    );
  });

  it('returns null for an unknown job', async () => {
    const { getExportStatus } = await import('../src/services/audit-export.js');
    const status = await getExportStatus(db as never, '00000000-0000-4000-8000-0000000000ff', {
      adminUserId: 'admin1',
    });
    expect(status).toBeNull();
  });
});

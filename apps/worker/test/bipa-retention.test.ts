// F3.8 — BIPA retention destruction worker test.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  consents: Row[];
  faceVectors: Row[];
}

const TABLE_KEY = Symbol('table-key');
const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    compliance: { tables: { consents: tableMarker('consents') } },
    search: { tables: { faceVectors: tableMarker('faceVectors') } },
  },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const isNull = (a: unknown) => (row: Row) => valueOf(a, row) == null;
  const isNotNull = (a: unknown) => (row: Row) => valueOf(a, row) != null;
  const lt = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row) as Date | undefined;
    const bv = valueOf(b, row) as Date;
    return av instanceof Date && av < bv;
  };
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const notInArray = (field: unknown, list: unknown[]) => (row: Row) =>
    !list.includes(valueOf(field, row));
  return { eq, isNull, isNotNull, lt, and, notInArray };
});

let store: Store;

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
  const deleteBuilder = (t: Row) => {
    const bucket = t[TABLE_KEY] as keyof Store;
    return {
      where(pred: (r: Row) => boolean) {
        const removed = store[bucket].filter((r) => pred(r));
        store[bucket] = store[bucket].filter((r) => !pred(r));
        return {
          returning() {
            return Promise.resolve(removed.map((r) => ({ id: r.id })));
          },
        };
      },
    };
  };
  return {
    select: (s?: Record<string, { column: string }>) => selectBuilder(s),
    update: (t: Row) => updateBuilder(t),
    delete: (t: Row) => deleteBuilder(t),
  };
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.compliance.tables.consents as Record<string, unknown>, [
    'id',
    'scope',
    'eventId',
    'revokedAt',
    'retentionUntil',
    'retentionWindowEndsAt',
  ]);
  tag(schema.search.tables.faceVectors as Record<string, unknown>, ['id', 'eventId']);
};

let db: ReturnType<typeof makeFakeDb>;
let now: Date;
let qdrant: { deleteCollection: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  store = { consents: [], faceVectors: [] };
  now = new Date('2030-01-01T00:00:00Z');
  await installFieldShims();
  db = makeFakeDb();
  qdrant = { deleteCollection: vi.fn(async () => ({})) };
});

describe('runBipaRetentionDestruction', () => {
  it('destroys vectors + drops collection + revokes consent for an expired single-subject event', async () => {
    const { runBipaRetentionDestruction } = await import('../src/jobs/bipa-retention.js');
    store.consents.push({
      id: 'c1',
      scope: 'biometric',
      eventId: 'ev1',
      revokedAt: null,
      retentionWindowEndsAt: new Date('2029-01-01T00:00:00Z'),
    });
    store.faceVectors.push({ id: 'fv1', eventId: 'ev1' }, { id: 'fv2', eventId: 'ev1' });

    const result = await runBipaRetentionDestruction(db as never, qdrant as never, now);
    expect(result.consentsProcessed).toBe(1);
    expect(result.vectorsDeleted).toBe(2);
    expect(result.collectionsDropped).toBe(1);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith('faces_event_ev1');
    expect((store.consents[0] as Row).revokedAt).toBeInstanceOf(Date);
    expect(store.faceVectors).toHaveLength(0);
  });

  it('skips already-revoked consents and consents whose window has not yet elapsed', async () => {
    const { runBipaRetentionDestruction } = await import('../src/jobs/bipa-retention.js');
    store.consents.push(
      // already revoked -> skip
      {
        id: 'c1',
        scope: 'biometric',
        eventId: 'ev1',
        revokedAt: new Date('2028-01-01T00:00:00Z'),
        retentionWindowEndsAt: new Date('2029-01-01T00:00:00Z'),
      },
      // still in window -> skip
      {
        id: 'c2',
        scope: 'biometric',
        eventId: 'ev2',
        revokedAt: null,
        retentionWindowEndsAt: new Date('2031-01-01T00:00:00Z'),
      },
      // no retention window -> skip
      {
        id: 'c3',
        scope: 'biometric',
        eventId: 'ev3',
        revokedAt: null,
        retentionWindowEndsAt: null,
      },
    );
    const result = await runBipaRetentionDestruction(db as never, qdrant as never, now);
    expect(result.consentsProcessed).toBe(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it('treats a Qdrant 404 on collection drop as a benign no-op', async () => {
    const { runBipaRetentionDestruction } = await import('../src/jobs/bipa-retention.js');
    store.consents.push({
      id: 'c1',
      scope: 'biometric',
      eventId: 'ev1',
      revokedAt: null,
      retentionWindowEndsAt: new Date('2029-01-01T00:00:00Z'),
    });
    qdrant.deleteCollection.mockRejectedValueOnce(
      new Error('Not Found: collection does not exist'),
    );
    const result = await runBipaRetentionDestruction(db as never, qdrant as never, now);
    expect(result.collectionsDropped).toBe(0);
    expect((store.consents[0] as Row).revokedAt).toBeInstanceOf(Date);
  });
});

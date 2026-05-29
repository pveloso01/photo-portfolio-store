// F4.5 — roster import service tests (fake in-memory db).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: {
    participants: {
      participants: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        bib: { column: 'bib' },
      },
      rosterImports: {
        id: { column: 'id' },
        eventId: { column: 'eventId' },
        status: { column: 'status' },
        totalRows: { column: 'totalRows' },
        reportJson: { column: 'reportJson' },
        filename: { column: 'filename' },
        importedRows: { column: 'importedRows' },
        skippedRows: { column: 'skippedRows' },
        createdAt: { column: 'createdAt' },
      },
    },
  },
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const val = (v: unknown, row: Record<string, unknown>) => (isField(v) ? row[v.column] : v);
  return {
    and:
      (...preds: Array<(r: Record<string, unknown>) => boolean>) =>
      (row: Record<string, unknown>) =>
        preds.every((p) => p(row)),
    eq: (a: unknown, b: unknown) => (row: Record<string, unknown>) => val(a, row) === val(b, row),
  };
});

type Row = Record<string, unknown>;
let imports: Row[];
let parts: Row[];
let idSeq: number;

const makeDb = () => {
  const select = (sel: Record<string, { column: string }>) => {
    const filters: Array<(r: Row) => boolean> = [];
    let bucket: Row[] = [];
    const api = {
      from: (t: { __b?: string }) => {
        bucket = t.__b === 'parts' ? parts : imports;
        return api;
      },
      where: (p: (r: Row) => boolean) => {
        filters.push(p);
        return api;
      },
      limit: () => Promise.resolve(project()),
    };
    const project = () =>
      bucket
        .filter((r) => filters.every((f) => f(r)))
        .map((r) => {
          const o: Row = {};
          for (const [a, ref] of Object.entries(sel)) o[a] = r[ref.column];
          return o;
        });
    return api;
  };

  const insert = (t: { __b?: string }) => ({
    values: (v: Row) => {
      const bucket = t.__b === 'parts' ? parts : imports;
      return {
        returning: () => {
          const id = `id${idSeq++}`;
          bucket.push({ createdAt: new Date('2026-05-29T00:00:00Z'), ...v, id });
          return Promise.resolve([{ id }]);
        },
        onConflictDoNothing: () => ({
          returning: () => {
            const dupe =
              t.__b === 'parts' && parts.some((p) => p.eventId === v.eventId && p.bib === v.bib);
            if (dupe) return Promise.resolve([]);
            const id = `id${idSeq++}`;
            bucket.push({ ...v, id });
            return Promise.resolve([{ id }]);
          },
        }),
      };
    },
  });

  const update = () => ({
    set: (s: Row) => ({
      where: (p: (r: Row) => boolean) => {
        for (const r of imports) if (p(r)) Object.assign(r, s);
        return Promise.resolve();
      },
    }),
  });

  return { select, insert, update } as never;
};

let svc: typeof import('../src/services/roster-import.js');

beforeEach(async () => {
  imports = [];
  parts = [];
  idSeq = 1;
  // Tag the schema table markers so the fake db can route by bucket.
  const { schema } = await import('@pkg/db');
  (schema.participants.participants as { __b?: string }).__b = 'parts';
  (schema.participants.rosterImports as { __b?: string }).__b = 'imports';
  svc = await import('../src/services/roster-import.js');
});

const CSV = 'bib,name,email\n1,A,a@x.io\n2,B,b@x.io\n2,Dup,dup@x.io\n3,C,bad-email';

describe('previewRoster', () => {
  it('persists a previewed import and returns counts + sample + issues', async () => {
    const db = makeDb();
    const preview = await svc.previewRoster(db, 'ev1', 'roster.csv', CSV);
    expect(preview.totalRows).toBe(4);
    expect(preview.validRows).toBe(2); // rows 1 and 2; dup bib + bad email skipped
    expect(preview.skippedRows).toBe(2);
    expect(preview.issues.map((i) => i.reason).sort()).toEqual(['duplicate_bib', 'invalid_email']);
    expect(preview.sample).toHaveLength(2);
    expect(imports[0]?.status).toBe('previewed');
  });
});

describe('commitRoster', () => {
  it('inserts valid rows as participants and marks the import imported', async () => {
    const db = makeDb();
    const preview = await svc.previewRoster(db, 'ev1', 'roster.csv', CSV);
    const report = await svc.commitRoster(db, 'ev1', preview.importId);
    expect(report.status).toBe('imported');
    expect(report.importedRows).toBe(2);
    expect(parts).toHaveLength(2);
    expect(imports[0]?.status).toBe('imported');
  });

  it('is idempotent: re-running skips already-imported bibs (unique event+bib)', async () => {
    const db = makeDb();
    // Pre-seed bib 1 for the event.
    parts.push({ eventId: 'ev1', bib: '1', name: 'existing', id: 'x' });
    const preview = await svc.previewRoster(db, 'ev1', 'roster.csv', CSV);
    const report = await svc.commitRoster(db, 'ev1', preview.importId);
    expect(report.importedRows).toBe(1); // only bib 2 is new
    expect(parts).toHaveLength(2);
  });

  it('throws not_found for an unknown import id', async () => {
    const db = makeDb();
    await expect(svc.commitRoster(db, 'ev1', 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws already_imported when committing twice', async () => {
    const db = makeDb();
    const preview = await svc.previewRoster(db, 'ev1', 'roster.csv', CSV);
    await svc.commitRoster(db, 'ev1', preview.importId);
    await expect(svc.commitRoster(db, 'ev1', preview.importId)).rejects.toMatchObject({
      code: 'already_imported',
    });
  });
});

describe('getRosterImport', () => {
  it('returns the import record with issues, or null when not found', async () => {
    const db = makeDb();
    const preview = await svc.previewRoster(db, 'ev1', 'roster.csv', CSV);
    const rec = await svc.getRosterImport(db, 'ev1', preview.importId);
    expect(rec?.totalRows).toBe(4);
    expect(rec?.issues).toHaveLength(2);
    expect(await svc.getRosterImport(db, 'ev1', 'nope')).toBeNull();
  });
});

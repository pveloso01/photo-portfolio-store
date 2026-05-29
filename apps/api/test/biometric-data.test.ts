// F3.6 — right-to-know service tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  consents: Row[];
  searchSessions: Row[];
  searchMatches: Row[];
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
    search: {
      tables: {
        searchSessions: tableMarker('searchSessions'),
        searchMatches: tableMarker('searchMatches'),
      },
    },
  },
}));

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: { object: () => ({ parse: (v: unknown) => v }), string: () => ({ min: () => ({}) }) },
}));

vi.mock('../src/lib/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
  hashIp: (ip: string) => `iphash:${ip}`,
}));

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[v.column] : v);
  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const inArray = (field: unknown, list: unknown[]) => (row: Row) =>
    list.includes(valueOf(field, row));
  const or =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.some((p) => p(row));
  return { eq, inArray, or };
});

let store: Store;

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, { column: string }>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const api = {
      from(t: Row) {
        bucket = t[TABLE_KEY] as keyof Store;
        return api;
      },
      where(pred: (r: Row) => boolean) {
        filters.push(pred);
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        if (!bucket) return resolve([]);
        const rows = store[bucket].filter((r) => filters.every((f) => f(r)));
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
  return { select: (s?: Record<string, { column: string }>) => selectBuilder(s) };
};

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.compliance.tables.consents as Record<string, unknown>, [
    'id',
    'scope',
    'subjectId',
    'subjectEmailHash',
    'jurisdiction',
    'region',
    'grantedAt',
    'revokedAt',
    'expiresAt',
    'retentionUntil',
    'retentionWindowEndsAt',
    'eventId',
  ]);
  tag(schema.search.tables.searchSessions as Record<string, unknown>, [
    'id',
    'eventId',
    'consentId',
    'searchKind',
    'matchesCount',
    'createdAt',
  ]);
  tag(schema.search.tables.searchMatches as Record<string, unknown>, [
    'sessionId',
    'photoId',
    'score',
    'source',
    'rank',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = { consents: [], searchSessions: [], searchMatches: [] };
  await installFieldShims();
  db = makeFakeDb();
});

describe('getMyBiometricData', () => {
  it('returns consents, searches and matches with the legal-notice block; no embeddings persisted', async () => {
    const { getMyBiometricData } = await import('../src/services/biometric-data.js');
    store.consents.push({
      id: 'c1',
      scope: 'biometric',
      subjectId: 'u1',
      subjectEmailHash: null,
      jurisdiction: 'us_bipa',
      region: 'US-IL',
      grantedAt: new Date('2026-05-01T00:00:00Z'),
      revokedAt: null,
      expiresAt: new Date('2026-05-02T00:00:00Z'),
      retentionUntil: null,
      retentionWindowEndsAt: new Date('2029-05-01T00:00:00Z'),
      eventId: 'ev1',
    });
    store.searchSessions.push({
      id: 's1',
      eventId: 'ev1',
      consentId: 'c1',
      searchKind: 'face',
      matchesCount: 2,
      createdAt: new Date('2026-05-01T01:00:00Z'),
    });
    store.searchMatches.push(
      { sessionId: 's1', photoId: 'p1', score: '0.92', source: 'face', rank: 1 },
      { sessionId: 's1', photoId: 'p2', score: '0.81', source: 'face', rank: 2 },
    );

    const view = await getMyBiometricData(db as never, { userId: 'u1' }, { ipHash: 'h' });
    expect(view.consents).toHaveLength(1);
    expect(view.consents[0]?.region).toBe('US-IL');
    expect(view.searches).toHaveLength(1);
    expect(view.matches).toHaveLength(2);
    expect(view.enrolledSelfies).toEqual([]);
    expect(view.faceEmbeddings.count).toBe(0);
    expect(view.legalNotice.citations.length).toBeGreaterThan(0);
  });

  it('returns the same shape with empty arrays when the subject has no data', async () => {
    const { getMyBiometricData } = await import('../src/services/biometric-data.js');
    const view = await getMyBiometricData(db as never, { userId: 'u-empty' }, { ipHash: 'h' });
    expect(view.consents).toEqual([]);
    expect(view.searches).toEqual([]);
    expect(view.matches).toEqual([]);
    expect(view.faceEmbeddings.count).toBe(0);
  });

  it('also matches consents stored under hashed email when email is provided', async () => {
    const { getMyBiometricData } = await import('../src/services/biometric-data.js');
    const { createHash } = await import('node:crypto');
    const emailHash = createHash('sha256').update('foo@example.com', 'utf8').digest('hex');
    store.consents.push({
      id: 'c2',
      scope: 'biometric',
      subjectId: null,
      subjectEmailHash: emailHash,
      jurisdiction: 'eu_gdpr',
      region: null,
      grantedAt: new Date(),
      revokedAt: null,
      expiresAt: null,
      retentionUntil: null,
      retentionWindowEndsAt: null,
      eventId: null,
    });
    const view = await getMyBiometricData(
      db as never,
      { userId: 'u1', email: 'Foo@Example.com' },
      { ipHash: 'h' },
    );
    expect(view.consents).toHaveLength(1);
  });

  it('writes an audit row on every disclosure', async () => {
    const { getMyBiometricData } = await import('../src/services/biometric-data.js');
    const { writeAudit } = await import('../src/lib/audit.js');
    await getMyBiometricData(db as never, { userId: 'u1' }, { ipHash: 'h' });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'biometric.disclosed' }),
    );
  });
});

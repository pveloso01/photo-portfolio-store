// Search service + route tests (F1.23).
//
// We mock @pkg/db with table markers and back the drizzle builder with a
// tiny in-memory store. The goal is to lock down the service-layer
// invariants (bib hit/miss, session+matches persistence, anonymous gate)
// without spinning up Postgres.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- In-memory fake store ----------

type Row = Record<string, unknown>;

interface Store {
  events: Row[];
  eventSettings: Row[];
  eventRosterEntries: Row[];
  photos: Row[];
  photoDerivatives: Row[];
  bibTags: Row[];
  searchSessions: Row[];
  searchMatches: Row[];
  auditLog: Row[];
}

const newStore = (): Store => ({
  events: [],
  eventSettings: [],
  eventRosterEntries: [],
  photos: [],
  photoDerivatives: [],
  bibTags: [],
  searchSessions: [],
  searchMatches: [],
  auditLog: [],
});

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store) => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const eventsTbl = {
    events: tableMarker('events'),
    eventSettings: tableMarker('eventSettings'),
    eventMembers: tableMarker('events'),
    eventFtpCredentials: tableMarker('events'),
    eventRosterEntries: tableMarker('eventRosterEntries'),
  };
  const photosTbl = {
    photos: tableMarker('photos'),
    photoDerivatives: tableMarker('photoDerivatives'),
    uploadSessions: tableMarker('photos'),
  };
  const searchTbl = {
    bibTags: tableMarker('bibTags'),
    searchSessions: tableMarker('searchSessions'),
    searchMatches: tableMarker('searchMatches'),
    faceVectors: tableMarker('bibTags'),
    qualityFlags: tableMarker('bibTags'),
  };
  const complianceTbl = {
    auditLog: tableMarker('auditLog'),
    consents: tableMarker('auditLog'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      events: { tables: eventsTbl, ...eventsTbl },
      photos: { tables: photosTbl, ...photosTbl },
      search: { tables: searchTbl, ...searchTbl },
      compliance: { tables: complianceTbl, ...complianceTbl },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://stub',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    S3_BUCKET_ORIGINALS: 'orig',
    S3_BUCKET_DERIVATIVES: 'deriv',
    S3_PUBLIC_BASE_URL: 'https://cdn.example.test',
  }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({
      url: () => ({ optional: () => ({}) }),
      min: () => ({ default: () => ({}) }),
      default: () => ({}),
    }),
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(
    async (_c: unknown, _cmd: unknown, _o: unknown) => 'https://signed.example/x',
  ),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

// ---------- Fake DbClient ----------

let store: Store = newStore();

interface JoinSpec {
  rightBucket: keyof Store;
  predicate: (left: Row, right: Row) => boolean;
}

const makeFakeDb = () => {
  const selectBuilder = (selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    let joinSpec: JoinSpec | null = null;
    const filters: Array<(joined: Row) => boolean> = [];
    let sortFn: ((a: Row, b: Row) => number) | undefined;
    let limitN: number | undefined;

    const sel = selection;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      innerJoin(table: Row, predicate: (joined: Row) => boolean) {
        joinSpec = {
          rightBucket: table[TABLE_KEY] as keyof Store,
          // Right wins on column collision — see note in `then` below.
          predicate: (left: Row, right: Row) => predicate({ ...left, ...right }),
        };
        return api;
      },
      leftJoin(table: Row, predicate: (joined: Row) => boolean) {
        joinSpec = {
          rightBucket: table[TABLE_KEY] as keyof Store,
          predicate: (left: Row, right: Row) => predicate({ ...left, ...right }),
        };
        return api;
      },
      where(predicate: (joined: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      orderBy(...comparators: Array<(a: Row, b: Row) => number>) {
        sortFn = (a, b) => {
          for (const c of comparators) {
            const v = c(a, b);
            if (v !== 0) return v;
          }
          return 0;
        };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown) {
        if (!bucket) return resolve([]);
        const leftRows = store[bucket];
        let joined: Row[] = leftRows.map((r) => ({ ...r }));
        if (joinSpec) {
          const out: Row[] = [];
          for (const l of joined) {
            for (const r of store[joinSpec.rightBucket]) {
              if (joinSpec.predicate(l, r)) {
                // Merge: right wins on column collision. Tests are seeded so
                // that only joining-key columns can collide; we choose
                // right-wins so `eq(photos.id, bibTags.photoId)` resolves
                // photos.id correctly (photos is the right side in
                // searchByBib's `from(bibTags).innerJoin(photos)`).
                out.push({ ...l, ...r });
              }
            }
          }
          joined = out;
        }
        const filterFn = (r: Row) => filters.every((f) => f(r));
        let rows = joined.filter(filterFn);
        if (sortFn) rows = [...rows].sort(sortFn);
        if (limitN !== undefined) rows = rows.slice(0, limitN);

        // Selection projection
        if (sel) {
          rows = rows.map((row) => {
            const projected: Row = {};
            for (const [alias, fieldRef] of Object.entries(sel)) {
              const fr = fieldRef as { column?: string };
              const col = fr.column;
              if (col) projected[alias] = row[col];
            }
            return projected;
          });
        }
        return resolve(rows);
      },
    };
    return api;
  };

  const insertBuilder = (table: Row) => {
    const bucket = table[TABLE_KEY] as keyof Store;
    let toInsert: Row[] = [];
    const api = {
      values(payload: Row | Row[]) {
        const arr = Array.isArray(payload) ? payload : [payload];
        toInsert = arr.map((row) => ({
          id: fakeUuid(),
          createdAt: new Date(),
          ...row,
        }));
        store[bucket].push(...toInsert.map((r) => ({ ...r })));
        return api;
      },
      returning(_cols?: Record<string, unknown>) {
        return api as unknown as Promise<Row[]>;
      },
      then(resolve: (v: Row[]) => unknown) {
        return resolve(toInsert.map((r) => ({ ...r })));
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
    insert: (table: Row) => insertBuilder(table),
    execute: async (_q: unknown) => [] as Row[],
  };
};

// ---------- drizzle-orm shim ----------

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
  const lt = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row);
    const bv = valueOf(b, row);
    if (av instanceof Date && bv instanceof Date) return av.getTime() < bv.getTime();
    return (av as number) < (bv as number);
  };
  const gte = (a: unknown, b: unknown) => (row: Row) => {
    const av = valueOf(a, row);
    const bv = valueOf(b, row);
    return (av as number) >= (bv as number);
  };
  const ilike = (field: unknown, pattern: string) => {
    const re = new RegExp(pattern.replace(/%/g, '.*'), 'i');
    return (row: Row) => re.test(String(valueOf(field, row) ?? ''));
  };
  const inArray = (field: unknown, list: unknown[]) => (row: Row) => {
    const v = valueOf(field, row);
    return list.includes(v);
  };
  const asc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    return (av as number) > (bv as number) ? 1 : (av as number) < (bv as number) ? -1 : 0;
  };
  const desc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    if (av instanceof Date && bv instanceof Date) return bv.getTime() - av.getTime();
    if (typeof av === 'string' && typeof bv === 'string') return av > bv ? -1 : av < bv ? 1 : 0;
    return (av as number) > (bv as number) ? -1 : (av as number) < (bv as number) ? 1 : 0;
  };
  const sqlTag = ((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    // Always-true predicate for SQL fragments — sufficient for the lower()
    // case-insensitive comparison used by queryBibMatches in our happy-path
    // tests, since we control the bib_number casing in fixtures.
    return (_row: Row) => true;
  }) as unknown as Record<string, unknown>;
  sqlTag.join = (_arr: unknown[], _sep: unknown) => ({ __sql: 'joined' });

  return { eq, and, or, lt, gte, ilike, inArray, asc, desc, sql: sqlTag };
});

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const tag = (tbl: Record<string, unknown>, cols: string[]) => {
    for (const c of cols) tbl[c] = { column: c };
  };
  tag(schema.events.tables.events as Record<string, unknown>, [
    'id',
    'orgId',
    'status',
    'allowAnonymousBrowse',
  ]);
  tag(schema.events.tables.eventSettings as Record<string, unknown>, [
    'eventId',
    'allowAnonymousBrowse',
  ]);
  tag(schema.events.tables.eventRosterEntries as Record<string, unknown>, [
    'eventId',
    'bib',
    'name',
  ]);
  tag(schema.photos.tables.photos as Record<string, unknown>, ['id', 'status', 'hidden']);
  tag(schema.photos.tables.photoDerivatives as Record<string, unknown>, [
    'photoId',
    'kind',
    'objectKey',
  ]);
  tag(schema.search.tables.bibTags as Record<string, unknown>, [
    'id',
    'photoId',
    'eventId',
    'bibNumber',
    'confidence',
  ]);
  tag(schema.search.tables.searchSessions as Record<string, unknown>, [
    'id',
    'eventId',
    'consentId',
    'searchKind',
    'queryText',
    'matchesCount',
    'latencyMs',
  ]);
  tag(schema.search.tables.searchMatches as Record<string, unknown>, [
    'sessionId',
    'photoId',
    'score',
    'source',
    'rank',
  ]);
  tag(schema.compliance.tables.auditLog as Record<string, unknown>, [
    'id',
    'action',
    'actorKind',
    'eventId',
    'targetId',
    'payloadJsonb',
  ]);
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  const svc = await import('../src/services/search.js');
  svc.__resetExtensionCacheForTests();
  db = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------- Fixtures ----------

const EVENT_PUBLISHED = '00000000-0000-4000-8000-0000000000e1';
const EVENT_DRAFT = '00000000-0000-4000-8000-0000000000e2';
const PHOTO_A = '00000000-0000-4000-8000-0000000000a1';
const PHOTO_B = '00000000-0000-4000-8000-0000000000a2';
const PHOTO_HIDDEN = '00000000-0000-4000-8000-0000000000a3';

const seedPublishedEvent = (): void => {
  store.events.push({
    id: EVENT_PUBLISHED,
    orgId: 'org-1',
    status: 'published',
  });
  store.eventSettings.push({
    eventId: EVENT_PUBLISHED,
    allowAnonymousBrowse: true,
  });
};

const seedDraftEvent = (): void => {
  store.events.push({
    id: EVENT_DRAFT,
    orgId: 'org-1',
    status: 'draft',
  });
  store.eventSettings.push({
    eventId: EVENT_DRAFT,
    allowAnonymousBrowse: true,
  });
};

const seedPhotos = (): void => {
  store.photos.push(
    { id: PHOTO_A, status: 'ready', hidden: false },
    { id: PHOTO_B, status: 'ready', hidden: false },
    { id: PHOTO_HIDDEN, status: 'ready', hidden: true },
  );
};

const seedBibTags = (): void => {
  store.bibTags.push(
    {
      id: fakeUuid(),
      photoId: PHOTO_A,
      eventId: EVENT_PUBLISHED,
      bibNumber: '101',
      confidence: '0.950',
    },
    {
      id: fakeUuid(),
      photoId: PHOTO_B,
      eventId: EVENT_PUBLISHED,
      bibNumber: '101',
      confidence: '0.800',
    },
    {
      id: fakeUuid(),
      photoId: PHOTO_HIDDEN,
      eventId: EVENT_PUBLISHED,
      bibNumber: '101',
      confidence: '0.700',
    },
  );
};

const importService = async () => await import('../src/services/search.js');
const importRoutes = async () => (await import('../src/routes/search.js')).default;

// ---------- Service-level tests ----------

describe('searchByBib service', () => {
  it('returns matching photos in confidence-desc order', async () => {
    seedPhotos();
    seedBibTags();
    const svc = await importService();
    const result = await svc.searchByBib(db as never, {
      eventId: EVENT_PUBLISHED,
      bibNumber: '101',
    });
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.photoId).toBe(PHOTO_A);
    expect(result.matches[0]?.score).toBeCloseTo(0.95, 2);
    expect(result.matches[1]?.photoId).toBe(PHOTO_B);
    // Hidden photo must not appear.
    expect(result.matches.find((m) => m.photoId === PHOTO_HIDDEN)).toBeUndefined();
  });

  it('returns empty result when no bib tags match', async () => {
    seedPhotos();
    const svc = await importService();
    const result = await svc.searchByBib(db as never, {
      eventId: EVENT_PUBLISHED,
      bibNumber: '999',
    });
    expect(result.matches).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('persists a search_sessions row and one search_matches row per result', async () => {
    seedPhotos();
    seedBibTags();
    const svc = await importService();
    await svc.searchByBib(db as never, {
      eventId: EVENT_PUBLISHED,
      bibNumber: '101',
    });
    expect(store.searchSessions).toHaveLength(1);
    expect(store.searchSessions[0]).toMatchObject({
      eventId: EVENT_PUBLISHED,
      searchKind: 'bib',
      queryText: '101',
      matchesCount: 2,
    });
    expect(store.searchMatches).toHaveLength(2);
    expect(
      store.searchMatches.every(
        (m) => m.source === 'bib' && m.sessionId === store.searchSessions[0]?.id,
      ),
    ).toBe(true);
  });

  it('records latencyMs on the session', async () => {
    seedPhotos();
    seedBibTags();
    const svc = await importService();
    const result = await svc.searchByBib(db as never, {
      eventId: EVENT_PUBLISHED,
      bibNumber: '101',
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(store.searchSessions[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('searchByName service', () => {
  it('resolves roster bib then delegates to bib search', async () => {
    seedPublishedEvent();
    seedPhotos();
    seedBibTags();
    store.eventRosterEntries.push({
      id: fakeUuid(),
      eventId: EVENT_PUBLISHED,
      bib: '101',
      name: 'Alice Runner',
    });
    const svc = await importService();
    const result = await svc.searchByName(db as never, {
      eventId: EVENT_PUBLISHED,
      name: 'Alice',
    });
    // ILIKE fallback path (no pg_trgm in our shim) — matches the roster row.
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.photoId === PHOTO_A)).toBe(true);
    expect(store.searchSessions[0]?.searchKind).toBe('name');
  });

  it('returns empty when no roster names fuzzy-match', async () => {
    seedPublishedEvent();
    seedPhotos();
    seedBibTags();
    store.eventRosterEntries.push({
      id: fakeUuid(),
      eventId: EVENT_PUBLISHED,
      bib: '101',
      name: 'Alice Runner',
    });
    const svc = await importService();
    const result = await svc.searchByName(db as never, {
      eventId: EVENT_PUBLISHED,
      name: 'Zelda',
    });
    expect(result.matches).toHaveLength(0);
  });
});

// ---------- Route-level tests ----------

const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  const routes = await importRoutes();
  await app.register(routes, { db: db as never });
  return app;
};

describe('search routes', () => {
  it('POST /v1/events/:id/search/bib returns 200 with matches for a published event', async () => {
    seedPublishedEvent();
    seedPhotos();
    seedBibTags();
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_PUBLISHED}/search/bib`,
      payload: { bibNumber: '101' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches.length).toBe(2);
    expect(body.sessionId).toBeTruthy();
    expect(typeof body.latencyMs).toBe('number');
    await app.close();
  });

  it('returns 404 for a draft event without leaking existence', async () => {
    seedDraftEvent();
    seedPhotos();
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_DRAFT}/search/bib`,
      payload: { bibNumber: '101' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    await app.close();
  });

  it('returns 404 for an event that does not exist', async () => {
    const app = await buildApp();
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${ghost}/search/bib`,
      payload: { bibNumber: '101' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('writes an audit log entry per executed search', async () => {
    seedPublishedEvent();
    seedPhotos();
    seedBibTags();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_PUBLISHED}/search/bib`,
      payload: { bibNumber: '101' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.auditLog.some((r) => r.action === 'search.bib.executed')).toBe(true);
    await app.close();
  });

  it('400s on invalid body (missing bibNumber)', async () => {
    seedPublishedEvent();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_PUBLISHED}/search/bib`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /v1/events/:id/search/name returns 200 and writes name session', async () => {
    seedPublishedEvent();
    seedPhotos();
    seedBibTags();
    store.eventRosterEntries.push({
      id: fakeUuid(),
      eventId: EVENT_PUBLISHED,
      bib: '101',
      name: 'Alice Runner',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_PUBLISHED}/search/name`,
      payload: { name: 'Alice' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches.length).toBeGreaterThan(0);
    expect(store.searchSessions[0]?.searchKind).toBe('name');
    expect(store.auditLog.some((r) => r.action === 'search.name.executed')).toBe(true);
    await app.close();
  });
});

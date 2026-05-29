// F3.4 — takedown service unit tests.

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Store {
  takedownRequests: Row[];
  takedownVerificationTokens: Row[];
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
      tables: {
        takedownRequests: tableMarker('takedownRequests'),
        takedownVerificationTokens: tableMarker('takedownVerificationTokens'),
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
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  // sql tag — not exercised; identity function suffices.
  const sql = () => true;
  return { eq, and, sql };
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
      then(resolve: (v: unknown) => unknown) {
        return resolve(undefined);
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
  tag(schema.compliance.tables.takedownRequests as Record<string, unknown>, [
    'id',
    'subjectEmail',
    'photoIds',
    'reason',
    'legalBasis',
    'evidenceUrl',
    'notes',
    'status',
    'slaDueAt',
    'receivedAt',
    'verifiedAt',
    'fulfilledAt',
    'fulfilledBy',
    'rejectionReason',
    'auditTrail',
    'submitterIpHash',
  ]);
  tag(schema.compliance.tables.takedownVerificationTokens as Record<string, unknown>, [
    'id',
    'trackingId',
    'tokenHash',
    'expiresAt',
    'consumedAt',
  ]);
};

let db: ReturnType<typeof makeFakeDb>;
const mailer = vi.fn(async () => undefined);

beforeEach(async () => {
  store = { takedownRequests: [], takedownVerificationTokens: [] };
  uuidCounter = 0;
  mailer.mockClear();
  await installFieldShims();
  db = makeFakeDb();
});

describe('createTakedownRequest', () => {
  it('inserts a received row, sends the verification email, and audits', async () => {
    const { createTakedownRequest } = await import('../src/services/takedowns.js');
    const { writeAudit } = await import('../src/lib/audit.js');
    const result = await createTakedownRequest(
      db as never,
      {
        subjectEmail: 'Foo@Example.com',
        reason: 'gdpr',
        legalBasis: 'Art. 17',
        photoIds: ['10000000-1000-4000-8000-000000000001'],
      },
      { ipHash: 'iphash:1.2.3.4', baseUrl: 'http://test.local' },
      mailer as never,
    );
    expect(result.trackingId).toBeTruthy();
    const req = store.takedownRequests[0] as Row;
    expect(req.subjectEmail).toBe('foo@example.com'); // lowercased
    expect(req.status).toBe('received');
    expect(Array.isArray(req.auditTrail)).toBe(true);
    expect((req.auditTrail as unknown[]).length).toBe(1);
    expect(store.takedownVerificationTokens).toHaveLength(1);
    expect(mailer).toHaveBeenCalledTimes(1);
    const mail = mailer.mock.calls[0]?.[0] as { html: string; text: string; to: string };
    expect(mail.to).toBe('Foo@Example.com');
    expect(mail.text).toContain(`/v1/takedowns/${result.trackingId}/verify?token=`);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'takedown.submitted' }),
    );
  });

  it('persists the SHA-256 of the token, not the raw token', async () => {
    const { createTakedownRequest } = await import('../src/services/takedowns.js');
    const result = await createTakedownRequest(
      db as never,
      { subjectEmail: 'a@b.com', reason: 'bipa', legalBasis: '740 ILCS 14' },
      { ipHash: 'iphash:1.2.3.4', baseUrl: 'http://test.local' },
      mailer as never,
    );
    const mail = mailer.mock.calls[0]?.[0] as { text: string };
    const raw = mail.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    expect(raw).toBeTruthy();
    const stored = store.takedownVerificationTokens[0] as { tokenHash: string };
    expect(stored.tokenHash).toBe(
      createHash('sha256')
        .update(raw ?? '', 'utf8')
        .digest('hex'),
    );
    expect(stored.tokenHash).not.toBe(raw);
    void result;
  });
});

describe('verifyTakedown', () => {
  it('consumes the token and transitions to verifying', async () => {
    const { createTakedownRequest, verifyTakedown } = await import('../src/services/takedowns.js');
    const { trackingId } = await createTakedownRequest(
      db as never,
      { subjectEmail: 'a@b.com', reason: 'gdpr', legalBasis: 'Art. 17' },
      { ipHash: 'iphash:1.2.3.4', baseUrl: 'http://test.local' },
      mailer as never,
    );
    const raw =
      (mailer.mock.calls[0]?.[0] as { text: string }).text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ??
      '';

    const result = await verifyTakedown(db as never, trackingId, raw);
    expect(result.status).toBe('verifying');
    const req = store.takedownRequests[0] as Row;
    expect(req.status).toBe('verifying');
    expect(req.verifiedAt).toBeInstanceOf(Date);
    const token = store.takedownVerificationTokens[0] as Row;
    expect(token.consumedAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown token', async () => {
    const { verifyTakedown, TakedownError } = await import('../src/services/takedowns.js');
    await expect(
      verifyTakedown(db as never, '00000000-0000-4000-8000-000000000099', 'nope'),
    ).rejects.toBeInstanceOf(TakedownError);
  });

  it('rejects a re-used token', async () => {
    const { createTakedownRequest, verifyTakedown, TakedownError } = await import(
      '../src/services/takedowns.js'
    );
    const { trackingId } = await createTakedownRequest(
      db as never,
      { subjectEmail: 'a@b.com', reason: 'gdpr', legalBasis: 'x' },
      { ipHash: 'h', baseUrl: 'http://test.local' },
      mailer as never,
    );
    const raw =
      (mailer.mock.calls[0]?.[0] as { text: string }).text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ??
      '';
    await verifyTakedown(db as never, trackingId, raw);
    await expect(verifyTakedown(db as never, trackingId, raw)).rejects.toBeInstanceOf(
      TakedownError,
    );
  });
});

describe('getTakedownStatus', () => {
  it('returns the status when the token matches', async () => {
    const { createTakedownRequest, getTakedownStatus } = await import(
      '../src/services/takedowns.js'
    );
    const { trackingId } = await createTakedownRequest(
      db as never,
      { subjectEmail: 'a@b.com', reason: 'gdpr', legalBasis: 'x' },
      { ipHash: 'h', baseUrl: 'http://test.local' },
      mailer as never,
    );
    const raw =
      (mailer.mock.calls[0]?.[0] as { text: string }).text.match(/token=([A-Za-z0-9_-]+)/)?.[1] ??
      '';
    const status = await getTakedownStatus(db as never, trackingId, raw);
    expect(status?.status).toBe('received');
    expect(status?.slaDueAt).toBeTruthy();
  });

  it('returns null for a bogus token', async () => {
    const { getTakedownStatus } = await import('../src/services/takedowns.js');
    const status = await getTakedownStatus(
      db as never,
      '00000000-0000-4000-8000-000000000099',
      'nope',
    );
    expect(status).toBeNull();
  });
});

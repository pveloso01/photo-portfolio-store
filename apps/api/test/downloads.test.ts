// F1.31 — downloads route tests.
//
// Validates the public GET /v1/orders/:orderId/downloads/:downloadToken
// endpoint. The route delegates signing to an injectable function so we never
// hit S3 from tests. The DB is a hand-rolled select/insert dispatcher.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks for @pkg/db so importing route doesn't require pg ----------

vi.mock('@pkg/db', () => {
  const t = (name: string) => ({ __table: name });
  return {
    createDbClient: () => ({}),
    schema: {
      commerce: {
        fulfillments: t('fulfillments'),
      },
      compliance: {
        auditLog: t('audit_log'),
      },
    },
  };
});

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (a: unknown, b: unknown) => ({ __op: 'eq', a, b }),
    and: (...parts: unknown[]) => ({ __op: 'and', parts }),
    sql: actual.sql,
  };
});

import downloadsRoutes from '../src/routes/downloads.js';

// ---------- DB fake ----------

interface Fulfillment {
  id: string;
  orderId: string;
  status: 'completed' | 'in_progress' | 'failed';
  downloadToken: string;
  downloadExpiresAt: Date | null;
  payload: Record<string, unknown> | null;
}

const buildDb = (rows: Fulfillment[]) => {
  const auditInserts: Array<Record<string, unknown>> = [];

  const select = vi.fn(() => {
    const where = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(async () => {
        // Match by the `eq` operands stuffed into where args.
        return rows.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          status: r.status,
          downloadToken: r.downloadToken,
          downloadExpiresAt: r.downloadExpiresAt,
          payload: r.payload,
        }));
      }),
    });
    return { from: vi.fn().mockReturnValue({ where }) };
  });

  const insertValues = vi.fn((values: Record<string, unknown>) => {
    auditInserts.push(values);
    return {
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  return { select, insert, auditInserts };
};

const buildApp = async (
  db: ReturnType<typeof buildDb>,
  opts: {
    signObject?: (key: string) => Promise<string>;
    now?: () => Date;
  } = {},
): Promise<FastifyInstance> => {
  const app = Fastify();
  await app.register(downloadsRoutes, {
    db: db as never,
    bucket: 'test-bucket',
    signObject: opts.signObject ?? (async () => 'https://signed.example/foo'),
    now: opts.now,
  });
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  // No teardown needed.
});

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 1000);

describe('GET /v1/orders/:orderId/downloads/:downloadToken', () => {
  it('valid token -> 302 to signed url and writes access audit', async () => {
    const db = buildDb([
      {
        id: 'ful-1',
        orderId: ORDER_ID,
        status: 'completed',
        downloadToken: TOKEN,
        downloadExpiresAt: FUTURE,
        payload: { bundleKey: `bundles/${ORDER_ID}/${TOKEN}.zip` },
      },
    ]);
    const signObject = vi.fn(async (key: string) => `https://signed.example/${key}`);
    const app = await buildApp(db, { signObject });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/${ORDER_ID}/downloads/${TOKEN}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://signed.example/bundles/${ORDER_ID}/${TOKEN}.zip`);
    expect(signObject).toHaveBeenCalledWith(`bundles/${ORDER_ID}/${TOKEN}.zip`);

    // Audit row written with action=fulfillment.digital.accessed.
    expect(db.auditInserts.some((v) => v.action === 'fulfillment.digital.accessed')).toBe(true);
    const ok = db.auditInserts.find(
      (v) =>
        v.action === 'fulfillment.digital.accessed' &&
        (v.payloadJsonb as Record<string, unknown> | null)?.result === 'ok',
    );
    expect(ok).toBeTruthy();

    await app.close();
  });

  it('expired token -> 410', async () => {
    const db = buildDb([
      {
        id: 'ful-2',
        orderId: ORDER_ID,
        status: 'completed',
        downloadToken: TOKEN,
        downloadExpiresAt: PAST,
        payload: null,
      },
    ]);
    const app = await buildApp(db);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/${ORDER_ID}/downloads/${TOKEN}`,
    });

    expect(res.statusCode).toBe(410);

    // Audit row written marking expired.
    expect(
      db.auditInserts.some(
        (v) =>
          v.action === 'fulfillment.digital.accessed' &&
          (v.payloadJsonb as Record<string, unknown> | null)?.result === 'expired',
      ),
    ).toBe(true);

    await app.close();
  });

  it('bad token -> 404', async () => {
    const db = buildDb([]); // No rows returned.
    const app = await buildApp(db);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/${ORDER_ID}/downloads/${TOKEN}`,
    });

    expect(res.statusCode).toBe(404);
    // No audit row written for an unknown token.
    expect(db.auditInserts.length).toBe(0);

    await app.close();
  });

  it('malformed uuid -> 404', async () => {
    const db = buildDb([]);
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/not-a-uuid/downloads/${TOKEN}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('in_progress fulfillment -> 410 (not ready)', async () => {
    const db = buildDb([
      {
        id: 'ful-3',
        orderId: ORDER_ID,
        status: 'in_progress',
        downloadToken: TOKEN,
        downloadExpiresAt: FUTURE,
        payload: null,
      },
    ]);
    const app = await buildApp(db);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/${ORDER_ID}/downloads/${TOKEN}`,
    });
    expect(res.statusCode).toBe(410);
    expect(
      db.auditInserts.some(
        (v) =>
          v.action === 'fulfillment.digital.accessed' &&
          (v.payloadJsonb as Record<string, unknown> | null)?.result === 'not_ready',
      ),
    ).toBe(true);
    await app.close();
  });
});

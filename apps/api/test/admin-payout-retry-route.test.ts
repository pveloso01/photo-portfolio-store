// F2.12 — admin payout retry route HTTP tests.
// retryPayout is stubbed; the real service (which loads stripe/ledger) is
// never pulled in. Same pattern as admin-refunds-route.test.ts.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ retryPayout: vi.fn() }));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

// Fully stub the service (incl. a self-contained PayoutError class) so the
// real module — which loads stripe.js/ledger.js at import — is never pulled in.
vi.mock('../src/services/payouts.js', () => {
  class PayoutError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'PayoutError';
    }
  }
  return { PayoutError, retryPayout: hoisted.retryPayout };
});

interface FakeUser {
  id: string;
  role: string;
}

const PAYOUT_ID = '10000000-1000-4000-8000-000000000001';

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/admin/payout-retry.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: FakeUser }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string') req.user = JSON.parse(raw) as FakeUser;
  });
  app.decorate('requirePermission', () => async (req: { user?: FakeUser }, reply: never) => {
    const user = (req as { user?: FakeUser }).user;
    const r = reply as unknown as { code: (n: number) => { send: (b: unknown) => unknown } };
    if (!user) return r.code(401).send({ error: 'Unauthorized' });
    if (user.role !== 'admin') return r.code(403).send({ error: 'Forbidden' });
    return undefined;
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
const adminUser = JSON.stringify({ id: 'admin1', role: 'admin' });
const buyerUser = JSON.stringify({ id: 'u1', role: 'buyer' });

const postRetry = (payoutId: string, userHeader: string) =>
  app.inject({
    // No body: the retry endpoint takes none. Omitting content-type avoids
    // Fastify's "empty JSON body" 400.
    method: 'POST',
    url: `/v1/admin/payouts/${payoutId}/retry`,
    headers: { 'x-test-user': userHeader },
  });

beforeEach(() => hoisted.retryPayout.mockReset());
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/admin/payouts/:id/retry', () => {
  it('returns 200 with the payout summary on success', async () => {
    const summary = {
      payoutId: PAYOUT_ID,
      payoutAccountId: 'pa_1',
      photographerId: 'ph_1',
      netCents: 5000,
      currency: 'usd',
      status: 'sent',
    };
    hoisted.retryPayout.mockResolvedValue(summary);
    app = await buildApp();
    const res = await postRetry(PAYOUT_ID, adminUser);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payoutId: PAYOUT_ID, status: 'sent', netCents: 5000 });
  });

  it('returns 404 when id param is not a valid uuid', async () => {
    app = await buildApp();
    const res = await postRetry('not-a-uuid', adminUser);
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for a non-admin user', async () => {
    app = await buildApp();
    const res = await postRetry(PAYOUT_ID, buyerUser);
    expect(res.statusCode).toBe(403);
  });
});

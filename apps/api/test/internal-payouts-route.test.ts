// F2.12 — internal payout trigger route HTTP tests.
// runPayouts is stubbed; process.env.INTERNAL_CRON_SECRET is set/deleted per test.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ runPayouts: vi.fn() }));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

vi.mock('../src/services/payouts.js', () => ({
  runPayouts: hoisted.runPayouts,
}));

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/internal/payouts.js');
  const app = Fastify({ logger: false });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;

const post = (secret?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/internal/payouts/run',
    headers: secret !== undefined ? { 'x-internal-secret': secret } : {},
  });

beforeEach(() => hoisted.runPayouts.mockReset());
afterEach(async () => {
  if (app) await app.close();
  delete process.env.INTERNAL_CRON_SECRET;
});

describe('POST /v1/internal/payouts/run', () => {
  it('returns 503 when INTERNAL_CRON_SECRET is not set', async () => {
    delete process.env.INTERNAL_CRON_SECRET;
    app = await buildApp();
    const res = await post('any-value');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'disabled' });
  });

  it('returns 401 when the secret header is missing', async () => {
    process.env.INTERNAL_CRON_SECRET = 'correct-secret';
    app = await buildApp();
    const res = await post(undefined);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('returns 401 when the secret header is wrong', async () => {
    process.env.INTERNAL_CRON_SECRET = 'correct-secret';
    app = await buildApp();
    const res = await post('wrong-secret');
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with the runPayouts result when header matches', async () => {
    process.env.INTERNAL_CRON_SECRET = 'correct-secret';
    const fakeResult = { created: [], skipped: [] };
    hoisted.runPayouts.mockResolvedValue(fakeResult);
    app = await buildApp();
    const res = await post('correct-secret');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: fakeResult });
    expect(hoisted.runPayouts).toHaveBeenCalledOnce();
  });
});

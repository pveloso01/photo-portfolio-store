// F3.1 — admin health route HTTP tests.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/db', () => ({
  createDbClient: () => ({}),
  schema: { compliance: { tables: { auditLog: { id: { column: 'id' } } } } },
}));

vi.mock('../src/lib/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

interface FakeUser {
  id: string;
  role: string;
}

const fakeDb = {
  select: () => ({ from: () => ({ limit: async () => [] }) }),
};

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/admin/health.js');
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
  await app.register(routes, { db: fakeDb as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
const adminUser = JSON.stringify({ id: 'admin1', role: 'admin' });

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/admin/health', () => {
  it('returns 200 with the health view for an admin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { 'x-test-user': adminUser },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.buildSha).toBe('string');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.dbLatencyMs).toBe('number');
    expect(body.queueDepth).toBeNull();
  });

  it('returns 403 for a non-admin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/health',
      headers: { 'x-test-user': JSON.stringify({ id: 'u1', role: 'buyer' }) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/health' });
    expect(res.statusCode).toBe(401);
  });
});

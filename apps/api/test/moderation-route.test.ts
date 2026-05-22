// F3.2 — moderation route HTTP tests. Service stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getModerationQueue: vi.fn(),
  bulkModerate: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

vi.mock('../src/services/moderation.js', () => {
  class ModerationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ModerationError';
    }
  }
  return {
    BULK_MAX: 100,
    ModerationError,
    getModerationQueue: hoisted.getModerationQueue,
    bulkModerate: hoisted.bulkModerate,
  };
});

interface FakeUser {
  id: string;
  role: string;
}

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/admin/moderation.js');
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
const adminUser = JSON.stringify({ id: 'a1', role: 'admin' });

beforeEach(() => {
  hoisted.getModerationQueue.mockReset();
  hoisted.bulkModerate.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/admin/moderation/queue', () => {
  it('returns 200 with the queue for an admin', async () => {
    hoisted.getModerationQueue.mockResolvedValue({ items: [{ photoId: 'p1' }], nextCursor: null });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation/queue',
      headers: { 'x-test-user': adminUser },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('returns 403 for a non-admin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation/queue',
      headers: { 'x-test-user': JSON.stringify({ id: 'u', role: 'buyer' }) },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/admin/moderation/bulk', () => {
  it('returns 200 with the bulk result', async () => {
    hoisted.bulkModerate.mockResolvedValue({ updated: 2, failed: [] });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/bulk',
      headers: { 'x-test-user': adminUser, 'content-type': 'application/json' },
      payload: {
        action: 'hide',
        photoIds: ['10000000-1000-4000-8000-000000000001', '10000000-1000-4000-8000-000000000002'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { updated: number }).updated).toBe(2);
  });

  it('returns 400 when more than 100 ids are sent (zod max)', async () => {
    app = await buildApp();
    const ids = Array.from(
      { length: 101 },
      (_, i) => `10000000-1000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/moderation/bulk',
      headers: { 'x-test-user': adminUser, 'content-type': 'application/json' },
      payload: { action: 'hide', photoIds: ids },
    });
    expect(res.statusCode).toBe(400);
  });
});

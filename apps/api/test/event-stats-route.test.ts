// F3.9 — event stats route HTTP tests. Service stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getEventStats: vi.fn() }));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));
vi.mock('../src/services/event-stats.js', () => ({ getEventStats: hoisted.getEventStats }));

interface FakeUser {
  id: string;
  role: string;
}

const EVENT_ID = '10000000-1000-4000-8000-000000000001';

// Grant commerce:read_orders to organizer + admin; deny others.
const ALLOWED = new Set(['organizer', 'admin']);

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/event-stats.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: FakeUser }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string') req.user = JSON.parse(raw) as FakeUser;
  });
  app.decorate('requirePermission', () => async (req: { user?: FakeUser }, reply: never) => {
    const user = (req as { user?: FakeUser }).user;
    const r = reply as unknown as { code: (n: number) => { send: (b: unknown) => unknown } };
    if (!user) return r.code(401).send({ error: 'Unauthorized' });
    if (!ALLOWED.has(user.role)) return r.code(403).send({ error: 'Forbidden' });
    return undefined;
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
const organizer = JSON.stringify({ id: 'o1', role: 'organizer' });

const sampleStats = {
  totalPhotosUploaded: 3,
  photosWithFaces: 2,
  uniqueFacesDetected: 3,
  totalOrders: 2,
  grossRevenueCents: 8000,
  netRevenueCents: 7000,
  refundCount: 1,
  refundAmountCents: 1000,
  conversionRate: 0.66,
  topPhotographersBySales: [{ photographerUserId: 'A', salesCents: 5000 }],
  salesByHour: [{ hour: '2026-05-10T09:00:00Z', salesCents: 5000, orderCount: 1 }],
  currency: 'eur',
};

beforeEach(() => hoisted.getEventStats.mockReset());
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/events/:id/stats', () => {
  it('returns 200 with stats for an organizer', async () => {
    hoisted.getEventStats.mockResolvedValue(sampleStats);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EVENT_ID}/stats`,
      headers: { 'x-test-user': organizer },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { grossRevenueCents: number }).grossRevenueCents).toBe(8000);
  });

  it('returns 403 for an unauthorized role', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EVENT_ID}/stats`,
      headers: { 'x-test-user': JSON.stringify({ id: 'u', role: 'attendee' }) },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/events/:id/stats.csv', () => {
  it('returns text/csv', async () => {
    hoisted.getEventStats.mockResolvedValue(sampleStats);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EVENT_ID}/stats.csv`,
      headers: { 'x-test-user': organizer },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('gross_revenue_cents');
    expect(res.body).toContain('8000');
  });
});

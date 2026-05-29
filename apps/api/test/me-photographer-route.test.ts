// F3.10 — photographer dashboard route HTTP tests. Service stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getPhotographerStats: vi.fn() }));

// schema.photos.photos must exist: the route transitively imports
// photo-quality.js, which destructures `schema.photos` at module load.
vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: { photos: { photos: {} } } }));
vi.mock('../src/services/photographer-stats.js', () => ({
  getPhotographerStats: hoisted.getPhotographerStats,
}));

interface FakeUser {
  id: string;
  role: string;
}

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/me-photographer.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req: { headers: Record<string, unknown>; user?: FakeUser }) => {
    const raw = req.headers['x-test-user'];
    if (typeof raw === 'string') req.user = JSON.parse(raw) as FakeUser;
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
const photographer = JSON.stringify({ id: 'A', role: 'photographer' });

const sample = {
  totalPhotos: 2,
  totalSales: 1,
  grossEarningsCents: 4000,
  pendingPayoutCents: 500,
  paidPayoutsCents: 1000,
  topPhotos: [{ photoId: 'p1', revenueCents: 4000, views: 20, sales: 1 }],
  bottomPhotos: [],
  conversionRate: 0.05,
  trafficSources: [{ source: 'direct', views: 35 }],
  faceMatchAppearanceRate: 0.5,
  timeseries: [],
};

beforeEach(() => hoisted.getPhotographerStats.mockReset());
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/me/photographer/stats', () => {
  it('returns 200 with stats for an authed photographer', async () => {
    hoisted.getPhotographerStats.mockResolvedValue(sample);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/photographer/stats?range=30d',
      headers: { 'x-test-user': photographer },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { grossEarningsCents: number }).grossEarningsCents).toBe(4000);
  });

  it('returns 401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/me/photographer/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('returns CSV', async () => {
    hoisted.getPhotographerStats.mockResolvedValue(sample);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/photographer/stats.csv?range=7d',
      headers: { 'x-test-user': photographer },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('gross_earnings_cents');
  });
});

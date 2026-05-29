// F3.13 — photo-quality route HTTP tests. Service stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getPhotoQuality: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

vi.mock('../src/services/photo-quality.js', () => ({
  getPhotoQuality: hoisted.getPhotoQuality,
}));

const PID = '20000000-1000-4000-8000-000000000001';

// Inject request.user from an x-test-user header so owner-gating can be tested.
const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/photo-quality.js');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const raw = request.headers['x-test-user'];
    if (typeof raw === 'string') {
      (request as { user?: unknown }).user = JSON.parse(raw);
    }
  });
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

const authHeader = (id: string) => ({
  'x-test-user': JSON.stringify({ id, role: 'photographer' }),
});

let app: FastifyInstance;
beforeEach(() => {
  hoisted.getPhotoQuality.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/photos/:id/quality', () => {
  it('returns 401 when unauthenticated', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/v1/photos/${PID}/quality` });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for a non-uuid id', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/photos/not-a-uuid/quality',
      headers: authHeader('u1'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the service returns null (missing or not owner)', async () => {
    hoisted.getPhotoQuality.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/photos/${PID}/quality`,
      headers: authHeader('u1'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with the quality detail', async () => {
    hoisted.getPhotoQuality.mockResolvedValue({
      photoId: PID,
      eventId: 'e1',
      blurScore: 10,
      phash: '123',
      flags: { blur: true },
      explanation: ['Blur is estimated...'],
      duplicateGroupId: null,
      duplicateSiblings: [],
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/photos/${PID}/quality`,
      headers: authHeader('u1'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { photoId: string }).photoId).toBe(PID);
  });
});

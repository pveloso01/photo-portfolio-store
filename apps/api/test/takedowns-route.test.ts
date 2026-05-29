// F3.4 — takedown route HTTP tests. Service stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createTakedownRequest: vi.fn(),
  verifyTakedown: vi.fn(),
  getTakedownStatus: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

vi.mock('../src/services/takedowns.js', () => {
  class TakedownError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'TakedownError';
    }
  }
  return {
    TakedownError,
    createTakedownRequest: hoisted.createTakedownRequest,
    verifyTakedown: hoisted.verifyTakedown,
    getTakedownStatus: hoisted.getTakedownStatus,
  };
});

vi.mock('../src/lib/audit.js', () => ({
  hashIp: (ip: string) => `iphash:${ip}`,
  writeAudit: vi.fn(async () => undefined),
}));

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/takedowns.js');
  const app = Fastify({ logger: false });
  await app.register(routes, { db: {} as never, baseUrl: 'http://test.local' });
  await app.ready();
  return app;
};

const TID = '10000000-1000-4000-8000-000000000001';

let app: FastifyInstance;
beforeEach(() => {
  hoisted.createTakedownRequest.mockReset();
  hoisted.verifyTakedown.mockReset();
  hoisted.getTakedownStatus.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/takedowns', () => {
  it('returns 202 with tracking id', async () => {
    hoisted.createTakedownRequest.mockResolvedValue({ trackingId: TID });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/takedowns',
      headers: { 'content-type': 'application/json' },
      payload: { subjectEmail: 'a@b.com', reason: 'gdpr', legalBasis: 'Art. 17' },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { trackingId: string }).trackingId).toBe(TID);
  });

  it('returns 400 on invalid body', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/takedowns',
      headers: { 'content-type': 'application/json' },
      payload: { subjectEmail: 'not-an-email', reason: 'gdpr', legalBasis: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/takedowns/:id/verify', () => {
  it('returns 200 on a valid token', async () => {
    hoisted.verifyTakedown.mockResolvedValue({ status: 'verifying' });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/takedowns/${TID}/verify?token=abcdefghij`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('verifying');
  });

  it('returns 404 without a token', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/takedowns/${TID}/verify`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/takedowns/:id', () => {
  it('returns 200 with status when service returns a row', async () => {
    hoisted.getTakedownStatus.mockResolvedValue({
      status: 'received',
      receivedAt: '2026-05-21T00:00:00Z',
      slaDueAt: '2026-05-22T00:00:00Z',
      fulfilledAt: null,
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/takedowns/${TID}?token=abcdefghij`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when service returns null', async () => {
    hoisted.getTakedownStatus.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/takedowns/${TID}?token=abcdefghij`,
    });
    expect(res.statusCode).toBe(404);
  });
});

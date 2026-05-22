// F3.11 — audit export route HTTP tests. Service stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createExport: vi.fn(),
  runExport: vi.fn(async () => undefined),
  getExportStatus: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));
vi.mock('../src/services/audit-export.js', () => ({
  createExport: hoisted.createExport,
  runExport: hoisted.runExport,
  getExportStatus: hoisted.getExportStatus,
}));

interface FakeUser {
  id: string;
  role: string;
}

const JOB_ID = '10000000-1000-4000-8000-000000000001';

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/admin/audit-export.js');
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

beforeEach(() => {
  hoisted.createExport.mockReset();
  hoisted.runExport.mockReset();
  hoisted.runExport.mockResolvedValue(undefined);
  hoisted.getExportStatus.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/admin/audit/export', () => {
  it('returns 202 with a job id', async () => {
    hoisted.createExport.mockResolvedValue({ jobId: JOB_ID });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/audit/export',
      headers: { 'x-test-user': adminUser, 'content-type': 'application/json' },
      payload: { action: 'order.paid' },
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { jobId: string }).jobId).toBe(JOB_ID);
    expect(hoisted.runExport).toHaveBeenCalledOnce();
  });

  it('returns 403 for a non-admin', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/audit/export',
      headers: {
        'x-test-user': JSON.stringify({ id: 'u', role: 'buyer' }),
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/admin/audit/export/:jobId', () => {
  it('returns 200 with status', async () => {
    hoisted.getExportStatus.mockResolvedValue({
      status: 'ready',
      rowCount: 5,
      downloadUrl: 'https://signed/x.csv',
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit/export/${JOB_ID}`,
      headers: { 'x-test-user': adminUser },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { downloadUrl: string }).downloadUrl).toBe('https://signed/x.csv');
  });

  it('returns 404 for unknown job', async () => {
    hoisted.getExportStatus.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/audit/export/${JOB_ID}`,
      headers: { 'x-test-user': adminUser },
    });
    expect(res.statusCode).toBe(404);
  });
});

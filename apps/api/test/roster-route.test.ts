// F4.5 — roster route HTTP tests. Service stubbed; RBAC stubbed.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  previewRoster: vi.fn(),
  commitRoster: vi.fn(),
  getRosterImport: vi.fn(),
}));

vi.mock('@pkg/db', () => ({ createDbClient: () => ({}), schema: {} }));

vi.mock('../src/services/roster-import.js', () => {
  class RosterImportError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    RosterImportError,
    previewRoster: hoisted.previewRoster,
    commitRoster: hoisted.commitRoster,
    getRosterImport: hoisted.getRosterImport,
  };
});

const EV = '40000000-1000-4000-8000-000000000001';
const IMP = '40000000-1000-4000-8000-0000000000a1';

const buildApp = async (): Promise<FastifyInstance> => {
  const { default: routes } = await import('../src/routes/roster.js');
  const app = Fastify({ logger: false });
  app.decorate('requirePermission', () => async () => undefined);
  await app.register(routes, { db: {} as never });
  await app.ready();
  return app;
};

let app: FastifyInstance;
beforeEach(() => {
  hoisted.previewRoster.mockReset();
  hoisted.commitRoster.mockReset();
  hoisted.getRosterImport.mockReset();
});
afterEach(async () => {
  if (app) await app.close();
});

describe('POST /v1/events/:id/roster/preview', () => {
  it('200 with preview for a text/csv body', async () => {
    hoisted.previewRoster.mockResolvedValue({
      importId: IMP,
      columns: ['bib', 'name', 'email'],
      totalRows: 1,
      validRows: 1,
      skippedRows: 0,
      sample: [],
      issues: [],
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/roster/preview`,
      headers: { 'content-type': 'text/csv' },
      payload: 'bib,name,email\n1,A,a@x.io',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { importId: string }).importId).toBe(IMP);
  });

  it('400 on an empty body', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/roster/preview`,
      headers: { 'content-type': 'text/csv' },
      payload: '   ',
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 with the parse error code when the CSV is malformed', async () => {
    const { RosterParseError } = await import('../src/lib/roster-csv.js');
    hoisted.previewRoster.mockRejectedValue(
      new RosterParseError('missing_columns', 'missing email'),
    );
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/roster/preview`,
      headers: { 'content-type': 'text/csv' },
      payload: 'bib,name\n1,A',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('missing_columns');
  });
});

describe('POST /v1/events/:id/roster/import/:importId', () => {
  it('200 with the import report', async () => {
    hoisted.commitRoster.mockResolvedValue({
      importId: IMP,
      status: 'imported',
      totalRows: 2,
      importedRows: 2,
      skippedRows: 0,
      issues: [],
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/roster/import/${IMP}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { importedRows: number }).importedRows).toBe(2);
  });

  it('409 when the import was already committed', async () => {
    const { RosterImportError } = await import('../src/services/roster-import.js');
    hoisted.commitRoster.mockRejectedValue(
      new RosterImportError('already_imported', 'already committed'),
    );
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${EV}/roster/import/${IMP}`,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /v1/events/:id/roster/imports/:importId', () => {
  it('404 when the service returns null', async () => {
    hoisted.getRosterImport.mockResolvedValue(null);
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EV}/roster/imports/${IMP}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('200 with the record', async () => {
    hoisted.getRosterImport.mockResolvedValue({
      importId: IMP,
      filename: 'roster.csv',
      status: 'imported',
      totalRows: 2,
      importedRows: 2,
      skippedRows: 0,
      issues: [],
      createdAt: '2026-05-29T00:00:00.000Z',
    });
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${EV}/roster/imports/${IMP}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { filename: string }).filename).toBe('roster.csv');
  });
});

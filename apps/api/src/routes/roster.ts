// F4.5 — CSV roster import routes (event-scoped, event:write).
//
// POST /v1/events/:id/roster/preview            — upload CSV (text/csv body),
//   returns parsed preview (sample + column map + issues) and a previewId.
// POST /v1/events/:id/roster/import/:importId    — commit a previewed import.
// GET  /v1/events/:id/roster/imports/:importId   — import report.
//
// The CSV is sent as a raw text/csv body (the generic issue says multipart;
// a raw body is the simpler, equivalent fit here). Filename comes from the
// `x-filename` header or `?filename=` query, defaulting to "roster.csv".

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { RosterParseError } from '../lib/roster-csv.js';
import {
  RosterImportError,
  commitRoster,
  getRosterImport,
  previewRoster,
} from '../services/roster-import.js';

const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10 MiB

const idParamSchema = z.object({ id: z.string().uuid() });
const importParamSchema = z.object({ id: z.string().uuid(), importId: z.string().uuid() });
const filenameSchema = z.string().min(1).max(255);

const eventResource = (req: FastifyRequest): { kind: 'event'; id: string } | undefined => {
  const parsed = idParamSchema.safeParse(req.params);
  return parsed.success ? { kind: 'event', id: parsed.data.id } : undefined;
};

const resolveFilename = (req: FastifyRequest): string => {
  const header = req.headers['x-filename'];
  const q = (req.query as { filename?: unknown } | undefined)?.filename;
  const raw =
    (typeof header === 'string' && header) || (typeof q === 'string' && q) || 'roster.csv';
  const parsed = filenameSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'roster.csv';
};

export interface RosterRoutesOptions {
  db?: DbClient;
}

const rosterRoutes = async (
  app: FastifyInstance,
  opts: RosterRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // Capture the CSV as a raw string. Scoped to this plugin instance.
  if (!app.hasContentTypeParser('text/csv')) {
    app.addContentTypeParser(
      'text/csv',
      { parseAs: 'string', bodyLimit: MAX_CSV_BYTES },
      (_req, body, done) => done(null, body),
    );
  }

  app.post(
    '/v1/events/:id/roster/preview',
    { preHandler: app.requirePermission('event:write', { resource: eventResource }) },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const csv = typeof request.body === 'string' ? request.body : '';
      if (csv.trim() === '') return reply.code(400).send({ error: 'empty_body' });
      try {
        const preview = await previewRoster(db, params.data.id, resolveFilename(request), csv);
        return reply.code(200).send(preview);
      } catch (err) {
        if (err instanceof RosterParseError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        request.log.error({ err }, 'roster preview failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  app.post(
    '/v1/events/:id/roster/import/:importId',
    { preHandler: app.requirePermission('event:write', { resource: eventResource }) },
    async (request, reply) => {
      const params = importParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      try {
        const report = await commitRoster(db, params.data.id, params.data.importId);
        return reply.code(200).send(report);
      } catch (err) {
        if (err instanceof RosterImportError) {
          const code = err.code === 'not_found' ? 404 : 409;
          return reply.code(code).send({ error: err.code, message: err.message });
        }
        request.log.error({ err }, 'roster import failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  app.get(
    '/v1/events/:id/roster/imports/:importId',
    { preHandler: app.requirePermission('event:write', { resource: eventResource }) },
    async (request, reply) => {
      const params = importParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const record = await getRosterImport(db, params.data.id, params.data.importId);
      if (!record) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(record);
    },
  );
};

export default rosterRoutes;

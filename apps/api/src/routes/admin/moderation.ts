// F3.2 — moderation queue + bulk actions.
//
// GET  /v1/admin/moderation/queue  — RBAC admin:moderate.
// POST /v1/admin/moderation/bulk   — RBAC admin:moderate.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../../lib/db.js';
import {
  BULK_MAX,
  ModerationError,
  bulkModerate,
  getModerationQueue,
} from '../../services/moderation.js';

const queueQuerySchema = z.object({
  cursor: z.string().optional(),
  severity: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(BULK_MAX).optional(),
});

const bulkBodySchema = z
  .object({
    action: z.enum(['hide', 'show', 'delete']),
    photoIds: z.array(z.string().uuid()).min(1).max(BULK_MAX),
  })
  .strict();

export interface AdminModerationOptions {
  db?: DbClient;
}

const adminModerationRoutes = async (
  app: FastifyInstance,
  opts: AdminModerationOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get(
    '/v1/admin/moderation/queue',
    { preHandler: app.requirePermission('admin:moderate') },
    async (request, reply) => {
      const q = queueQuerySchema.safeParse(request.query);
      if (!q.success) {
        return reply.code(400).send({ error: 'invalid_request', details: q.error.issues });
      }
      const result = await getModerationQueue(db, q.data);
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/v1/admin/moderation/bulk',
    { preHandler: app.requirePermission('admin:moderate') },
    async (request, reply) => {
      const body = bulkBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const adminUserId = request.user?.id;
      if (!adminUserId) return reply.code(401).send({ error: 'unauthorized' });

      try {
        const result = await bulkModerate(db, body.data.action, body.data.photoIds, {
          adminUserId,
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof ModerationError) {
          const status = err.code === 'too_many' ? 422 : err.code === 'invalid_request' ? 400 : 500;
          return reply.code(status).send({ error: err.code, message: err.message });
        }
        request.log.error({ err }, 'bulk moderation failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default adminModerationRoutes;

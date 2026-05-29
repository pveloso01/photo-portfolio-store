// F3.5 — admin takedown queue + fulfill/reject endpoints.
//
// GET  /v1/admin/takedowns?status=&overdue=true  — admin:moderate.
// POST /v1/admin/takedowns/:id/fulfill           — admin:moderate.
// POST /v1/admin/takedowns/:id/reject            — admin:moderate.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../../lib/db.js';
import type { ModerationDeps } from '../../services/moderation.js';
import { fulfillTakedown, rejectTakedown } from '../../services/takedown-fulfillment.js';
import { type MailerFn, TakedownError } from '../../services/takedowns.js';

const { takedownRequests } = schema.compliance.tables;

const idParamSchema = z.object({ id: z.string().uuid() });
const queueQuerySchema = z.object({
  status: z.enum(['received', 'verifying', 'fulfilled', 'rejected']).optional(),
  overdue: z.coerce.boolean().optional(),
});
const fulfillBodySchema = z
  .object({
    approvedPhotoIds: z.array(z.string().uuid()).min(1).max(500),
    notes: z.string().max(2000).optional(),
  })
  .strict();
const rejectBodySchema = z
  .object({
    rejectionReason: z.string().min(1).max(2000),
  })
  .strict();

const mapErr = (reply: FastifyReply, err: TakedownError): FastifyReply => {
  switch (err.code) {
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'invalid_request':
      return reply.code(422).send({ error: 'invalid_request', message: err.message });
    default:
      return reply.code(500).send({ error: 'server_error' });
  }
};

export interface AdminTakedownsOptions {
  db?: DbClient;
  mailer?: MailerFn;
  deps?: ModerationDeps;
}

const adminTakedownRoutes = async (
  app: FastifyInstance,
  opts: AdminTakedownsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get(
    '/v1/admin/takedowns',
    { preHandler: app.requirePermission('admin:moderate') },
    async (request, reply) => {
      const q = queueQuerySchema.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
      const filters = [];
      if (q.data.status) filters.push(eq(takedownRequests.status, q.data.status));
      if (q.data.overdue) filters.push(sql`${takedownRequests.slaDueAt} < ${new Date()}`);
      const base = db
        .select({
          id: takedownRequests.id,
          subjectEmail: takedownRequests.subjectEmail,
          reason: takedownRequests.reason,
          status: takedownRequests.status,
          slaDueAt: takedownRequests.slaDueAt,
          receivedAt: takedownRequests.receivedAt,
          fulfilledAt: takedownRequests.fulfilledAt,
        })
        .from(takedownRequests);
      const items = await (filters.length > 0 ? base.where(and(...filters)) : base)
        .orderBy(desc(takedownRequests.receivedAt))
        .limit(200);
      return reply.code(200).send({ items });
    },
  );

  app.post(
    '/v1/admin/takedowns/:id/fulfill',
    { preHandler: app.requirePermission('admin:moderate') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = fulfillBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const adminUserId = request.user?.id;
      if (!adminUserId) return reply.code(401).send({ error: 'unauthorized' });
      try {
        const result = await fulfillTakedown(
          db,
          params.data.id,
          body.data,
          { adminUserId },
          opts.deps,
          opts.mailer,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof TakedownError) return mapErr(reply, err);
        request.log.error({ err }, 'takedown fulfill failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  app.post(
    '/v1/admin/takedowns/:id/reject',
    { preHandler: app.requirePermission('admin:moderate') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = rejectBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const adminUserId = request.user?.id;
      if (!adminUserId) return reply.code(401).send({ error: 'unauthorized' });
      try {
        const result = await rejectTakedown(
          db,
          params.data.id,
          body.data,
          { adminUserId },
          opts.mailer,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof TakedownError) return mapErr(reply, err);
        request.log.error({ err }, 'takedown reject failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default adminTakedownRoutes;

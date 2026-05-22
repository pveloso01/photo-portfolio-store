// F3.11 — admin audit-log CSV export.
//
// POST /v1/admin/audit/export        — RBAC compliance:read_audit. Enqueues
//                                       (here: runs inline) and returns a job id.
// GET  /v1/admin/audit/export/:jobId — RBAC compliance:read_audit. Status +
//                                       signed download URL when ready.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../../lib/db.js';
import { createExport, getExportStatus, runExport } from '../../services/audit-export.js';

const exportBodySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    actorId: z.string().uuid().optional(),
    action: z.string().max(120).optional(),
    targetType: z.string().max(60).optional(),
    targetId: z.string().max(120).optional(),
  })
  .strict();

const jobParamSchema = z.object({ jobId: z.string().uuid() });

export interface AdminAuditExportOptions {
  db?: DbClient;
  // Run the export inline (default true). A future worker can set false and
  // process the pending row out of band.
  runInline?: boolean;
}

const adminAuditExportRoutes = async (
  app: FastifyInstance,
  opts: AdminAuditExportOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const runInline = opts.runInline ?? true;

  app.post(
    '/v1/admin/audit/export',
    { preHandler: app.requirePermission('compliance:read_audit') },
    async (request, reply) => {
      const body = exportBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
      }
      const adminUserId = request.user?.id;
      if (!adminUserId) return reply.code(401).send({ error: 'unauthorized' });

      const { jobId } = await createExport(db, body.data, { adminUserId });
      if (runInline) {
        try {
          await runExport(db, jobId);
        } catch (err) {
          request.log.error({ err, jobId }, 'audit export run failed');
        }
      }
      return reply.code(202).send({ jobId });
    },
  );

  app.get(
    '/v1/admin/audit/export/:jobId',
    { preHandler: app.requirePermission('compliance:read_audit') },
    async (request, reply) => {
      const params = jobParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const adminUserId = request.user?.id;
      if (!adminUserId) return reply.code(401).send({ error: 'unauthorized' });

      const status = await getExportStatus(db, params.data.jobId, { adminUserId });
      if (!status) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(status);
    },
  );
};

export default adminAuditExportRoutes;

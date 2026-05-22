// F3.1 — admin health view.
//
// GET /v1/admin/health — RBAC admin:moderate. Reports build SHA, process
// uptime, and a measured DB round-trip latency. queueDepth is null here: BullMQ
// queues live in apps/worker, not the API process, so the API cannot report
// queue depth without taking a worker/Redis dependency it otherwise avoids.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../../lib/audit.js';
import { db as defaultDb } from '../../lib/db.js';

const { auditLog } = schema.compliance.tables;

export interface AdminHealthOptions {
  db?: DbClient;
}

interface HealthView {
  buildSha: string;
  uptimeSeconds: number;
  queueDepth: number | null;
  dbLatencyMs: number;
}

const measureDbLatency = async (db: DbClient): Promise<number> => {
  const startedAt = performance.now();
  try {
    await db.select({ id: auditLog.id }).from(auditLog).limit(1);
    return Math.round((performance.now() - startedAt) * 100) / 100;
  } catch {
    return -1;
  }
};

const adminHealthRoutes = async (
  app: FastifyInstance,
  opts: AdminHealthOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get(
    '/v1/admin/health',
    { preHandler: app.requirePermission('admin:moderate') },
    async (request, reply) => {
      const dbLatencyMs = await measureDbLatency(db);
      const view: HealthView = {
        buildSha: process.env.BUILD_SHA ?? process.env.GIT_SHA ?? 'unknown',
        uptimeSeconds: Math.floor(process.uptime()),
        // Queue metrics require the worker process; the API does not hold a
        // BullMQ/Redis handle. Reported as null rather than fabricated.
        queueDepth: null,
        dbLatencyMs,
      };

      await writeAudit(db, {
        action: 'admin.health.viewed',
        actorKind: 'user',
        actorUserId: request.user?.id,
        targetKind: 'system',
      });

      return reply.code(200).send(view);
    },
  );
};

export default adminHealthRoutes;

// Bundle routes — F2.2 (bib bundle engine) and F2.3 (foto-flat product).
//
// POST /v1/events/:eventId/bundles  — organizer creates a bundle + product row.
//   RBAC: requires 'event:write' on the event resource.
//   NOTE: requirePermission wiring is registered as a preHandler only when
//   app.requirePermission is available (same pattern as routes/products.ts).
//   The main thread must wire the RBAC plugin before registering this plugin;
//   no further changes are needed here.
//
// POST /v1/bundles/:id/resolve      — public preview (anonymous-allowed).
// GET  /v1/events/:eventId/foto-flat — public summary (anonymous-allowed).

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Permission } from '../auth/permissions.js';
import { db as defaultDb } from '../lib/db.js';
import {
  BundleServiceError,
  FOTO_FLAT_MAX_PHOTOS,
  createBundle,
  getFotoFlatSummary,
  resolveBundle,
} from '../services/bundles.js';

// ---------- Schemas ----------

const uuidSchema = z.string().uuid();

const bundleKindSchema = z.enum(['bib', 'foto_flat', 'custom']);

const createBundleBodySchema = z
  .object({
    kind: bundleKindSchema,
    selector: z.record(z.unknown()).optional(),
    basePriceCents: z.number().int().min(1),
    currency: z.string().min(1).max(10),
    licenseTierId: uuidSchema,
    name: z.string().min(1).max(200).optional(),
    photoIds: z.array(uuidSchema).optional(),
  })
  .strict();

const eventIdParamsSchema = z.object({ eventId: uuidSchema });
const bundleIdParamsSchema = z.object({ id: uuidSchema });

// ---------- Error mapping ----------

const mapBundleError = (reply: FastifyReply, err: BundleServiceError): FastifyReply => {
  switch (err.code) {
    case 'bundle_not_found':
    case 'event_not_found':
      return reply.code(404).send({ error: 'not_found', message: err.message });
    case 'bundle_empty':
      return reply.code(409).send({ error: 'BUNDLE_EMPTY', message: err.message });
    case 'invalid_request':
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    default:
      return reply.code(500).send({ error: 'server_error' });
  }
};

// ---------- RBAC helper (mirrors products.ts) ----------

const requirePerm = (
  app: FastifyInstance,
  permission: Permission,
  resourceResolver?: (req: FastifyRequest) => { kind: 'event'; id: string } | undefined,
) => {
  if (typeof app.requirePermission === 'function') {
    return app.requirePermission(
      permission,
      resourceResolver ? { resource: resourceResolver } : {},
    );
  }
  return async (): Promise<void> => undefined;
};

// ---------- Plugin ----------

export interface BundleRoutesOptions {
  db?: DbClient;
}

const bundleRoutes = async (
  app: FastifyInstance,
  opts: BundleRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---- POST /v1/events/:eventId/bundles ----
  // Organizer action — requires event:write on the event resource.
  app.post(
    '/v1/events/:eventId/bundles',
    {
      preHandler: requirePerm(app, 'event:write', (req) => {
        const parsed = eventIdParamsSchema.safeParse(req.params);
        return parsed.success ? { kind: 'event', id: parsed.data.eventId } : undefined;
      }),
    },
    async (request, reply) => {
      const params = eventIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_request', message: 'invalid eventId' });
      }

      const body = createBundleBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          details: body.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }

      try {
        const result = await createBundle(db, {
          eventId: params.data.eventId,
          kind: body.data.kind,
          selector: body.data.selector,
          basePriceCents: body.data.basePriceCents,
          currency: body.data.currency,
          licenseTierId: body.data.licenseTierId,
          name: body.data.name,
          photoIds: body.data.photoIds,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof BundleServiceError) return mapBundleError(reply, err);
        request.log.error({ err }, 'bundle create failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );

  // ---- POST /v1/bundles/:id/resolve ----
  // Public preview — anonymous-allowed.
  app.post('/v1/bundles/:id/resolve', async (request, reply) => {
    const params = bundleIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'invalid bundle id' });
    }

    try {
      const resolution = await resolveBundle(db, params.data.id);
      return reply.code(200).send(resolution);
    } catch (err) {
      if (err instanceof BundleServiceError) return mapBundleError(reply, err);
      request.log.error({ err }, 'bundle resolve failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // ---- GET /v1/events/:eventId/foto-flat ----
  // Public — anonymous-allowed.
  app.get('/v1/events/:eventId/foto-flat', async (request, reply) => {
    const params = eventIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'invalid eventId' });
    }

    try {
      const summary = await getFotoFlatSummary(db, params.data.eventId);
      if (!summary) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'no foto-flat bundle for event' });
      }

      // Warn if photo count hit the cap so ops can detect large events.
      if (summary.photoCount >= FOTO_FLAT_MAX_PHOTOS) {
        request.log.warn(
          { eventId: params.data.eventId, photoCount: summary.photoCount },
          'foto-flat bundle reached FOTO_FLAT_MAX_PHOTOS cap; some photos may be excluded',
        );
      }

      return reply.code(200).send(summary);
    } catch (err) {
      if (err instanceof BundleServiceError) return mapBundleError(reply, err);
      request.log.error({ err }, 'foto-flat summary failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default bundleRoutes;

// F2.13 — Photographer self-service payout dashboard routes.
//
// All routes are scoped to the authenticated caller (request.user.id = their
// photographer user id). NOT RBAC-permission-gated — these are "me" routes
// where owner = authenticated user. The main server thread must add
// /v1/me/payouts/* to the RBAC exempt list.
//
// GET /v1/me/payouts/balance      — available + pending balance view
// GET /v1/me/payouts              — paginated payout history (cursor-based)
// GET /v1/me/payouts/:id          — payout detail with ledger entries by kind

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { getBalance, getPayoutDetail, listPayouts } from '../services/payout-dashboard.js';

// ---------- Query schemas ----------

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number.parseInt(v, 10) : undefined))
    .pipe(z.number().int().min(1).max(100).optional()),
});

const idParamSchema = z.object({ id: z.string().uuid() });

// ---------- Plugin options ----------

export interface MePayoutsOptions {
  db?: DbClient;
}

const mePayoutsRoutes = async (
  app: FastifyInstance,
  opts: MePayoutsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---------- GET /v1/me/payouts/balance ----------

  app.get('/v1/me/payouts/balance', async (request, reply) => {
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    try {
      const balance = await getBalance(db, request.user.id);
      return reply.code(200).send(balance);
    } catch (err) {
      request.log.error({ err }, 'me-payouts: getBalance failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // ---------- GET /v1/me/payouts ----------

  app.get('/v1/me/payouts', async (request, reply) => {
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: query.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    try {
      const result = await listPayouts(db, request.user.id, {
        cursor: query.data.cursor,
        limit: query.data.limit,
      });
      return reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, 'me-payouts: listPayouts failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // ---------- GET /v1/me/payouts/:id ----------

  app.get('/v1/me/payouts/:id', async (request, reply) => {
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
    }

    // Invalid UUID → 404 (not 400) to avoid leaking route existence.
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(404).send({ error: 'not_found' });
    }

    try {
      const detail = await getPayoutDetail(db, request.user.id, params.data.id);
      if (!detail) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(detail);
    } catch (err) {
      request.log.error({ err }, 'me-payouts: getPayoutDetail failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default mePayoutsRoutes;

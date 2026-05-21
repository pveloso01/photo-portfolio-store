// F2.12 — admin payout retry endpoint.
//
// POST /v1/admin/payouts/:id/retry  — RBAC admin:override.
// Re-attempts a FAILED payout transfer. 200 -> PayoutSummary.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../../lib/db.js';
import { PayoutError, type StripeTransferClient, retryPayout } from '../../services/payouts.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export interface AdminPayoutRetryOptions {
  db?: DbClient;
  stripe?: StripeTransferClient;
}

const adminPayoutRetryRoutes = async (
  app: FastifyInstance,
  opts: AdminPayoutRetryOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.post(
    '/v1/admin/payouts/:id/retry',
    { preHandler: app.requirePermission('admin:override') },
    async (request, reply) => {
      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(404).send({ error: 'not_found' });
      }

      try {
        const summary = await retryPayout(db, params.data.id, { stripe: opts.stripe });
        return reply.code(200).send(summary);
      } catch (err) {
        if (err instanceof PayoutError) {
          switch (err.code) {
            case 'not_found':
              return reply.code(404).send({ error: 'not_found', message: err.message });
            case 'not_failed':
              return reply.code(409).send({ error: 'not_failed', message: err.message });
            case 'no_stripe_account':
            case 'mismatch':
              return reply.code(422).send({ error: err.code, message: err.message });
            default:
              return reply.code(500).send({ error: 'server_error' });
          }
        }
        request.log.error({ err }, 'payout retry failed');
        return reply.code(500).send({ error: 'server_error' });
      }
    },
  );
};

export default adminPayoutRetryRoutes;

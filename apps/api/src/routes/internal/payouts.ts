// F2.12 — internal payout trigger endpoint.
//
// POST /v1/internal/payouts/run
//
// This route is EXEMPT from RBAC (machine-to-machine, secret-gated). The main
// thread adds /v1/internal/payouts/run to the RBAC exempt list alongside the
// me-kyc and me-payouts routes.
//
// Guard: x-internal-secret header must equal process.env.INTERNAL_CRON_SECRET.
// If the env var is unset/empty the route returns 503 (disabled) so the
// endpoint is safe to deploy before the secret is provisioned.
//
// Called by the worker's weekly payout cron rather than importing API code
// directly, keeping the worker free of API-layer dependencies.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';

import { db as defaultDb } from '../../lib/db.js';
import {
  type RunPayoutsResult,
  type StripeTransferClient,
  runPayouts,
} from '../../services/payouts.js';

export interface InternalPayoutsOptions {
  db?: DbClient;
  stripe?: StripeTransferClient;
}

const internalPayoutsRoutes = async (
  app: FastifyInstance,
  opts: InternalPayoutsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.post('/v1/internal/payouts/run', async (request, reply) => {
    const secret = process.env.INTERNAL_CRON_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: 'disabled' });
    }

    const provided = request.headers['x-internal-secret'];
    if (provided !== secret) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const result: RunPayoutsResult = await runPayouts(db, { stripe: opts.stripe });
    return reply.code(200).send({ result });
  });
};

export default internalPayoutsRoutes;

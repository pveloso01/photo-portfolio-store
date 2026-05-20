// Pricing HTTP routes.
//
// ANONYMOUS ACCESS: Both routes below are public and MUST NOT be RBAC-gated.
// Storefront pricing is needed before a buyer logs in. The main thread exempts
// /v1/pricing/* from authentication middleware.
//
//   GET  /v1/pricing/tiers    — license-tier multipliers for the storefront
//   POST /v1/pricing/evaluate — deterministic cart pricing with discount breakdown

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { PricingEvalError, evaluatePricing } from '../services/pricing-evaluator.js';
import { listTiers } from '../services/pricing-tiers.js';

// ---------- Schemas ----------

const listTiersQuerySchema = z.object({
  eventId: z.string().uuid().optional(),
});

const evalLineItemSchema = z.object({
  unitPriceCents: z.number().int().min(0),
  quantity: z.number().int().min(1),
  productId: z.string().uuid().optional(),
  bundleId: z.string().uuid().optional(),
  photoId: z.string().uuid().optional(),
  licenseTierId: z.string().uuid().optional(),
});

const evalContextSchema = z.object({
  eventId: z.string().uuid().optional(),
  buyerId: z.string().uuid().optional(),
  // ISO 8601 datetime string; converted to Date before passing to evaluatePricing.
  now: z.string().datetime().optional(),
});

const evaluateBodySchema = z.object({
  items: z.array(evalLineItemSchema).min(1),
  currency: z.string().min(1).max(10),
  context: evalContextSchema.optional(),
});

// ---------- Plugin options ----------

export interface PricingRoutesOptions {
  db?: DbClient;
}

// ---------- Plugin ----------

const pricingRoutes = async (
  app: FastifyInstance,
  opts: PricingRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---- GET /v1/pricing/tiers ----
  // Returns all license tiers with their resolved multipliers.
  // Optional ?eventId=<uuid> applies event-scoped pricing rules.
  app.get('/v1/pricing/tiers', async (request, reply) => {
    const query = listTiersQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        details: query.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    try {
      const tiers = await listTiers(db, { eventId: query.data.eventId });
      return reply.code(200).send({ tiers });
    } catch (err) {
      request.log.error({ err }, 'pricing tiers: failed to list tiers');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // ---- POST /v1/pricing/evaluate ----
  // Evaluates discount rules against a cart and returns an itemized breakdown.
  // Anonymous-allowed: buyers need price quotes before login.
  app.post('/v1/pricing/evaluate', async (request, reply) => {
    const body = evaluateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: body.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const { items, currency, context } = body.data;

    const ctx = {
      eventId: context?.eventId,
      buyerId: context?.buyerId,
      now: context?.now !== undefined ? new Date(context.now) : undefined,
    };

    try {
      const result = await evaluatePricing(db, items, ctx, currency);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof PricingEvalError) {
        return reply.code(400).send({ error: err.code, message: err.message });
      }
      request.log.error({ err }, 'pricing evaluate: unexpected error');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default pricingRoutes;

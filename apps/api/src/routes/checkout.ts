// Checkout HTTP route. POST /v1/cart/:cartId/checkout creates an order from a
// cart and returns a Stripe PaymentIntent client_secret the frontend can use
// to confirm the payment.
//
// Anonymous-allowed: carts are cookie-bound, not user-bound. When the request
// IS authenticated, request.user.id is recorded as buyerUserId on the order.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { writeAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import {
  CheckoutServiceError,
  type StripeClient,
  createOrderFromCart,
} from '../services/checkout.js';

// ---------- Schemas ----------

const uuidSchema = z.string().uuid();
const cartParamsSchema = z.object({ cartId: uuidSchema });
const checkoutBodySchema = z.object({ buyerEmail: z.string().email() }).strict();

// ---------- Error mapping ----------

const handleServiceError = (reply: FastifyReply, err: unknown): FastifyReply => {
  if (err instanceof CheckoutServiceError) {
    switch (err.code) {
      case 'not_found':
        return reply.code(404).send({ error: err.message });
      case 'expired':
        return reply.code(410).send({ error: err.message });
      case 'unprocessable':
        return reply.code(422).send({ error: err.message });
      case 'stripe_unavailable':
        return reply.code(503).send({ error: err.message });
      case 'invalid':
        return reply.code(500).send({ error: err.message });
    }
  }
  throw err;
};

// ---------- Plugin ----------

export interface CheckoutRoutesOptions {
  db?: DbClient;
  stripe?: StripeClient;
}

const checkoutRoutes = async (
  app: FastifyInstance,
  opts: CheckoutRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const stripe = opts.stripe;

  app.post('/v1/cart/:cartId/checkout', async (request, reply) => {
    const params = cartParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid cartId' });
    }
    const body = checkoutBodySchema.safeParse(request.body);
    if (!body.success) {
      await writeAudit(db, {
        action: 'checkout.denied',
        actorKind: request.user?.id ? 'user' : 'system',
        actorUserId: request.user?.id,
        targetKind: 'cart',
        targetId: params.data.cartId,
        payload: { reason: 'invalid_body', issues: body.error.issues },
      });
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }

    try {
      const result = stripe
        ? await createOrderFromCart(
            db,
            params.data.cartId,
            { buyerEmail: body.data.buyerEmail, buyerUserId: request.user?.id },
            stripe,
          )
        : await createOrderFromCart(db, params.data.cartId, {
            buyerEmail: body.data.buyerEmail,
            buyerUserId: request.user?.id,
          });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof CheckoutServiceError) {
        await writeAudit(db, {
          action: 'checkout.denied',
          actorKind: request.user?.id ? 'user' : 'system',
          actorUserId: request.user?.id,
          targetKind: 'cart',
          targetId: params.data.cartId,
          payload: { reason: err.code, message: err.message },
        });
      }
      return handleServiceError(reply, err);
    }
  });
};

export default checkoutRoutes;

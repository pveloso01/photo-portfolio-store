// F1.30 — Stripe webhook receiver.
//
// POST /v1/webhooks/stripe        anonymous (Stripe authenticates via signature)
//
// Stripe signs requests with the endpoint secret. We MUST verify against the
// raw body bytes — not a parsed/re-serialized object — so this route registers
// its own application/json content-type parser that returns a Buffer. That
// parser is route-scoped so it does not interfere with the JSON parsing every
// other route relies on.
//
// Response budget: Stripe retries any response slower than ~2s, so we keep
// the request handler thin (verify + insert + dispatch lightweight DB writes)
// and push heavy work (digital fulfillment, email) onto BullMQ via the
// fulfillment enqueuer wired into the service module.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';

import { db as defaultDb } from '../lib/db.js';
import { stripe, webhookSecret } from '../lib/stripe.js';
import { handleWebhookEvent } from '../services/stripe-webhook.js';

interface PluginOptions {
  db?: DbClient;
}

const webhooksStripeRoutes = async (
  app: FastifyInstance,
  opts: PluginOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // Buffer the raw JSON body for signature verification. Scoped to this
  // plugin so other routes keep their normal object body parser.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/v1/webhooks/stripe', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = req.body as Buffer;
    if (!Buffer.isBuffer(rawBody)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }

    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      // Production: missing signature is a hard reject.
      if (webhookSecret) {
        return reply.code(401).send({ error: 'missing_signature' });
      }
    }

    let event: Stripe.Event;
    if (webhookSecret) {
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature as string, webhookSecret);
      } catch (err) {
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'stripe webhook signature verification failed',
        );
        return reply.code(401).send({ error: 'invalid_signature' });
      }
    } else {
      // Dev/test mode without a configured secret: skip verification with a
      // loud warning. NEVER take this path in production — webhookSecret is
      // expected to be set in any deployed environment.
      req.log.warn(
        'STRIPE_WEBHOOK_SECRET not configured — accepting webhook without signature verification',
      );
      try {
        event = JSON.parse(rawBody.toString('utf8')) as Stripe.Event;
      } catch (err) {
        req.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'stripe webhook body not valid JSON',
        );
        return reply.code(400).send({ error: 'invalid_json' });
      }
    }

    try {
      const outcome = await handleWebhookEvent(db, event);
      return reply.code(200).send({
        received: true,
        idempotent: outcome.idempotent,
        result: outcome.result,
      });
    } catch (err) {
      req.log.error(
        { err: err instanceof Error ? err.message : String(err), eventId: event.id },
        'stripe webhook processing failed',
      );
      // Return 500 so Stripe retries. The event row stays unprocessed for
      // the retry sweep.
      return reply.code(500).send({ error: 'processing_failed' });
    }
  });
};

export default webhooksStripeRoutes;

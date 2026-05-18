// F1.30 — Stripe webhook event handler.
//
// Idempotency contract: every event flows through stripe_webhook_events whose
// PK is the Stripe event id. A replayed delivery is a duplicate insert and
// short-circuits before any side effects run. This is the only correct way
// to make webhooks idempotent — checking-then-inserting has a race window.
//
// Dispatch table:
//   payment_intent.succeeded      -> mark order paid, enqueue digital fulfillment, audit
//   payment_intent.payment_failed -> mark order failed, audit
//   charge.refunded               -> mark order refunded/partially_refunded, audit
//   (anything else)               -> result='ignored'
//
// The handler returns 200 to Stripe quickly; heavy work (digital fulfillment)
// is queued for an async worker rather than performed inline.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';

import { writeAudit } from '../lib/audit.js';

const { orders, stripeWebhookEvents } = schema.commerce.tables;

export type WebhookResult = 'success' | 'ignored' | 'error';

export interface WebhookOutcome {
  idempotent: boolean;
  result: WebhookResult;
}

// Pluggable queue. Real wiring in routes/webhooks-stripe.ts; tests replace via
// setFulfillmentEnqueuer. Keeping it injectable avoids pulling BullMQ into the
// test harness.
export interface FulfillmentJob {
  orderId: string;
}

export type FulfillmentEnqueuer = (job: FulfillmentJob) => Promise<void>;

let enqueueFulfillment: FulfillmentEnqueuer = async (job) => {
  // Default no-op stub. Production should call setFulfillmentEnqueuer at boot
  // to wire BullMQ `fulfillment:digital`.
  // eslint-disable-next-line no-console
  console.warn('[stripe-webhook] fulfillment enqueuer not configured', { orderId: job.orderId });
};

export const setFulfillmentEnqueuer = (fn: FulfillmentEnqueuer): void => {
  enqueueFulfillment = fn;
};

// Postgres unique_violation error code on PK conflict.
const PG_UNIQUE_VIOLATION = '23505';

const isDuplicateKeyError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === PG_UNIQUE_VIOLATION) return true;
  const message = (err as { message?: string }).message ?? '';
  return /duplicate key|unique constraint/i.test(message);
};

// ---------- Event-specific handlers ----------

const handlePaymentSucceeded = async (
  db: DbClient,
  event: Stripe.Event,
): Promise<WebhookResult> => {
  const pi = event.data.object as Stripe.PaymentIntent;
  const rows = (await db
    .select()
    .from(orders)
    .where(eq(orders.stripePaymentIntentId, pi.id))
    .limit(1)) as Array<{ id: string; status: string }>;

  if (rows.length === 0) {
    // No matching order. Could be a race with checkout, but more likely a
    // stale or unrelated event. Mark ignored so we don't retry forever.
    return 'ignored';
  }

  const order = rows[0];
  if (!order) return 'ignored';
  if (order.status === 'paid') {
    // Already processed — idempotent no-op. Still counts as success.
    return 'success';
  }

  const chargeId =
    typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null);

  await db
    .update(orders)
    .set({
      status: 'paid',
      paidAt: new Date(),
      stripeChargeId: chargeId,
      updatedAt: new Date(),
    })
    .where(and(eq(orders.id, order.id), eq(orders.status, 'pending_payment')));

  await enqueueFulfillment({ orderId: order.id });

  await writeAudit(db, {
    action: 'order.paid',
    actorKind: 'webhook',
    targetKind: 'order',
    targetId: order.id,
    payload: { stripeEventId: event.id, paymentIntentId: pi.id, chargeId },
  });

  return 'success';
};

const handlePaymentFailed = async (db: DbClient, event: Stripe.Event): Promise<WebhookResult> => {
  const pi = event.data.object as Stripe.PaymentIntent;
  const rows = (await db
    .select()
    .from(orders)
    .where(eq(orders.stripePaymentIntentId, pi.id))
    .limit(1)) as Array<{ id: string; status: string }>;

  const order = rows[0];
  if (!order) return 'ignored';
  if (order.status === 'failed') return 'success';

  await db
    .update(orders)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  await writeAudit(db, {
    action: 'order.payment_failed',
    actorKind: 'webhook',
    targetKind: 'order',
    targetId: order.id,
    payload: {
      stripeEventId: event.id,
      paymentIntentId: pi.id,
      lastPaymentError: pi.last_payment_error?.message ?? null,
    },
  });

  return 'success';
};

const handleChargeRefunded = async (db: DbClient, event: Stripe.Event): Promise<WebhookResult> => {
  const charge = event.data.object as Stripe.Charge;
  const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  if (!piId) return 'ignored';

  const rows = (await db
    .select()
    .from(orders)
    .where(eq(orders.stripePaymentIntentId, piId))
    .limit(1)) as Array<{ id: string; status: string; totalCents: number }>;

  const order = rows[0];
  if (!order) return 'ignored';
  const refundedAmount = charge.amount_refunded ?? 0;
  const fullyRefunded = refundedAmount >= order.totalCents;
  const nextStatus = fullyRefunded ? 'refunded' : 'partially_refunded';

  if (order.status === nextStatus) return 'success';

  await db
    .update(orders)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  await writeAudit(db, {
    action: 'order.refunded',
    actorKind: 'webhook',
    targetKind: 'order',
    targetId: order.id,
    payload: {
      stripeEventId: event.id,
      chargeId: charge.id,
      amountRefunded: refundedAmount,
      totalCents: order.totalCents,
      fullyRefunded,
    },
  });

  return 'success';
};

// ---------- Public entry ----------

export const handleWebhookEvent = async (
  db: DbClient,
  event: Stripe.Event,
): Promise<WebhookOutcome> => {
  // Step 1: insert the event row. Duplicate id => already processed.
  try {
    await db.insert(stripeWebhookEvents).values({
      id: event.id,
      type: event.type,
      payloadJsonb: event as unknown as Record<string, unknown>,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      return { idempotent: true, result: 'success' };
    }
    throw err;
  }

  // Step 2: dispatch. Wrap downstream work so a failure still flips the row
  // to 'error' and surfaces in the unprocessed index.
  let result: WebhookResult = 'ignored';
  let processingError: unknown = null;
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        result = await handlePaymentSucceeded(db, event);
        break;
      case 'payment_intent.payment_failed':
        result = await handlePaymentFailed(db, event);
        break;
      case 'charge.refunded':
        result = await handleChargeRefunded(db, event);
        break;
      default:
        result = 'ignored';
    }
  } catch (err) {
    processingError = err;
    result = 'error';
  }

  // Step 3: mark processed. Best-effort — never overwrite the original event row.
  try {
    await db
      .update(stripeWebhookEvents)
      .set({ processedAt: new Date(), result })
      .where(eq(stripeWebhookEvents.id, event.id));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe-webhook] failed to mark processed', {
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (processingError) throw processingError;

  return { idempotent: false, result };
};

// Re-export for tests that need to assert on the sql shape (avoids unused import warnings).
export const __internal = { sql };

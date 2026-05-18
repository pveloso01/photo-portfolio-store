// Checkout service. Converts an active cart into an order + Stripe
// PaymentIntent. M1 ships no tax (Stripe Tax is M2/M3). The order row is
// inserted in 'pending_payment' status BEFORE the Stripe API call so the
// orderId can be used as the Stripe idempotency_key — retries with the same
// cart hit the same PaymentIntent instead of double-charging.
//
// State transitions:
//   active cart → orders(pending_payment) → Stripe PI created
//                                         → orders.stripe_payment_intent_id set
//                                         → cart.status='converted'
//   On Stripe failure: order is marked 'failed' and the cart stays 'active'
//   so the buyer can retry without losing their basket.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import { writeAudit } from '../lib/audit.js';
import { stripe as defaultStripe } from '../lib/stripe.js';

const { carts, cartItems, orders, orderItems } = schema.commerce.tables;
const { products } = schema.catalog.tables;

// ---------- Types ----------

export interface CreateOrderInput {
  buyerEmail: string;
  buyerUserId?: string;
}

export interface CreateOrderResult {
  orderId: string;
  clientSecret: string;
  totalCents: number;
  currency: string;
}

// ---------- Errors ----------

export class CheckoutServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'expired'
      | 'unprocessable'
      | 'invalid'
      | 'stripe_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutServiceError';
  }
}

// ---------- Stripe injection ----------

// Resolved lazily so tests can vi.mock('../lib/stripe.js'). Direct named
// import is intentional — exposing a setter would widen the surface for the
// other Stripe agents that also depend on the singleton.
export type StripeClient = Pick<Stripe, 'paymentIntents'>;

// ---------- Operation ----------

export const createOrderFromCart = async (
  db: DbClient,
  cartId: string,
  input: CreateOrderInput,
  stripeClient: StripeClient = defaultStripe,
): Promise<CreateOrderResult> => {
  // 1. Load the cart, asserting active + not expired.
  const cartRows = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  const cart = cartRows[0];
  if (!cart) {
    throw new CheckoutServiceError('not_found', 'cart not found');
  }
  if (cart.status === 'converted') {
    // Idempotent re-checkout: return the existing PaymentIntent.
    const existing = await db.select().from(orders).where(eq(orders.cartId, cart.id)).limit(1);
    const order = existing[0];
    if (order?.stripePaymentIntentId) {
      const pi = await stripeClient.paymentIntents.retrieve(order.stripePaymentIntentId);
      const clientSecret = pi.client_secret;
      if (!clientSecret) {
        throw new CheckoutServiceError('invalid', 'existing payment intent has no client_secret');
      }
      return {
        orderId: order.id,
        clientSecret,
        totalCents: order.totalCents,
        currency: order.currency,
      };
    }
    throw new CheckoutServiceError('unprocessable', 'cart already converted');
  }
  if (cart.status !== 'active' || cart.expiresAt.getTime() <= Date.now()) {
    throw new CheckoutServiceError('expired', 'cart is no longer active');
  }

  // 2. Load items.
  const itemRows = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
  if (itemRows.length === 0) {
    throw new CheckoutServiceError('unprocessable', 'cart is empty');
  }

  // 3. Currency coherence guard. cart.currency was locked from the event at
  // creation; every line item should match. If it doesn't, the cart is
  // corrupted and Stripe would reject the mixed-currency intent anyway.
  for (const item of itemRows) {
    if (item.currency !== cart.currency) {
      throw new CheckoutServiceError('unprocessable', 'cart contains mixed currencies');
    }
  }

  // 4. Compute totals. M1: tax=0, total=subtotal.
  const subtotalCents = itemRows.reduce((sum, row) => sum + row.unitPriceCents * row.quantity, 0);
  const taxCents = 0;
  const totalCents = subtotalCents + taxCents;
  if (totalCents <= 0) {
    throw new CheckoutServiceError('unprocessable', 'cart total must be positive');
  }

  // 5. Insert the order in pending_payment. No PI id yet — we need orderId
  // first so it can serve as the Stripe idempotency_key.
  const insertedOrders = await db
    .insert(orders)
    .values({
      cartId: cart.id,
      eventId: cart.eventId,
      buyerEmail: input.buyerEmail,
      buyerUserId: input.buyerUserId ?? null,
      subtotalCents,
      taxCents,
      totalCents,
      currency: cart.currency,
      status: 'pending_payment',
    })
    .returning();
  const order = insertedOrders[0];
  if (!order) {
    throw new CheckoutServiceError('invalid', 'order insert returned no row');
  }

  // 6. Snapshot order_items. Pull product metadata for the immutable copy.
  for (const item of itemRows) {
    const productRows = await db
      .select()
      .from(products)
      .where(eq(products.id, item.productId))
      .limit(1);
    const product = productRows[0];
    const productMeta: Record<string, unknown> = product
      ? {
          sku: product.sku,
          name: product.name,
          kind: product.kind,
          config: product.configJsonb ?? {},
        }
      : {};
    await db.insert(orderItems).values({
      orderId: order.id,
      productId: item.productId,
      photoId: item.photoId ?? null,
      licenseTierId: item.licenseTierId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.unitPriceCents * item.quantity,
      currency: item.currency,
      metadataJsonb: { licenseTierId: item.licenseTierId, ...productMeta },
    });
  }

  await writeAudit(db, {
    action: 'order.created',
    actorKind: input.buyerUserId ? 'user' : 'system',
    actorUserId: input.buyerUserId,
    targetKind: 'order',
    targetId: order.id,
    eventId: cart.eventId,
    payload: {
      cartId: cart.id,
      subtotalCents,
      totalCents,
      currency: cart.currency,
      itemCount: itemRows.length,
    },
  });

  // 7. Create Stripe PaymentIntent. orderId is the idempotency key so a
  // retry with the same cart hits the same PI instead of double-charging.
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripeClient.paymentIntents.create(
      {
        amount: totalCents,
        currency: cart.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        receipt_email: input.buyerEmail,
        metadata: {
          orderId: order.id,
          eventId: cart.eventId,
          cartId: cart.id,
        },
      },
      { idempotencyKey: order.id },
    );
  } catch (err) {
    // 8a. Stripe failure: mark order failed; leave cart active for retry.
    await db
      .update(orders)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    await writeAudit(db, {
      action: 'checkout.intent_failed',
      actorKind: input.buyerUserId ? 'user' : 'system',
      actorUserId: input.buyerUserId,
      targetKind: 'order',
      targetId: order.id,
      eventId: cart.eventId,
      payload: {
        cartId: cart.id,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw new CheckoutServiceError('stripe_unavailable', 'failed to create payment intent');
  }

  const clientSecret = intent.client_secret;
  if (!clientSecret) {
    throw new CheckoutServiceError('invalid', 'payment intent has no client_secret');
  }

  // 8b. Stripe success: attach the PI to the order and mark cart converted.
  await db
    .update(orders)
    .set({ stripePaymentIntentId: intent.id, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
  await db
    .update(carts)
    .set({ status: 'converted', convertedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(carts.id, cart.id), eq(carts.status, 'active')));

  await writeAudit(db, {
    action: 'checkout.intent_created',
    actorKind: input.buyerUserId ? 'user' : 'system',
    actorUserId: input.buyerUserId,
    targetKind: 'order',
    targetId: order.id,
    eventId: cart.eventId,
    payload: {
      cartId: cart.id,
      stripePaymentIntentId: intent.id,
      totalCents,
      currency: cart.currency,
    },
  });

  return {
    orderId: order.id,
    clientSecret,
    totalCents,
    currency: cart.currency,
  };
};

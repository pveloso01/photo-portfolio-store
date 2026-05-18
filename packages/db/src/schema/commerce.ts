// Commerce context — carts, items, orders, order items, fulfillments.
// All tables in the Postgres `app` schema. Cross-context FKs stay as plain
// uuid columns; application code enforces.
//
// Snapshot pattern: order_items copy product/license data at order time so
// later product edits cannot retroactively change historical orders.

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// ---------- Enums ----------

export const cartStatus = app.enum('cart_status', ['active', 'converted', 'expired', 'abandoned']);

export const orderStatus = app.enum('order_status', [
  'pending_payment',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
]);

export const fulfillmentKind = app.enum('fulfillment_kind', ['digital_download', 'print']);

export const fulfillmentStatus = app.enum('fulfillment_status', [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);

// ---------- carts ----------
// Anonymous cookie-bound carts. The anonymous_token is set in an HTTP-only
// cookie and is the only client identifier. On login mid-session the cart
// is converted by populating user_id. A cart is scoped to a single event
// for the MVP (currency locked from event at creation).

export const carts = app.table(
  'carts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // Set in HTTP-only cookie; the only client identifier for guest carts.
    anonymousToken: text('anonymous_token').notNull().unique(),
    // refs users.id — cross-context, no FK. Populated on login mid-session.
    userId: uuid('user_id'),
    // refs events.id — cross-context, no FK. One cart is scoped to one event.
    eventId: uuid('event_id').notNull(),
    // Locked from the event at cart creation time.
    currency: text('currency').notNull(),
    status: cartStatus('status').notNull().default('active'),
    // Cart TTL, e.g. 7 days from creation.
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    // Set when an order is placed from this cart.
    convertedAt: timestamp('converted_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // updated_at: application or future trigger responsibility.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    eventStatusIdx: index('carts_event_status_idx').on(table.eventId, table.status),
    // GC sweep: find expired carts to mark abandoned/expired.
    gcIdx: index('carts_gc_idx').on(table.status, table.expiresAt),
  }),
);

// ---------- cart_items ----------

export const cartItems = app.table(
  'cart_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    // refs products.id — cross-context, no FK.
    productId: uuid('product_id').notNull(),
    // refs photos.id — cross-context, no FK. Set for digital_single products.
    photoId: uuid('photo_id'),
    // refs license_tiers.id — cross-context, no FK.
    licenseTierId: uuid('license_tier_id').notNull(),
    quantity: integer('quantity').notNull().default(1),
    // Snapshot from product at add-to-cart time.
    unitPriceCents: integer('unit_price_cents').notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Prevent duplicate lines; the application bumps quantity instead.
    cartLineIdx: uniqueIndex('cart_items_cart_line_idx').on(
      table.cartId,
      table.productId,
      table.photoId,
      table.licenseTierId,
    ),
    qtyPositive: check('cart_items_quantity_positive', sql`${table.quantity} > 0`),
  }),
);

// ---------- orders ----------
// One order per cart. Stripe identifiers are filled in by F1.29/F1.30.

export const orders = app.table(
  'orders',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // Same-file FK; unique enforces "one order per cart".
    cartId: uuid('cart_id')
      .notNull()
      .unique()
      .references(() => carts.id),
    // refs events.id — cross-context, no FK. Denormalized for fast lookup.
    eventId: uuid('event_id').notNull(),
    buyerEmail: text('buyer_email').notNull(),
    // refs users.id — cross-context, no FK. Null for guest checkout.
    buyerUserId: uuid('buyer_user_id'),
    subtotalCents: integer('subtotal_cents').notNull(),
    taxCents: integer('tax_cents').notNull().default(0),
    // = subtotal + tax. Application enforces.
    totalCents: integer('total_cents').notNull(),
    currency: text('currency').notNull(),
    // Set after PaymentIntent creation (F1.29). Unique enables idempotent
    // webhook reconciliation (F1.30).
    stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
    // Set on charge.succeeded webhook (F1.30).
    stripeChargeId: text('stripe_charge_id'),
    status: orderStatus('status').notNull().default('pending_payment'),
    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    paidAt: timestamp('paid_at', { withTimezone: true, mode: 'date' }),
    // updated_at: application or future trigger responsibility.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    eventStatusPlacedIdx: index('orders_event_status_placed_idx').on(
      table.eventId,
      table.status,
      table.placedAt,
    ),
    // "My orders" lookup by buyer email.
    buyerEmailPlacedIdx: index('orders_buyer_email_placed_idx').on(
      table.buyerEmail,
      table.placedAt,
    ),
    // Webhook reconciliation lookup (already unique; named for clarity).
    stripePaymentIntentIdx: index('orders_stripe_payment_intent_idx').on(
      table.stripePaymentIntentId,
    ),
  }),
);

// ---------- order_items ----------
// Immutable snapshot of cart items at order time. Later product edits MUST
// NOT change historical line data — that is the entire point of this table.

export const orderItems = app.table(
  'order_items',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // refs products.id — cross-context, no FK. Snapshot reference only.
    productId: uuid('product_id').notNull(),
    // refs photos.id — cross-context, no FK.
    photoId: uuid('photo_id'),
    // refs license_tiers.id — cross-context, no FK.
    licenseTierId: uuid('license_tier_id').notNull(),
    quantity: integer('quantity').notNull(),
    // Frozen at order time.
    unitPriceCents: integer('unit_price_cents').notNull(),
    // = quantity * unit_price_cents. Application enforces.
    lineTotalCents: integer('line_total_cents').notNull(),
    currency: text('currency').notNull(),
    // Snapshot of print size, license terms, etc. at order time.
    metadataJsonb: jsonb('metadata_jsonb').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    orderIdx: index('order_items_order_idx').on(table.orderId),
    // "Who bought this photo" reporting. Partial index keeps it lean.
    photoIdx: index('order_items_photo_idx')
      .on(table.photoId)
      .where(sql`${table.photoId} is not null`),
  }),
);

// ---------- fulfillments ----------
// One fulfillment per (order, kind) grouping. M1 ships digital only; print
// columns are reserved for M4 lab integration.

export const fulfillments = app.table(
  'fulfillments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    kind: fulfillmentKind('kind').notNull(),
    status: fulfillmentStatus('status').notNull().default('pending'),
    // Signed URL token for digital downloads (F1.31). Null for prints.
    downloadToken: text('download_token').unique(),
    downloadExpiresAt: timestamp('download_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // Set by M4 print lab integration, e.g. 'bay_photo'.
    labPartner: text('lab_partner'),
    labExternalId: text('lab_external_id'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    payloadJsonb: jsonb('payload_jsonb').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // updated_at: application or future trigger responsibility.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    orderKindIdx: index('fulfillments_order_kind_idx').on(table.orderId, table.kind),
    // Token lookup for download endpoint; partial keeps it lean.
    downloadTokenIdx: index('fulfillments_download_token_idx')
      .on(table.downloadToken)
      .where(sql`${table.downloadToken} is not null`),
  }),
);

// ---------- stripe_webhook_events ----------
// Append-only log of received Stripe webhook events. The Stripe event id is
// used as the natural primary key so a replayed delivery is a duplicate
// insert — idempotency falls out of the schema instead of requiring a
// separate lookup-then-insert race window. Processing pipeline:
//   1. INSERT row (id, type, payload). Conflict => already seen, return.
//   2. Dispatch downstream side effects.
//   3. UPDATE processed_at + result ('success' | 'ignored' | 'error').

export const stripeWebhookEvents = app.table(
  'stripe_webhook_events',
  {
    // Stripe event id (evt_*). Natural PK gives idempotency for free.
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    payloadJsonb: jsonb('payload_jsonb').notNull(),
    // 'success' | 'ignored' | 'error'. Null while still processing.
    result: text('result'),
  },
  (table) => ({
    typeIdx: index('stripe_webhook_events_type_idx').on(table.type, table.receivedAt),
    // Worker sweep: find rows that crashed mid-processing.
    unprocessedIdx: index('stripe_webhook_events_unprocessed_idx')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} is null`),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  carts,
  cartItems,
  orders,
  orderItems,
  fulfillments,
  stripeWebhookEvents,
};

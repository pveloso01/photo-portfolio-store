// Carts service layer. Pure functions over the DbClient — no Fastify or HTTP
// concerns leak in here. Carts are anonymous-first: the first POST creates a
// cart and returns a 32-byte random hex token bound to an HTTP-only cookie at
// the route layer. Subsequent requests read the cookie. A cart is scoped to a
// single event (currency locked from event at creation).
//
// Cross-context validation (product belongs to cart's event, photo is ready)
// IS enforced here because those invariants are semantic, not authorization.

import { randomBytes } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, sql } from 'drizzle-orm';

const { carts, cartItems } = schema.commerce.tables;
const { products } = schema.catalog.tables;
const { photos } = schema.photos.tables;
const { events } = schema.events.tables;
const { auditLog } = schema.compliance.tables;

// ---------- Types ----------

export type CartStatus = 'active' | 'converted' | 'expired' | 'abandoned';

export interface CreateCartInput {
  eventId: string;
}

export interface CreateCartResult {
  id: string;
  anonymousToken: string;
  eventId: string;
  currency: string;
  status: CartStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartItemRow {
  id: string;
  cartId: string;
  productId: string;
  photoId: string | null;
  licenseTierId: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
  createdAt: Date;
}

export interface CartWithItems {
  cart: typeof carts.$inferSelect;
  items: CartItemRow[];
}

export interface AddCartItemInput {
  productId: string;
  photoId?: string | null;
  licenseTierId: string;
  quantity?: number;
}

// ---------- Errors ----------

export class CartServiceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'expired' | 'invalid' | 'unprocessable' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'CartServiceError';
  }
}

// ---------- Constants ----------

// 7-day TTL for anonymous carts.
export const CART_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- Helpers ----------

const generateAnonymousToken = (): string => {
  // 32 bytes -> 64 hex chars. Plenty of entropy and url-safe.
  return randomBytes(32).toString('hex');
};

const writeAudit = async (
  db: DbClient,
  args: {
    action: string;
    cartId: string;
    eventId?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> => {
  // Anonymous carts have no actor user. The audit row still goes in; actorKind
  // is 'system' until login-merge populates buyerUserId.
  await db.insert(auditLog).values({
    actorUserId: null,
    actorKind: 'system',
    action: args.action,
    targetKind: 'cart',
    targetId: args.cartId,
    eventId: args.eventId ?? null,
    payloadJsonb: args.payload ?? null,
  });
};

const findCartByIdOrToken = async (
  db: DbClient,
  cartIdOrToken: string,
): Promise<typeof carts.$inferSelect | null> => {
  // The token (64-hex) is never a UUID, so we try id first, then token. Both
  // paths short-circuit on the first match — there is no overlap by length.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    cartIdOrToken,
  );
  if (isUuid) {
    const rows = await db.select().from(carts).where(eq(carts.id, cartIdOrToken)).limit(1);
    if (rows[0]) return rows[0];
  }
  const rows = await db
    .select()
    .from(carts)
    .where(eq(carts.anonymousToken, cartIdOrToken))
    .limit(1);
  return rows[0] ?? null;
};

const fetchCartItems = async (db: DbClient, cartId: string): Promise<CartItemRow[]> => {
  const rows = await db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
  return rows.map((r) => ({
    id: r.id,
    cartId: r.cartId,
    productId: r.productId,
    photoId: r.photoId ?? null,
    licenseTierId: r.licenseTierId,
    quantity: r.quantity,
    unitPriceCents: r.unitPriceCents,
    currency: r.currency,
    createdAt: r.createdAt,
  }));
};

const touchCart = async (db: DbClient, cartId: string): Promise<void> => {
  await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
};

// Returns the cart row if status='active' AND expiresAt > now. Otherwise marks
// it 'expired' (if not already converted/abandoned) and throws expired.
const requireActiveCart = async (
  db: DbClient,
  cartId: string,
): Promise<typeof carts.$inferSelect> => {
  const rows = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  const cart = rows[0];
  if (!cart) {
    throw new CartServiceError('not_found', 'cart not found');
  }
  const now = Date.now();
  const isExpired = cart.expiresAt.getTime() <= now;
  if (cart.status !== 'active' || isExpired) {
    if (cart.status === 'active' && isExpired) {
      await db
        .update(carts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(carts.id, cart.id));
    }
    throw new CartServiceError('expired', 'cart is no longer active');
  }
  return cart;
};

// ---------- Operations ----------

export const createCart = async (
  db: DbClient,
  input: CreateCartInput,
): Promise<CreateCartResult> => {
  // Pull currency from the event so cart_items snapshots stay coherent.
  const eventRows = await db
    .select({ id: events.id, currency: events.currency, status: events.status })
    .from(events)
    .where(eq(events.id, input.eventId))
    .limit(1);
  const event = eventRows[0];
  if (!event) {
    throw new CartServiceError('unprocessable', 'event not found');
  }

  const token = generateAnonymousToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CART_TTL_MS);

  const inserted = await db
    .insert(carts)
    .values({
      anonymousToken: token,
      eventId: input.eventId,
      currency: event.currency,
      status: 'active',
      expiresAt,
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new CartServiceError('invalid', 'insert returned no row');
  }

  await writeAudit(db, {
    action: 'cart.created',
    cartId: row.id,
    eventId: row.eventId,
    payload: { eventId: row.eventId, currency: row.currency },
  });

  return {
    id: row.id,
    anonymousToken: token,
    eventId: row.eventId,
    currency: row.currency,
    status: row.status as CartStatus,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export const getCart = async (db: DbClient, cartIdOrToken: string): Promise<CartWithItems> => {
  const cart = await findCartByIdOrToken(db, cartIdOrToken);
  if (!cart) {
    throw new CartServiceError('not_found', 'cart not found');
  }
  const now = Date.now();
  if (cart.status !== 'active' || cart.expiresAt.getTime() <= now) {
    if (cart.status === 'active' && cart.expiresAt.getTime() <= now) {
      await db
        .update(carts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(carts.id, cart.id));
    }
    throw new CartServiceError('expired', 'cart is no longer active');
  }
  const items = await fetchCartItems(db, cart.id);
  return { cart, items };
};

// Validates product existence + active + same-event scope, validates photo if
// provided (must exist and be 'ready'), then upserts a cart_items row.
// Duplicate (product, photo, license) triplets bump quantity instead of
// inserting a new row.
export const addCartItem = async (
  db: DbClient,
  cartId: string,
  input: AddCartItemInput,
): Promise<CartItemRow> => {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new CartServiceError('unprocessable', 'quantity must be a positive integer');
  }

  const cart = await requireActiveCart(db, cartId);

  // Validate product
  const productRows = await db
    .select()
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  const product = productRows[0];
  if (!product) {
    throw new CartServiceError('unprocessable', 'product not found');
  }
  if (!product.active) {
    throw new CartServiceError('unprocessable', 'product is not active');
  }
  if (product.eventId !== cart.eventId) {
    throw new CartServiceError('unprocessable', 'product does not belong to the cart event');
  }
  if (product.licenseTierId !== input.licenseTierId) {
    throw new CartServiceError('unprocessable', 'license tier does not match product license tier');
  }

  // Validate photo if provided
  const photoId = input.photoId ?? null;
  if (photoId) {
    const photoRows = await db
      .select({ id: photos.id, eventId: photos.eventId, status: photos.status })
      .from(photos)
      .where(eq(photos.id, photoId))
      .limit(1);
    const photo = photoRows[0];
    if (!photo) {
      throw new CartServiceError('unprocessable', 'photo not found');
    }
    if (photo.status !== 'ready') {
      throw new CartServiceError('unprocessable', 'photo is not ready');
    }
    if (photo.eventId !== cart.eventId) {
      throw new CartServiceError('unprocessable', 'photo does not belong to the cart event');
    }
  }

  // Bump quantity on duplicate triplet (cart, product, photo, licenseTier).
  // Drizzle eq does not natively handle nullable equality; we look up
  // existing rows and filter in app code for photoId match (including null).
  const existing = await db
    .select()
    .from(cartItems)
    .where(
      and(
        eq(cartItems.cartId, cart.id),
        eq(cartItems.productId, input.productId),
        eq(cartItems.licenseTierId, input.licenseTierId),
      ),
    );
  const dup = existing.find((r) => (r.photoId ?? null) === photoId);
  if (dup) {
    const updated = await db
      .update(cartItems)
      .set({ quantity: dup.quantity + quantity })
      .where(eq(cartItems.id, dup.id))
      .returning();
    const next = updated[0];
    if (!next) {
      throw new CartServiceError('invalid', 'update returned no row');
    }
    await touchCart(db, cart.id);
    await writeAudit(db, {
      action: 'cart.item.added',
      cartId: cart.id,
      eventId: cart.eventId,
      payload: {
        cartItemId: next.id,
        productId: input.productId,
        photoId,
        licenseTierId: input.licenseTierId,
        quantityDelta: quantity,
        quantity: next.quantity,
        deduped: true,
      },
    });
    return {
      id: next.id,
      cartId: next.cartId,
      productId: next.productId,
      photoId: next.photoId ?? null,
      licenseTierId: next.licenseTierId,
      quantity: next.quantity,
      unitPriceCents: next.unitPriceCents,
      currency: next.currency,
      createdAt: next.createdAt,
    };
  }

  const inserted = await db
    .insert(cartItems)
    .values({
      cartId: cart.id,
      productId: input.productId,
      photoId,
      licenseTierId: input.licenseTierId,
      quantity,
      unitPriceCents: product.priceCents,
      currency: product.currency,
    })
    .returning();

  const row = inserted[0];
  if (!row) {
    throw new CartServiceError('invalid', 'insert returned no row');
  }

  await touchCart(db, cart.id);
  await writeAudit(db, {
    action: 'cart.item.added',
    cartId: cart.id,
    eventId: cart.eventId,
    payload: {
      cartItemId: row.id,
      productId: row.productId,
      photoId: row.photoId,
      licenseTierId: row.licenseTierId,
      quantity: row.quantity,
      unitPriceCents: row.unitPriceCents,
    },
  });

  return {
    id: row.id,
    cartId: row.cartId,
    productId: row.productId,
    photoId: row.photoId ?? null,
    licenseTierId: row.licenseTierId,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    currency: row.currency,
    createdAt: row.createdAt,
  };
};

export const updateCartItem = async (
  db: DbClient,
  cartItemId: string,
  patch: { quantity: number },
): Promise<CartItemRow> => {
  if (!Number.isInteger(patch.quantity) || patch.quantity < 1) {
    throw new CartServiceError('unprocessable', 'quantity must be a positive integer');
  }

  const rows = await db.select().from(cartItems).where(eq(cartItems.id, cartItemId)).limit(1);
  const current = rows[0];
  if (!current) {
    throw new CartServiceError('not_found', 'cart item not found');
  }
  await requireActiveCart(db, current.cartId);

  const updated = await db
    .update(cartItems)
    .set({ quantity: patch.quantity })
    .where(eq(cartItems.id, cartItemId))
    .returning();
  const next = updated[0];
  if (!next) {
    throw new CartServiceError('not_found', 'cart item vanished mid-update');
  }
  await touchCart(db, current.cartId);
  await writeAudit(db, {
    action: 'cart.item.updated',
    cartId: current.cartId,
    payload: { cartItemId, quantity: next.quantity },
  });
  return {
    id: next.id,
    cartId: next.cartId,
    productId: next.productId,
    photoId: next.photoId ?? null,
    licenseTierId: next.licenseTierId,
    quantity: next.quantity,
    unitPriceCents: next.unitPriceCents,
    currency: next.currency,
    createdAt: next.createdAt,
  };
};

export const removeCartItem = async (db: DbClient, cartItemId: string): Promise<void> => {
  const rows = await db.select().from(cartItems).where(eq(cartItems.id, cartItemId)).limit(1);
  const current = rows[0];
  if (!current) {
    throw new CartServiceError('not_found', 'cart item not found');
  }
  await requireActiveCart(db, current.cartId);

  const deleted = await db
    .delete(cartItems)
    .where(eq(cartItems.id, cartItemId))
    .returning({ id: cartItems.id });
  if (deleted.length === 0) {
    throw new CartServiceError('not_found', 'cart item vanished mid-delete');
  }
  await touchCart(db, current.cartId);
  await writeAudit(db, {
    action: 'cart.item.removed',
    cartId: current.cartId,
    payload: { cartItemId },
  });
};

// Marker: keep sql import alive for future query expansion.
void sql;

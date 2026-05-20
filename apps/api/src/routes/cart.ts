// Cart HTTP routes. Anonymous-first: the cookie `pps_cart` is the only client
// identifier. The first POST /v1/cart creates a cart and sets the cookie;
// subsequent requests read it. No auth is required — RBAC plugins MUST NOT
// gate these endpoints.
//
// Cookie shape:
//   name:     pps_cart
//   value:    32-byte hex anonymous token
//   path:     /
//   httpOnly: true
//   secure:   true in production, false in dev/test
//   sameSite: 'lax'
//   maxAge:   7 days (matches CART_TTL_MS)
//
// On login mid-session (M2) a future endpoint will swap this anonymous cart
// for a user-bound one. M1 leaves user_id null on the cart row.
//
// We read/write cookies directly off the raw headers rather than depending on
// @fastify/cookie for two reasons: (a) the route is dependency-light, (b)
// tests can run without installing the plugin. If @fastify/cookie is also
// registered upstream its decorators continue to work — we simply do not rely
// on them here.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import {
  CART_TTL_MS,
  CartServiceError,
  addBundleToCart,
  addCartItem,
  createCart,
  getCart,
  removeCartItem,
  updateCartItem,
} from '../services/carts.js';

// ---------- Constants ----------

const COOKIE_NAME = 'pps_cart';
const COOKIE_MAX_AGE_SECONDS = Math.floor(CART_TTL_MS / 1000);

// ---------- Schemas ----------

const uuidSchema = z.string().uuid();

const createCartBodySchema = z.object({ eventId: uuidSchema }).strict();

// Discriminated union: either a single-photo product OR a bundle.
const addItemProductSchema = z
  .object({
    productId: uuidSchema,
    photoId: uuidSchema.optional(),
    licenseTierId: uuidSchema,
    quantity: z.number().int().min(1).max(999).optional(),
  })
  .strict();

const addItemBundleSchema = z
  .object({
    bundleId: uuidSchema,
    quantity: z.number().int().min(1).max(999).optional(),
  })
  .strict();

const addItemBodySchema = addItemProductSchema.or(addItemBundleSchema);

const patchItemBodySchema = z.object({ quantity: z.number().int() }).strict();

const itemIdParamsSchema = z.object({ itemId: uuidSchema });

// ---------- Cookie helpers ----------

const isSecureCookie = (): boolean => process.env.NODE_ENV === 'production';

// Minimal RFC 6265 cookie header parser. We only need to extract a single
// known cookie value; full attribute parsing is not required for reads.
const parseCookieHeader = (header: string | undefined): Record<string, string> => {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
};

const readCartToken = (request: FastifyRequest): string | undefined => {
  // Prefer @fastify/cookie's parsed cookies if present, otherwise read raw.
  const decorated = (
    request as FastifyRequest & {
      cookies?: Record<string, string | undefined>;
    }
  ).cookies;
  const raw = decorated?.[COOKIE_NAME] ?? parseCookieHeader(request.headers.cookie)[COOKIE_NAME];
  if (!raw) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(raw)) return undefined;
  return raw;
};

const buildCookie = (
  value: string,
  opts: { maxAge: number; secure: boolean; clear?: boolean } = {
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: isSecureCookie(),
  },
): string => {
  const segments = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAge}`,
  ];
  if (opts.clear) {
    segments.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (opts.secure) {
    segments.push('Secure');
  }
  return segments.join('; ');
};

const setCartCookie = (reply: FastifyReply, token: string): void => {
  reply.header(
    'Set-Cookie',
    buildCookie(token, {
      maxAge: COOKIE_MAX_AGE_SECONDS,
      secure: isSecureCookie(),
    }),
  );
};

const clearCartCookie = (reply: FastifyReply): void => {
  reply.header('Set-Cookie', buildCookie('', { maxAge: 0, secure: isSecureCookie(), clear: true }));
};

// ---------- Service error mapping ----------

const handleServiceError = (reply: FastifyReply, err: unknown): FastifyReply => {
  if (err instanceof CartServiceError) {
    switch (err.code) {
      case 'not_found':
        return reply.code(404).send({ error: err.message });
      case 'expired':
        return reply.code(410).send({ error: err.message });
      case 'unprocessable':
        return reply.code(422).send({ error: err.message });
      case 'conflict':
        return reply.code(409).send({ error: err.message });
      case 'invalid':
        return reply.code(400).send({ error: err.message });
    }
  }
  throw err;
};

// ---------- Plugin ----------

export interface CartRoutesOptions {
  db?: DbClient;
}

const cartRoutes = async (app: FastifyInstance, opts: CartRoutesOptions = {}): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // ---- POST /v1/cart ----
  app.post('/v1/cart', async (request, reply) => {
    const body = createCartBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    try {
      const created = await createCart(db, { eventId: body.data.eventId });
      setCartCookie(reply, created.anonymousToken);
      return reply.code(201).send({
        cart: {
          id: created.id,
          eventId: created.eventId,
          currency: created.currency,
          status: created.status,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      });
    } catch (err) {
      return handleServiceError(reply, err);
    }
  });

  // ---- GET /v1/cart ----
  app.get('/v1/cart', async (request, reply) => {
    const token = readCartToken(request);
    if (!token) {
      return reply.code(404).send({ error: 'cart not found' });
    }
    try {
      const result = await getCart(db, token);
      return reply.send({ cart: result.cart, items: result.items });
    } catch (err) {
      if (err instanceof CartServiceError) {
        if (err.code === 'not_found') {
          clearCartCookie(reply);
          return reply.code(404).send({ error: err.message });
        }
        if (err.code === 'expired') {
          clearCartCookie(reply);
          return reply.code(410).send({ error: err.message });
        }
      }
      return handleServiceError(reply, err);
    }
  });

  // ---- POST /v1/cart/items ----
  app.post('/v1/cart/items', async (request, reply) => {
    const token = readCartToken(request);
    if (!token) {
      return reply.code(404).send({ error: 'cart not found' });
    }
    const body = addItemBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    try {
      const resolved = await getCart(db, token);

      if ('bundleId' in body.data) {
        // Bundle path.
        await addBundleToCart(db, resolved.cart.id, {
          bundleId: body.data.bundleId,
          quantity: body.data.quantity,
        });
      } else {
        // Single-photo product path.
        await addCartItem(db, resolved.cart.id, {
          productId: body.data.productId,
          photoId: body.data.photoId,
          licenseTierId: body.data.licenseTierId,
          quantity: body.data.quantity,
        });
      }

      const fresh = await getCart(db, token);
      return reply.code(201).send({ cart: fresh.cart, items: fresh.items });
    } catch (err) {
      if (err instanceof CartServiceError) {
        if (err.code === 'expired') {
          clearCartCookie(reply);
          return reply.code(410).send({ error: err.message });
        }
        if (err.code === 'not_found') {
          clearCartCookie(reply);
          return reply.code(404).send({ error: err.message });
        }
        if (err.code === 'conflict') {
          return reply.code(409).send({ error: 'BUNDLE_EMPTY', message: err.message });
        }
      }
      return handleServiceError(reply, err);
    }
  });

  // ---- PATCH /v1/cart/items/:itemId ----
  app.patch('/v1/cart/items/:itemId', async (request, reply) => {
    const token = readCartToken(request);
    if (!token) {
      return reply.code(404).send({ error: 'cart not found' });
    }
    const params = itemIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid itemId' });
    }
    const body = patchItemBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    if (body.data.quantity < 1) {
      return reply.code(422).send({ error: 'quantity must be a positive integer' });
    }
    try {
      await updateCartItem(db, params.data.itemId, { quantity: body.data.quantity });
      const fresh = await getCart(db, token);
      return reply.send({ cart: fresh.cart, items: fresh.items });
    } catch (err) {
      return handleServiceError(reply, err);
    }
  });

  // ---- DELETE /v1/cart/items/:itemId ----
  app.delete('/v1/cart/items/:itemId', async (request, reply) => {
    const token = readCartToken(request);
    if (!token) {
      return reply.code(404).send({ error: 'cart not found' });
    }
    const params = itemIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid itemId' });
    }
    try {
      await removeCartItem(db, params.data.itemId);
      return reply.code(204).send();
    } catch (err) {
      return handleServiceError(reply, err);
    }
  });
};

export default cartRoutes;

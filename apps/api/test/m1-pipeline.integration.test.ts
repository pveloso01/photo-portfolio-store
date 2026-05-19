// F1.37 — M1 happy-path integration test against real Postgres + MinIO via
// testcontainers, exercising the production buildServer() composition root.
//
// This is the spiritual successor to integration.test.ts. It boots the same
// Fastify app the api binary boots, runs:
//   - /health
//   - /v1/auth/register -> login (real argon2, real JWT)
//   - cart create + item add (real cookie + real cart_items insert)
// then asserts the audit_log captured the canonical actions.
//
// Stripe and Qdrant remain mocked at the SDK level (Stripe needs a real
// account; Qdrant container is heavier than worthwhile). Inference is mocked
// at the HTTP boundary. Everything else hits real services.

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';

vi.mock('stripe', () => {
  class StripeMock {
    public paymentIntents = {
      create: vi.fn().mockResolvedValue({
        id: 'pi_test_1',
        client_secret: 'pi_test_1_secret_xyz',
      }),
      retrieve: vi.fn(),
    };
    public webhooks = {
      constructEvent: vi.fn((body: Buffer) => JSON.parse(body.toString('utf8'))),
    };
  }
  return { default: StripeMock };
});

const { users, organizations } = schema.users.tables;
const { events } = schema.events.tables;
const { photos } = schema.photos.tables;
const { products, licenseTiers } = schema.catalog.tables;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '99999999-9999-4999-8999-999999999991';
const PHOTO_ID = '99999999-9999-4999-8999-999999999992';
const PHOTOG_ID = '99999999-9999-4999-8999-999999999993';
const TIER_ID = '99999999-9999-4999-8999-999999999994';
const PRODUCT_ID = '99999999-9999-4999-8999-999999999995';

describe('M1 pipeline — buildServer() against real Postgres + MinIO', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('integration globalSetup did not set DATABASE_URL');
    db = createDbClient(url);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.execute(sql`
      TRUNCATE TABLE
        app.cart_items,
        app.carts,
        app.products,
        app.license_tiers,
        app.photo_derivatives,
        app.photos,
        app.event_settings,
        app.events,
        app.organization_members,
        app.organizations,
        app.sessions,
        app.users,
        app.audit_log
      RESTART IDENTITY CASCADE
    `);

    // Seed photographer, org, event, photo, tier, product.
    await db.insert(users).values({
      id: PHOTOG_ID,
      email: 'photog@test.invalid',
      role: 'photographer',
      status: 'active',
    });
    await db.insert(organizations).values({
      id: ORG_ID,
      name: 'Org',
      slug: 'org',
      ownerUserId: PHOTOG_ID,
    });
    await db.insert(events).values({
      id: EVENT_ID,
      orgId: ORG_ID,
      name: 'Demo Marathon',
      slug: 'demo-marathon',
      eventDate: new Date('2026-06-01'),
      timezone: 'UTC',
      status: 'published',
      currency: 'USD',
      publishedAt: new Date(),
    });
    await db.insert(photos).values({
      id: PHOTO_ID,
      eventId: EVENT_ID,
      photographerUserId: PHOTOG_ID,
      originalObjectKey: `originals/${EVENT_ID}/p.jpg`,
      originalBytes: BigInt(1024),
      contentType: 'image/jpeg',
      width: 100,
      height: 100,
      status: 'ready',
    });
    await db.insert(licenseTiers).values({
      id: TIER_ID,
      code: 'personal',
      name: 'Personal',
      description: 'Personal use',
      sortOrder: 1,
    });
    await db.insert(products).values({
      id: PRODUCT_ID,
      eventId: EVENT_ID,
      kind: 'digital_single',
      sku: 'demo-sku-1',
      name: 'Demo Product',
      priceCents: 1500,
      currency: 'USD',
      licenseTierId: TIER_ID,
      photoId: PHOTO_ID,
      configJsonb: {},
      active: true,
    });

    // Boot the real production server. Disable the dev-only license tier
    // seed by leaving NODE_ENV=test (server.ts honors this).
    const { buildServer } = await import('../src/server.js');
    app = await buildServer();
    await app.ready();
  });

  it('health endpoint responds', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('register -> login -> cart create -> add item', async () => {
    // 1. Register a buyer (real argon2 hash + real users row).
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'buyer@test.invalid',
        password: 'correct-horse-battery-staple',
        displayName: 'Buyer',
      },
    });
    expect(register.statusCode).toBe(201);

    // 2. Login (real argon2 verify + real JWT signing).
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'buyer@test.invalid',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken } = login.json();
    expect(typeof accessToken).toBe('string');

    // 3. Create cart for the event (cookie-based, anonymous allowed).
    const cart = await app.inject({
      method: 'POST',
      url: '/v1/cart',
      payload: { eventId: EVENT_ID },
      headers: { 'content-type': 'application/json' },
    });
    expect(cart.statusCode).toBe(201);
    const cartCookie = cart.headers['set-cookie'] as string | undefined;
    expect(cartCookie).toBeDefined();
    const cartToken = cartCookie?.match(/pps_cart=([0-9a-f]{64})/)?.[1] ?? '';
    expect(cartToken).toMatch(/^[0-9a-f]{64}$/);

    // 4. Add the seeded product to the cart.
    const addItem = await app.inject({
      method: 'POST',
      url: '/v1/cart/items',
      headers: {
        'content-type': 'application/json',
        cookie: `pps_cart=${cartToken}`,
      },
      payload: {
        productId: PRODUCT_ID,
        photoId: PHOTO_ID,
        licenseTierId: TIER_ID,
      },
    });
    expect(addItem.statusCode).toBe(201);

    // 5. Verify the cart_items row landed in Postgres.
    const items = await db.execute(sql`SELECT COUNT(*)::int AS c FROM app.cart_items`);
    const rows = items as unknown as Array<{ c: number }>;
    expect(rows[0]?.c).toBe(1);

    // 6. Verify the audit trail captured the canonical M1 actions.
    const audits = await db.execute(sql`SELECT action FROM app.audit_log ORDER BY created_at ASC`);
    const auditRows = audits as unknown as Array<{ action: string }>;
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain('auth.register');
    expect(actions).toContain('auth.login');
  });
});

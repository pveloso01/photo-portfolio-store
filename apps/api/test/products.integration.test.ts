// Products PATCH immutable-fields test against real Postgres.
//
// Re-enables 1 test skipped under #107:
//   - PATCH rejects mutations of immutable fields (kind, eventId)
//
// The in-memory shim's projection layer couldn't reliably surface the
// validation error path because it never persisted the original product
// fields the way drizzle does. With a real table, the route's request
// schema validation runs before the DB even sees the PATCH, and the
// service-level immutability check (in updateProduct) operates on real
// rows.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';

const { users, organizations } = schema.users.tables;
const { events } = schema.events.tables;
const { photos } = schema.photos.tables;
const { products, licenseTiers } = schema.catalog.tables;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_A = '44444444-4444-4444-8444-44444444aaaa';
const EVENT_B = '44444444-4444-4444-8444-44444444bbbb';
const PHOTO_1 = '55555555-5555-4555-8555-555555555551';
const USER_1 = '22222222-2222-4222-8222-222222222222';

describe('products PATCH — real Postgres', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createDbClient>;

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('integration globalSetup did not set DATABASE_URL');
    db = createDbClient(url);
  });

  afterAll(async () => {
    // pool teardown handled by process exit
  });

  beforeEach(async () => {
    await db.execute(sql`
      TRUNCATE TABLE
        app.products,
        app.license_tiers,
        app.photo_derivatives,
        app.photos,
        app.events,
        app.organizations,
        app.users,
        app.audit_log
      RESTART IDENTITY CASCADE
    `);

    await db.insert(users).values({
      id: USER_1,
      email: 'admin@test.invalid',
      role: 'admin',
      status: 'active',
    });
    await db.insert(organizations).values({
      id: ORG_ID,
      name: 'Org',
      slug: 'org',
      ownerUserId: USER_1,
    });
    await db.insert(events).values([
      {
        id: EVENT_A,
        orgId: ORG_ID,
        name: 'A',
        slug: 'a',
        eventDate: new Date('2026-06-01'),
        timezone: 'UTC',
        status: 'published',
        currency: 'USD',
      },
      {
        id: EVENT_B,
        orgId: ORG_ID,
        name: 'B',
        slug: 'b',
        eventDate: new Date('2026-06-02'),
        timezone: 'UTC',
        status: 'published',
        currency: 'USD',
      },
    ]);
    await db.insert(photos).values({
      id: PHOTO_1,
      eventId: EVENT_A,
      photographerUserId: USER_1,
      originalObjectKey: 'originals/a/p1.jpg',
      originalBytes: BigInt(1024),
      contentType: 'image/jpeg',
      width: 100,
      height: 100,
      status: 'ready',
    });
    await db.insert(licenseTiers).values({
      code: 'personal',
      name: 'Personal',
      description: 'Personal use',
      sortOrder: 1,
    });

    const { default: productsRoutes } = await import('../src/routes/products.js');
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (req) => {
      req.user = { id: USER_1, role: 'admin' as never };
    });
    app.decorate('requirePermission', () => async () => undefined);
    await app.register(async (instance) => {
      await productsRoutes(instance, { db: db as never });
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('PATCH rejects mutations of immutable fields', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/events/${EVENT_A}/products`,
      payload: {
        photoId: PHOTO_1,
        licenseTierCode: 'personal',
        name: 'X',
        priceCents: 1000,
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    const res1 = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${id}`,
      payload: { kind: 'foto_flat' },
    });
    expect(res1.statusCode).toBe(400);

    const res2 = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${id}`,
      payload: { eventId: EVENT_B },
    });
    expect(res2.statusCode).toBe(400);

    const rows = await db.select().from(products).where(sql`${products.id} = ${id}`);
    expect(rows[0]?.kind).toBe('digital_single');
    expect(rows[0]?.eventId).toBe(EVENT_A);
  });
});

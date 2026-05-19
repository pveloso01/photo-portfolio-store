// RBAC event-member grant test against real Postgres.
//
// Re-enables 1 test skipped under #107:
//   - photographer member can media:upload on their event
//
// The unit test couldn't disambiguate the event_members vs
// organization_members lookup paths reliably with the stub DB, so the
// scoped-permission path was skipped. With real tables there is no
// ambiguity — the rbac plugin queries each table by reference.

import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';

import rbacPlugin from '../src/auth/rbac.js';
import type { UserRole } from '../src/auth/role-permissions.js';

const { users, organizations } = schema.users.tables;
const { events, eventMembers } = schema.events.tables;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const PHOTOG_ID = '22222222-2222-4222-8222-222222222222';

describe('rbac: event-member grants event-scoped permissions — real DB', () => {
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
        app.event_members,
        app.events,
        app.organization_members,
        app.organizations,
        app.users,
        app.audit_log
      RESTART IDENTITY CASCADE
    `);

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
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      timezone: 'UTC',
      status: 'draft',
      currency: 'USD',
    });
    await db.insert(eventMembers).values({
      eventId: EVENT_ID,
      userId: PHOTOG_ID,
      role: 'photographer',
      splitPct: '100.00',
    });
  });

  it('photographer member can media:upload on their event', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      const role = req.headers['x-test-role'] as UserRole | undefined;
      const id = (req.headers['x-test-user'] as string) ?? 'user-test';
      if (role) req.user = { id, role };
    });
    await app.register(rbacPlugin, { db: db as never });
    app.post(
      '/events/:id/photos',
      {
        preHandler: app.requirePermission('media:upload', {
          resource: (req) => ({ kind: 'event', id: (req.params as { id: string }).id }),
        }),
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/events/${EVENT_ID}/photos`,
      headers: { 'x-test-role': 'photographer', 'x-test-user': PHOTOG_ID },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

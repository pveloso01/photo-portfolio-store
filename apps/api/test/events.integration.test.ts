// Events service integration tests against real Postgres via testcontainers.
//
// Re-enables 3 tests skipped under #107:
//   - paginates with cursor: insert 50
//   - member add: split_pct > 100 raises split_pct_overflow
//   - rotates FTP credentials
//
// Each test isolates state via TRUNCATE in beforeEach. We can't use the
// withTransaction helper here because the service opens its own
// db.transaction(...) blocks and Postgres rejects nested user-managed
// transactions in the postgres-js driver.

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as svc from '../src/services/events.js';

const { organizations, users, organizationMembers } = schema.users.tables;
const { events, eventMembers, eventFtpCredentials } = schema.events.tables;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const USER_1 = '22222222-2222-4222-8222-222222222221';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const USER_3 = '22222222-2222-4222-8222-222222222223';

describe('events service — real Postgres', () => {
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
        app.event_ftp_credentials,
        app.event_members,
        app.event_settings,
        app.events,
        app.organization_members,
        app.organizations,
        app.users,
        app.audit_log
      RESTART IDENTITY CASCADE
    `);

    // Seed three users + one org with user_1 as owner-member.
    await db.insert(users).values([
      { id: USER_1, email: 'u1@test.invalid', role: 'organizer', status: 'active' },
      { id: USER_2, email: 'u2@test.invalid', role: 'photographer', status: 'active' },
      { id: USER_3, email: 'u3@test.invalid', role: 'photographer', status: 'active' },
    ]);
    await db.insert(organizations).values({
      id: ORG_A,
      name: 'Org A',
      slug: 'org-a',
      ownerUserId: USER_1,
    });
    await db.insert(organizationMembers).values({
      orgId: ORG_A,
      userId: USER_1,
      role: 'owner',
    });
  });

  it('paginates with cursor: insert 50', async () => {
    for (let i = 0; i < 50; i += 1) {
      await svc.createEvent(db, {
        orgId: ORG_A,
        name: `Race ${i}`,
        slug: `race-${i}`,
        eventDate: new Date(Date.UTC(2026, 0, 1) + i * 1000),
        actorUserId: USER_1,
      });
    }

    const page1 = await svc.listEvents(db, { viewerOrgIds: [ORG_A], limit: 20 });
    expect(page1.events).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await svc.listEvents(db, {
      viewerOrgIds: [ORG_A],
      limit: 20,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.events).toHaveLength(20);

    const page3 = await svc.listEvents(db, {
      viewerOrgIds: [ORG_A],
      limit: 20,
      cursor: page2.nextCursor ?? undefined,
    });
    expect(page3.events).toHaveLength(10);
    expect(page3.nextCursor).toBeNull();

    const ids = new Set([
      ...page1.events.map((e) => e.id),
      ...page2.events.map((e) => e.id),
      ...page3.events.map((e) => e.id),
    ]);
    expect(ids.size).toBe(50);
  });

  it('member add: split_pct > 100 raises split_pct_overflow', async () => {
    const event = await svc.createEvent(db, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    await svc.addMember(db, {
      eventId: event.id,
      userId: USER_2,
      role: 'photographer',
      splitPct: 60,
      actorUserId: USER_1,
    });
    await expect(
      svc.addMember(db, {
        eventId: event.id,
        userId: USER_3,
        role: 'photographer',
        splitPct: 50,
        actorUserId: USER_1,
      }),
    ).rejects.toMatchObject({ code: 'split_pct_overflow' });

    const members = await db
      .select()
      .from(eventMembers)
      .where(sql`${eventMembers.eventId} = ${event.id}`);
    // The overflow add must not have persisted.
    expect(members).toHaveLength(2);
  });

  it('rotates FTP credentials', async () => {
    const event = await svc.createEvent(db, {
      orgId: ORG_A,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      actorUserId: USER_1,
    });
    const cred1 = await svc.rotateFtpCredential(db, {
      eventId: event.id,
      actorUserId: USER_1,
      viewerOrgIds: [ORG_A],
    });
    expect(cred1.password).toBeTruthy();
    const cred2 = await svc.rotateFtpCredential(db, {
      eventId: event.id,
      actorUserId: USER_1,
      viewerOrgIds: [ORG_A],
    });
    expect(cred2.id).not.toBe(cred1.id);

    const stored = await db
      .select()
      .from(eventFtpCredentials)
      .where(sql`${eventFtpCredentials.eventId} = ${event.id}`);
    expect(stored).toHaveLength(2);
    const prev = stored.find((r) => r.id === cred1.id);
    expect(prev?.revokedAt).toBeInstanceOf(Date);
    const next = stored.find((r) => r.id === cred2.id);
    expect(next?.revokedAt).toBeNull();
  });
});

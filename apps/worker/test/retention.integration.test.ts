// F1.35 retention purge — real Postgres integration test.
//
// Re-enables 5 tests skipped under #107:
//   - purges an event archived past its retention window (happy path)
//   - writes an audit_log entry with the correct payload per event
//   - updates consents.revoked_at atomically
//   - handles qdrant collection-not-found gracefully
//   - aborts on hard qdrant failure (per-event isolation)
//
// Qdrant stays mocked at the client interface level — running a Qdrant
// container is heavier than the value it adds here. The DB write paths are
// the ones the mock shim couldn't faithfully reproduce.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';

import { runRetentionPass } from '../src/jobs/retention.js';
import { type QdrantLike, collectionName } from '../src/lib/qdrant.js';

const { users, organizations } = schema.users.tables;
const { events } = schema.events.tables;
const { photos } = schema.photos.tables;
const { faceVectors } = schema.search.tables;
const { consents, consentPolicyVersions, auditLog } = schema.compliance.tables;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const makeQdrant = (overrides: Partial<QdrantLike> = {}): QdrantLike => ({
  deleteCollection: vi.fn().mockResolvedValue({ result: true }),
  ...overrides,
});

const seedExpiredEvent = async (
  db: ReturnType<typeof createDbClient>,
  eventId: string,
  retentionDays: number,
  vectorCount: number,
  consentCount: number,
): Promise<void> => {
  const archivedAt = new Date(Date.now() - (retentionDays + 1) * 24 * 60 * 60 * 1000);
  await db.insert(events).values({
    id: eventId,
    orgId: ORG_ID,
    name: `e-${eventId}`,
    slug: `e-${eventId.slice(0, 8)}`,
    eventDate: new Date('2026-01-01'),
    timezone: 'UTC',
    status: 'archived',
    archivedAt,
    retentionDays,
    currency: 'USD',
  });
  // Need a photo per vector for FK plausibility — face_vectors don't have a
  // hard FK in the schema, but inserting against real columns keeps things
  // realistic.
  for (let i = 0; i < vectorCount; i += 1) {
    // Deterministic uuid v4 layout: 8-4-4-4-12 hex chars.
    const tail = i.toString(16).padStart(12, '0');
    const evtPrefix = eventId.replace(/-/g, '').slice(0, 8);
    const photoId = `${evtPrefix}-aaaa-4aaa-8aaa-${tail}`;
    await db
      .insert(photos)
      .values({
        id: photoId,
        eventId,
        photographerUserId: USER_ID,
        originalObjectKey: `originals/${eventId}/v${i}.jpg`,
        originalBytes: BigInt(1024),
        contentType: 'image/jpeg',
        width: 10,
        height: 10,
        status: 'ready',
      })
      .onConflictDoNothing();
    await db.insert(faceVectors).values({
      eventId,
      photoId,
      qdrantPointId: `pt-${eventId}-${i}`,
      embeddingDim: 512,
      quality: '0.9',
    });
  }
  for (let i = 0; i < consentCount; i += 1) {
    await db.insert(consents).values({
      eventId,
      scope: 'biometric',
      policyVersion: '2026-05-18',
      policyLocale: 'en-US',
      jurisdiction: 'eu_gdpr',
      status: 'granted',
      grantedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      searchesUsed: 0,
      searchesQuota: 20,
      acknowledgements: {
        biometricUse: true,
        retention: true,
        thirdParty: true,
        rightsToDelete: true,
      },
      ipHash: `ip-${i}`,
      userAgent: 'ua',
    });
  }
};

describe('runRetentionPass — real Postgres', () => {
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
        app.search_matches,
        app.search_sessions,
        app.face_vectors,
        app.consents,
        app.consent_policy_versions,
        app.photo_derivatives,
        app.photos,
        app.events,
        app.organizations,
        app.users,
        app.audit_log
      RESTART IDENTITY CASCADE
    `);
    await db.insert(users).values({
      id: USER_ID,
      email: 'p@test.invalid',
      role: 'photographer',
      status: 'active',
    });
    await db.insert(organizations).values({
      id: ORG_ID,
      name: 'Org',
      slug: 'org',
      ownerUserId: USER_ID,
    });
    await db.insert(consentPolicyVersions).values({
      version: '2026-05-18',
      locale: 'en-US',
      title: 'Biometric',
      jurisdiction: 'eu_gdpr',
      bodyMarkdown: '# x',
      isActive: true,
    });
  });

  it('purges an event archived past its retention window', async () => {
    const eventId = '11111111-2222-4222-8222-111111111111';
    await seedExpiredEvent(db, eventId, 30, 3, 2);
    const qdrant = makeQdrant();

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(1);
    expect(result.totalVectorsDeleted).toBe(3);
    expect(result.totalConsentsRevoked).toBe(2);
    expect(result.events[0]?.eventId).toBe(eventId);
    expect(result.events[0]?.qdrantCollectionDropped).toBe(true);

    const remaining = await db
      .select()
      .from(faceVectors)
      .where(sql`${faceVectors.eventId} = ${eventId}`);
    expect(remaining).toHaveLength(0);
  });

  it('writes an audit_log entry with the correct payload per event', async () => {
    const eventId = '22222222-3333-4333-8333-222222222222';
    await seedExpiredEvent(db, eventId, 45, 2, 1);
    const qdrant = makeQdrant();

    await runRetentionPass(db, qdrant);

    const audits = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'biometric.purged' AND ${auditLog.targetId} = ${eventId}`);
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actorKind).toBe('cron');
    expect(audit.targetKind).toBe('event');
    expect(audit.eventId).toBe(eventId);
    expect(audit.payloadJsonb).toEqual({
      vectorsDeleted: 2,
      qdrantCollectionDropped: true,
      consentsRevoked: 1,
      retentionDays: 45,
    });
  });

  it('updates consents.revoked_at atomically (retention_until set in same UPDATE)', async () => {
    const eventId = '33333333-4444-4444-8444-333333333333';
    await seedExpiredEvent(db, eventId, 30, 1, 1);
    const qdrant = makeQdrant();

    await runRetentionPass(db, qdrant);

    const revoked = await db.select().from(consents).where(sql`${consents.eventId} = ${eventId}`);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.revokedAt).toBeInstanceOf(Date);
    expect(revoked[0]?.retentionUntil).toBeInstanceOf(Date);
  });

  it('handles qdrant collection-not-found gracefully', async () => {
    const eventId = '44444444-5555-4555-8555-444444444444';
    await seedExpiredEvent(db, eventId, 30, 0, 0);
    const qdrant = makeQdrant({
      deleteCollection: vi.fn().mockRejectedValue(new Error('Collection not found: 404')),
    });

    const result = await runRetentionPass(db, qdrant);

    expect(result.eventsProcessed).toBe(1);
    expect(result.events[0]?.qdrantCollectionDropped).toBe(false);
    const audits = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'biometric.purged' AND ${auditLog.targetId} = ${eventId}`);
    expect(audits).toHaveLength(1);
  });

  it('aborts on hard qdrant failure (per-event isolation)', async () => {
    const badEventId = '55555555-6666-4666-8666-555555555555';
    const goodEventId = '66666666-7777-4777-8777-666666666666';
    await seedExpiredEvent(db, badEventId, 30, 1, 1);
    await seedExpiredEvent(db, goodEventId, 30, 1, 1);

    const deleteCollection = vi
      .fn()
      .mockImplementationOnce(async (name: string) => {
        if (name === collectionName(badEventId)) {
          throw new Error('connection refused');
        }
        return { result: true };
      })
      .mockResolvedValue({ result: true });
    const qdrant: QdrantLike = { deleteCollection };

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runRetentionPass(db, qdrant);

    // Exactly one event succeeded; the other was aborted.
    expect(result.eventsProcessed).toBe(1);
    expect(errSpy).toHaveBeenCalled();

    const badAudits = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.targetId} = ${badEventId} AND ${auditLog.action} = 'biometric.purged'`);
    expect(badAudits).toHaveLength(0);

    const badVectorsRemaining = await db
      .select()
      .from(faceVectors)
      .where(sql`${faceVectors.eventId} = ${badEventId}`);
    expect(badVectorsRemaining, 'failed event still has its vectors').toHaveLength(1);
  });
});

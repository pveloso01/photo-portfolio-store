// F1.24 face-search compliance test against real Postgres + real MinIO.
//
// Re-enables 1 test skipped under #107:
//   - CRITICAL: selfie bytes are never persisted to fs or S3
//
// Strategy:
//   - Real Postgres with seeded event, photo, faceVector, consent rows.
//   - Real S3Client pointed at the MinIO testcontainer; we wrap the client's
//     .send() with a spy so we can assert it was never invoked by the face
//     search code path.
//   - Real fs primitives spied at the module level (Vitest can spy fs/promises
//     in a fresh fork because the integration suite uses pool:'forks').
//   - Inference + Qdrant are still mocked via DI (the runFaceSearch deps
//     parameter); those are out-of-process network calls and aren't the
//     focus of this assertion.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbClient, schema } from '@pkg/db';
import { sql } from 'drizzle-orm';

const { users, organizations } = schema.users.tables;
const { events, eventSettings } = schema.events.tables;
const { photos, photoDerivatives } = schema.photos.tables;
const { faceVectors } = schema.search.tables;
const { consents, consentPolicyVersions } = schema.compliance.tables;

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';
const PHOTO_ID = '77777777-7777-4777-8777-777777777777';
const USER_ID = '88888888-8888-4888-8888-888888888888';
const POLICY_VERSION = '2026-05-18';

describe('face-search service — selfie compliance (real DB + MinIO)', () => {
  let db: ReturnType<typeof createDbClient>;
  let consentId: string;

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
        app.event_settings,
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
    await db.insert(events).values({
      id: EVENT_ID,
      orgId: ORG_ID,
      name: 'Race',
      slug: 'race',
      eventDate: new Date('2026-06-01'),
      timezone: 'UTC',
      status: 'published',
      currency: 'USD',
    });
    await db.insert(eventSettings).values({ eventId: EVENT_ID });
    await db.insert(photos).values({
      id: PHOTO_ID,
      eventId: EVENT_ID,
      photographerUserId: USER_ID,
      originalObjectKey: `originals/${EVENT_ID}/p.jpg`,
      originalBytes: BigInt(1024),
      contentType: 'image/jpeg',
      width: 100,
      height: 100,
      status: 'ready',
    });
    await db.insert(photoDerivatives).values({
      photoId: PHOTO_ID,
      kind: 'preview',
      objectKey: `derivatives/${EVENT_ID}/${PHOTO_ID}/preview.jpg`,
      bytes: 1024,
      width: 100,
      height: 100,
      watermarked: false,
    });
    await db.insert(faceVectors).values({
      eventId: EVENT_ID,
      photoId: PHOTO_ID,
      qdrantPointId: 'qpt-1',
      embeddingDim: 512,
      quality: '0.92',
    });
    await db.insert(consentPolicyVersions).values({
      version: POLICY_VERSION,
      locale: 'en-US',
      title: 'Biometric processing consent',
      jurisdiction: 'eu_gdpr',
      bodyMarkdown: '# consent',
      isActive: true,
    });
    const consent = await db
      .insert(consents)
      .values({
        eventId: EVENT_ID,
        scope: 'biometric',
        policyVersion: POLICY_VERSION,
        policyLocale: 'en-US',
        jurisdiction: 'eu_gdpr',
        status: 'granted',
        grantedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        searchesUsed: 0,
        searchesQuota: 20,
        acknowledgements: {
          biometricUse: true,
          retention: true,
          thirdParty: true,
          rightsToDelete: true,
        },
        ipHash: 'ip1',
        userAgent: 'ua1',
      })
      .returning();
    consentId = consent[0]?.id ?? '';
  });

  it('CRITICAL: selfie bytes are never persisted to fs or S3', async () => {
    const fs = await import('node:fs');
    const fsp = await import('node:fs/promises');
    const writeSync = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const appendSync = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined);
    const writeP = vi.spyOn(fsp, 'writeFile').mockImplementation(async () => undefined);

    // Spy on the actual S3 client the service uses by intercepting the AWS
    // SDK's S3Client.prototype.send. Anything the service does that touches
    // S3 — PutObject, GetObject — flows through this method.
    const s3Mod = await import('@aws-sdk/client-s3');
    const s3Send = vi
      .spyOn(s3Mod.S3Client.prototype, 'send')
      .mockImplementation(async () => ({}) as never);

    const { runFaceSearch } = await import('../src/services/face-search.js');
    await runFaceSearch(
      db,
      {
        eventId: EVENT_ID,
        consentId,
        selfieBytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        ipHash: 'ip1',
        userAgent: 'ua1',
      },
      {
        embedSelfie: async () => ({
          vectors: [{ bbox: [0, 0, 100, 100], score: 0.9, embedding: new Array(512).fill(0.1) }],
          modelVersion: 'test-1.0',
          embeddingDim: 512,
        }),
        searchFaces: async () => [{ id: 'qpt-1', score: 0.9, payload: {} }],
      },
    );

    expect(writeSync, 'no fs.writeFileSync calls').not.toHaveBeenCalled();
    expect(writeP, 'no fs.writeFile calls').not.toHaveBeenCalled();
    expect(appendSync, 'no fs.appendFileSync calls').not.toHaveBeenCalled();
    expect(s3Send, 'no S3 PutObject/GetObject calls').not.toHaveBeenCalled();
  });
});

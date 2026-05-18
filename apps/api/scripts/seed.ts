// Demo seed program for manual QA. Bootstraps a self-contained dataset:
// one org, one organizer + one photographer, one published event, 10 photo
// rows with 4 derivatives each, default license tiers, and 40 products. All
// inserts run inside a single transaction. Re-running the script is a no-op
// (idempotent by slug / email / deterministic SKU).
//
// Usage:
//   pnpm seed
//   # or directly:
//   pnpm --filter @app/api tsx scripts/seed.ts

import { createDbClient, schema } from '@pkg/db';
import { parseEnv, z } from '@pkg/env';
import { and, eq, sql } from 'drizzle-orm';

import { hashPassword } from '../src/auth/passwords.js';
import { LICENSE_TIER_SEED } from '../src/lib/license-tiers.js';
import { SAMPLE_PHOTOS, buildDerivativeSpecs } from './fixtures/sample-photos.js';

// drizzle's transaction callback receives a tx handle with the same surface
// as the parent db client for our needs (select/insert/update/delete). Type
// it as the first parameter of the transaction callback to avoid coupling
// to drizzle's internal PgTransaction generics.
type DbHandle = ReturnType<typeof createDbClient>;
type TxHandle = Parameters<Parameters<DbHandle['transaction']>[0]>[0];

// ---------- Tables ----------

const { users, organizations, organizationMembers, photographerProfiles } = schema.users.tables;
const { events, eventMembers, eventSettings } = schema.events.tables;
const { photos, photoDerivatives } = schema.photos.tables;
const { licenseTiers, products } = schema.catalog.tables;
const { bibTags } = schema.search.tables;

// ---------- Constants ----------

const ORG_SLUG = 'demo-studio';
const ORG_NAME = 'Demo Studio';
const EVENT_SLUG = 'demo-marathon-2026';
const EVENT_NAME = 'Demo Marathon 2026';

const ORGANIZER_EMAIL = 'organizer@demo.test';
const ORGANIZER_PASSWORD = 'demo-organizer-pw';
const PHOTOGRAPHER_EMAIL = 'photog@demo.test';
const PHOTOGRAPHER_PASSWORD = 'demo-photog-pw';

const PRICE_BY_LICENSE_CODE: Readonly<Record<string, number>> = {
  personal: 1000,
  social: 2000,
  editorial: 5000,
  commercial: 20000,
};

const BIB_NUMBERS: ReadonlyArray<string> = ['100', '101', '102', '103', '104'];

// ---------- Env ----------

const seedEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

// ---------- Helpers ----------

const generateSku = (eventId: string, photoId: string, licenseCode: string): string => {
  const codeMap: Record<string, string> = {
    personal: 'per',
    social: 'soc',
    editorial: 'edi',
    commercial: 'com',
  };
  const shortEvent = eventId.replace(/-/g, '').slice(0, 8);
  const shortPhoto = photoId.replace(/-/g, '').slice(0, 8);
  const lic = codeMap[licenseCode] ?? licenseCode.slice(0, 3);
  return `evt-${shortEvent}-photo-${shortPhoto}-${lic}`;
};

interface SeedSummary {
  orgId: string;
  eventId: string;
  organizerUserId: string;
  photographerUserId: string;
  photoCount: number;
  productCount: number;
  bibTagCount: number;
}

// ---------- Main ----------

const run = async (): Promise<SeedSummary> => {
  const env = parseEnv(seedEnvSchema);
  const db = createDbClient(env.DATABASE_URL);

  // Ensure schema exists (idempotent). Drizzle migrations should already have
  // run, but be defensive — this lets the seed work on a fresh DB without a
  // separate manual step in tightly-coupled CI scenarios.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS app`);

  const summary = await db.transaction(async (tx) => {
    // ----- 1. License tiers (idempotent) -----
    const existingTiers = await tx.select({ code: licenseTiers.code }).from(licenseTiers);
    const haveCodes = new Set(existingTiers.map((r) => r.code));
    const missingTiers = LICENSE_TIER_SEED.filter((t) => !haveCodes.has(t.code));
    if (missingTiers.length > 0) {
      await tx.insert(licenseTiers).values(
        missingTiers.map((t) => ({
          code: t.code,
          name: t.name,
          description: t.description,
          sortOrder: t.sortOrder,
        })),
      );
    }
    const tierRows = await tx.select().from(licenseTiers);
    const tierByCode = new Map(tierRows.map((t) => [t.code, t] as const));

    // ----- 2. Users (organizer + photographer) -----
    const organizerUserId = await ensureUser(tx, {
      email: ORGANIZER_EMAIL,
      password: ORGANIZER_PASSWORD,
      displayName: 'Demo Organizer',
      role: 'organizer',
    });
    const photographerUserId = await ensureUser(tx, {
      email: PHOTOGRAPHER_EMAIL,
      password: PHOTOGRAPHER_PASSWORD,
      displayName: 'Demo Photographer',
      role: 'photographer',
    });

    // ----- 3. Organization (owned by organizer) -----
    const existingOrg = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.slug, ORG_SLUG))
      .limit(1);
    let orgId: string;
    if (existingOrg[0]) {
      orgId = existingOrg[0].id;
    } else {
      const inserted = await tx
        .insert(organizations)
        .values({ name: ORG_NAME, slug: ORG_SLUG, ownerUserId: organizerUserId })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('failed to insert organization');
      orgId = row.id;
    }

    // ----- 4. Org membership -----
    await ensureOrgMember(tx, orgId, organizerUserId, 'owner');
    await ensureOrgMember(tx, orgId, photographerUserId, 'member');

    // ----- 5. Photographer profile -----
    const existingProfile = await tx
      .select({ userId: photographerProfiles.userId })
      .from(photographerProfiles)
      .where(eq(photographerProfiles.userId, photographerUserId))
      .limit(1);
    if (!existingProfile[0]) {
      await tx.insert(photographerProfiles).values({
        userId: photographerUserId,
        displayName: 'Demo Photographer',
        bio: 'Seed-data photographer for manual QA.',
      });
    }

    // ----- 6. Event -----
    const existingEvent = await tx
      .select()
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.slug, EVENT_SLUG)))
      .limit(1);
    let eventId: string;
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    if (existingEvent[0]) {
      eventId = existingEvent[0].id;
    } else {
      const inserted = await tx
        .insert(events)
        .values({
          orgId,
          name: EVENT_NAME,
          slug: EVENT_SLUG,
          eventDate: tomorrow,
          location: 'Demo City',
          timezone: 'UTC',
          status: 'published',
          publishedAt: new Date(),
          currency: 'USD',
          description: 'Synthetic event seeded for manual QA.',
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('failed to insert event');
      eventId = row.id;
      await tx.insert(eventSettings).values({ eventId });
    }

    // ----- 7. Event members -----
    await ensureEventMember(tx, eventId, organizerUserId, 'organizer', '0.00');
    await ensureEventMember(tx, eventId, photographerUserId, 'photographer', '100.00');

    // ----- 8. Photos + derivatives -----
    let photoCount = 0;
    const photoIds: string[] = [];
    for (let i = 0; i < SAMPLE_PHOTOS.length; i += 1) {
      const sample = SAMPLE_PHOTOS[i];
      if (!sample) continue;
      const originalKey = `originals/${eventId}/${sample.filename}`;

      const existing = await tx
        .select({ id: photos.id })
        .from(photos)
        .where(and(eq(photos.eventId, eventId), eq(photos.originalObjectKey, originalKey)))
        .limit(1);

      let photoId: string;
      if (existing[0]) {
        photoId = existing[0].id;
      } else {
        const inserted = await tx
          .insert(photos)
          .values({
            eventId,
            photographerUserId,
            originalObjectKey: originalKey,
            originalBytes: BigInt(sample.originalBytes),
            contentType: sample.contentType,
            width: sample.width,
            height: sample.height,
            status: 'ready',
          })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error('failed to insert photo');
        photoId = row.id;

        const specs = buildDerivativeSpecs(sample.width, sample.height);
        await tx.insert(photoDerivatives).values(
          specs.map((spec) => ({
            photoId,
            kind: spec.kind,
            objectKey: `derivatives/${eventId}/${photoId}/${spec.kind}.jpg`,
            bytes: spec.bytes,
            width: spec.width,
            height: spec.height,
            watermarked: spec.watermarked,
          })),
        );
        photoCount += 1;
      }
      photoIds.push(photoId);
    }

    // ----- 9. Products (4 per photo) -----
    let productCount = 0;
    const licenseCodes = ['personal', 'social', 'editorial', 'commercial'] as const;
    for (const photoId of photoIds) {
      for (const code of licenseCodes) {
        const tier = tierByCode.get(code);
        if (!tier) throw new Error(`missing license tier seed: ${code}`);
        const sku = generateSku(eventId, photoId, code);
        const existing = await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.sku, sku))
          .limit(1);
        if (existing[0]) continue;
        await tx.insert(products).values({
          eventId,
          kind: 'digital_single',
          sku,
          name: `${tier.name} download`,
          description: tier.description,
          priceCents: PRICE_BY_LICENSE_CODE[code] ?? 1000,
          currency: 'USD',
          licenseTierId: tier.id,
          photoId,
          configJsonb: {},
          active: true,
        });
        productCount += 1;
      }
    }

    // ----- 10. Bib tags (first 5 photos) -----
    let bibTagCount = 0;
    for (let i = 0; i < BIB_NUMBERS.length; i += 1) {
      const photoId = photoIds[i];
      const bibNumber = BIB_NUMBERS[i];
      if (!photoId || !bibNumber) continue;
      const existing = await tx
        .select({ id: bibTags.id })
        .from(bibTags)
        .where(and(eq(bibTags.photoId, photoId), eq(bibTags.bibNumber, bibNumber)))
        .limit(1);
      if (existing[0]) continue;
      await tx.insert(bibTags).values({
        photoId,
        eventId,
        bibNumber,
        confidence: '0.920',
        source: 'ocr',
        modelVersion: 'seed-demo-1.0',
      });
      bibTagCount += 1;
    }

    // Totals reported reflect newly-inserted rows in this run. For an
    // already-seeded DB these will be zero; the summary block below uses
    // canonical counts to give consistent output.
    const totalPhotos = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(photos)
      .where(eq(photos.eventId, eventId));
    const totalProducts = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(products)
      .where(eq(products.eventId, eventId));
    const totalBibs = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(bibTags)
      .where(eq(bibTags.eventId, eventId));

    void photoCount;
    void productCount;
    void bibTagCount;

    return {
      orgId,
      eventId,
      organizerUserId,
      photographerUserId,
      photoCount: Number(totalPhotos[0]?.c ?? 0),
      productCount: Number(totalProducts[0]?.c ?? 0),
      bibTagCount: Number(totalBibs[0]?.c ?? 0),
    } satisfies SeedSummary;
  });

  return summary;
};

interface EnsureUserInput {
  email: string;
  password: string;
  displayName: string;
  role: 'organizer' | 'photographer';
}

const ensureUser = async (tx: TxHandle, input: EnsureUserInput): Promise<string> => {
  const email = input.email.toLowerCase();
  const existing = await tx.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return existing[0].id;
  const passwordHash = await hashPassword(input.password);
  const inserted = await tx
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: input.displayName,
      role: input.role,
      status: 'active',
      emailVerifiedAt: new Date(),
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error(`failed to insert user ${email}`);
  return row.id;
};

const ensureOrgMember = async (
  tx: TxHandle,
  orgId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> => {
  const existing = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (existing[0]) return;
  await tx.insert(organizationMembers).values({ orgId, userId, role });
};

const ensureEventMember = async (
  tx: TxHandle,
  eventId: string,
  userId: string,
  role: 'organizer' | 'photographer' | 'assistant',
  splitPct: string,
): Promise<void> => {
  const existing = await tx
    .select({ userId: eventMembers.userId })
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)))
    .limit(1);
  if (existing[0]) return;
  await tx.insert(eventMembers).values({ eventId, userId, role, splitPct });
};

// ---------- Entry point ----------

const main = async (): Promise<void> => {
  const summary = await run();
  process.stdout.write(
    [
      '',
      '✓ Seed complete',
      `  org:           ${ORG_NAME} (id: ${summary.orgId})`,
      `  event:         ${EVENT_NAME} (id: ${summary.eventId}, slug: ${EVENT_SLUG})`,
      `  organizer:     ${ORGANIZER_EMAIL} / ${ORGANIZER_PASSWORD}`,
      `  photographer:  ${PHOTOGRAPHER_EMAIL}    / ${PHOTOGRAPHER_PASSWORD}`,
      `  photos:        ${summary.photoCount}`,
      `  products:      ${summary.productCount}`,
      `  bib_tags:      ${summary.bibTagCount}`,
      '',
    ].join('\n'),
  );
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `Seed failed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });

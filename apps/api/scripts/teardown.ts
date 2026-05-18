// Teardown companion to seed.ts. Deletes the Demo Studio org and everything
// scoped to its single event. Because most cross-context FKs are plain uuid
// columns (no DB-level cascade), we delete rows in dependency order
// explicitly. Safe to re-run; missing rows are skipped.
//
// Usage:
//   pnpm --filter @app/api tsx scripts/teardown.ts

import { createDbClient, schema } from '@pkg/db';
import { parseEnv, z } from '@pkg/env';
import { and, eq, inArray, sql } from 'drizzle-orm';

const { users, organizations, organizationMembers, photographerProfiles } = schema.users.tables;
const { events, eventMembers, eventSettings } = schema.events.tables;
const { photos, photoDerivatives, uploadSessions } = schema.photos.tables;
const { products } = schema.catalog.tables;
const { bibTags, faceVectors, qualityFlags } = schema.search.tables;

const ORG_SLUG = 'demo-studio';
const EVENT_SLUG = 'demo-marathon-2026';
const DEMO_EMAILS = ['organizer@demo.test', 'photog@demo.test'];

const teardownEnvSchema = z.object({ DATABASE_URL: z.string().min(1) });

const main = async (): Promise<void> => {
  const env = parseEnv(teardownEnvSchema);
  const db = createDbClient(env.DATABASE_URL);

  await db.transaction(async (tx) => {
    const orgRows = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, ORG_SLUG))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      process.stdout.write('Nothing to tear down: demo-studio org not present.\n');
      return;
    }

    const eventRows = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.slug, EVENT_SLUG)));
    const eventIds = eventRows.map((r) => r.id);

    if (eventIds.length > 0) {
      const photoRows = await tx
        .select({ id: photos.id })
        .from(photos)
        .where(inArray(photos.eventId, eventIds));
      const photoIds = photoRows.map((r) => r.id);

      // Search context
      await tx.delete(bibTags).where(inArray(bibTags.eventId, eventIds));
      await tx.delete(faceVectors).where(inArray(faceVectors.eventId, eventIds));
      if (photoIds.length > 0) {
        await tx.delete(qualityFlags).where(inArray(qualityFlags.photoId, photoIds));
      }

      // Catalog context
      await tx.delete(products).where(inArray(products.eventId, eventIds));

      // Photos & derivatives (derivatives cascade with photos)
      if (photoIds.length > 0) {
        await tx.delete(photoDerivatives).where(inArray(photoDerivatives.photoId, photoIds));
      }
      await tx.delete(photos).where(inArray(photos.eventId, eventIds));
      await tx.delete(uploadSessions).where(inArray(uploadSessions.eventId, eventIds));

      // Event members + settings + the event itself
      await tx.delete(eventMembers).where(inArray(eventMembers.eventId, eventIds));
      await tx.delete(eventSettings).where(inArray(eventSettings.eventId, eventIds));
      await tx.delete(events).where(inArray(events.id, eventIds));
    }

    // Org memberships
    await tx.delete(organizationMembers).where(eq(organizationMembers.orgId, org.id));

    // Demo users — only if they have no remaining org memberships elsewhere.
    const demoUserRows = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.email, DEMO_EMAILS));
    for (const u of demoUserRows) {
      const otherMemberships = await tx
        .select({ orgId: organizationMembers.orgId })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, u.id))
        .limit(1);
      if (otherMemberships.length === 0) {
        await tx.delete(photographerProfiles).where(eq(photographerProfiles.userId, u.id));
        // The organization owner FK is restrict-on-delete; org is being
        // dropped below, so users can be removed after.
      }
    }

    // Drop the org itself (owner FK is restrict — users still alive).
    await tx.delete(organizations).where(eq(organizations.id, org.id));

    // Now safe to delete demo users with no remaining ties.
    for (const u of demoUserRows) {
      const remaining = await tx
        .select({ orgId: organizationMembers.orgId })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, u.id))
        .limit(1);
      if (remaining.length === 0) {
        await tx.delete(users).where(eq(users.id, u.id));
      }
    }

    process.stdout.write(`✓ Teardown complete. Removed org ${ORG_SLUG} and dependents.\n`);
  });

  // Quiet the unused-import lint for sql in case future cleanup needs it.
  void sql;
};

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(
      `Teardown failed:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });

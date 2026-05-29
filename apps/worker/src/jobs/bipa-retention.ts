// F3.8 — BIPA retention-window destruction.
//
// Daily sweep: find biometric consents whose retention_window_ends_at has
// passed (and that are still active), then purge their face_vectors from
// Qdrant + Postgres and mark the consent revoked. Idempotent: a consent
// already revoked is skipped.
//
// This is the BIPA-equivalent "automatic destruction at the retention
// boundary" requirement (740 ILCS 14, similar TX/WA). The general
// retention.ts cron handles per-event retention_days; this one handles the
// per-jurisdiction statutory ceiling.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';

import { type QdrantLike, collectionName } from '../lib/qdrant.js';

const { consents } = schema.compliance.tables;
const { faceVectors } = schema.search.tables;

export interface BipaDestructionResult {
  consentsProcessed: number;
  vectorsDeleted: number;
  collectionsDropped: number;
  errors: Array<{ consentId: string; error: string }>;
}

export const findExpiredBipaConsents = async (
  db: DbClient,
  now: Date = new Date(),
): Promise<Array<{ id: string; eventId: string | null }>> => {
  const rows = await db
    .select({ id: consents.id, eventId: consents.eventId })
    .from(consents)
    .where(
      and(
        eq(consents.scope, 'biometric'),
        isNull(consents.revokedAt),
        isNotNull(consents.retentionWindowEndsAt),
        lt(consents.retentionWindowEndsAt, now),
      ),
    );
  return rows.map((r) => ({ id: r.id, eventId: r.eventId }));
};

const dropQdrantCollection = async (qdrant: QdrantLike, eventId: string): Promise<boolean> => {
  try {
    await qdrant.deleteCollection(collectionName(eventId));
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not.?found|404|does\s*not\s*exist|doesn'?t exist/i.test(msg)) return false;
    throw err;
  }
};

export const runBipaRetentionDestruction = async (
  db: DbClient,
  qdrant: QdrantLike,
  now: Date = new Date(),
): Promise<BipaDestructionResult> => {
  const expired = await findExpiredBipaConsents(db, now);
  const errors: BipaDestructionResult['errors'] = [];
  let vectorsDeleted = 0;
  let collectionsDropped = 0;

  // Group expired consents by event so we drop each event's collection at most
  // once even when multiple subjects' retention windows expire together.
  const eventsToPurge = new Map<string, string[]>(); // eventId -> consentIds
  const nullEventConsents: string[] = [];
  for (const c of expired) {
    if (c.eventId === null) {
      nullEventConsents.push(c.id);
      continue;
    }
    const list = eventsToPurge.get(c.eventId) ?? [];
    list.push(c.id);
    eventsToPurge.set(c.eventId, list);
  }

  for (const [eventId, consentIds] of eventsToPurge) {
    try {
      // Only drop the collection when no OTHER active consent still references
      // the event. Otherwise we'd erase other subjects' data.
      const otherActive = await db
        .select({ id: consents.id })
        .from(consents)
        .where(
          and(
            eq(consents.scope, 'biometric'),
            eq(consents.eventId, eventId),
            isNull(consents.revokedAt),
            notInArray(consents.id, consentIds),
          ),
        )
        .limit(1);

      if (otherActive.length === 0) {
        const dropped = await dropQdrantCollection(qdrant, eventId);
        if (dropped) collectionsDropped += 1;
        const deleted = await db
          .delete(faceVectors)
          .where(eq(faceVectors.eventId, eventId))
          .returning({ id: faceVectors.id });
        vectorsDeleted += deleted.length;
      }

      for (const id of consentIds) {
        await db
          .update(consents)
          .set({ revokedAt: now, retentionUntil: now })
          .where(eq(consents.id, id));
      }
    } catch (err) {
      for (const id of consentIds) {
        errors.push({ consentId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Consents not tied to an event still get revoked (no vector cascade).
  for (const id of nullEventConsents) {
    try {
      await db
        .update(consents)
        .set({ revokedAt: now, retentionUntil: now })
        .where(eq(consents.id, id));
    } catch (err) {
      errors.push({ consentId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    consentsProcessed: expired.length,
    vectorsDeleted,
    collectionsDropped,
    errors,
  };
};

// F3.2 — moderation queue + bulk hide/show/delete.
//
// moderation_status is the source of truth; the legacy `hidden` boolean is kept
// in sync so existing gallery queries (which filter on hidden) stay correct:
//   hide   -> moderation_status='hidden',  hidden=true
//   show   -> moderation_status='visible', hidden=false
//   delete -> moderation_status='deleted', status='takedown', hidden=true,
//             plus R2 object purge + Qdrant vector purge for the photo.
//
// delete is per-photo atomic: the row is only flipped to 'deleted' after its R2
// + Qdrant purge succeeds. A photo whose purge throws is left untouched and
// returned in `failed[]` so the caller can retry it.

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { collectionName, qdrant as defaultQdrant } from '../lib/qdrant-client.js';
import { buckets, s3 } from '../lib/storage.js';

const { photos, photoReports, photoDerivatives } = schema.photos.tables;
const { faceVectors } = schema.search.tables;

export const BULK_MAX = 100;
const DEFAULT_LIMIT = 50;

export class ModerationError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'too_many' | 'purge_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ModerationError';
  }
}

export type ModerationAction = 'hide' | 'show' | 'delete';

export interface QueueItem {
  photoId: string;
  eventId: string;
  photographerUserId: string;
  flagCount: number;
  lastFlaggedAt: string | null;
  moderationStatus: string;
  reasons: string[];
  createdAt: string;
}

export interface BulkResult {
  updated: number;
  failed: string[];
}

// Seams so tests can inject fakes without real R2 / Qdrant.
export interface ModerationDeps {
  s3?: Pick<typeof s3, 'send'>;
  qdrant?: { delete: (collection: string, args: unknown) => Promise<unknown> };
  buckets?: { originals: string; derivatives: string };
}

// ---------- Queue ----------

export const getModerationQueue = async (
  db: DbClient,
  opts: { cursor?: string; limit?: number; severity?: number } = {},
): Promise<{ items: QueueItem[]; nextCursor: string | null }> => {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), BULK_MAX);
  const cursor = decodeCursor(opts.cursor);
  const minSeverity = opts.severity ?? 1;

  // Photos needing attention: flagged OR already acted-on (non-visible).
  // Display order is severity-first (flagCount desc) then createdAt asc, per the
  // spec. The cursor is a createdAt keyset: pagination is exact within a
  // severity tier and at tier boundaries resumes by time — acceptable for an
  // admin queue at current scale (documented).
  const conditions = [
    or(gt(photos.flagCount, minSeverity - 1), ne(photos.moderationStatus, 'visible')),
  ];
  if (cursor) {
    conditions.push(gt(photos.createdAt, cursor.createdAt));
  }

  const rows = await db
    .select({
      id: photos.id,
      eventId: photos.eventId,
      photographerUserId: photos.photographerUserId,
      flagCount: photos.flagCount,
      lastFlaggedAt: photos.lastFlaggedAt,
      moderationStatus: photos.moderationStatus,
      createdAt: photos.createdAt,
    })
    .from(photos)
    .where(and(...conditions))
    .orderBy(desc(photos.flagCount), photos.createdAt)
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null;

  // Aggregate distinct report reasons per photo on the page.
  const photoIds = page.map((p) => p.id);
  const reasonsByPhoto = new Map<string, Set<string>>();
  if (photoIds.length > 0) {
    const reports = await db
      .select({ photoId: photoReports.photoId, reason: photoReports.reason })
      .from(photoReports)
      .where(inArray(photoReports.photoId, photoIds));
    for (const r of reports) {
      const set = reasonsByPhoto.get(r.photoId) ?? new Set<string>();
      set.add(r.reason);
      reasonsByPhoto.set(r.photoId, set);
    }
  }

  const items: QueueItem[] = page.map((p) => ({
    photoId: p.id,
    eventId: p.eventId,
    photographerUserId: p.photographerUserId,
    flagCount: p.flagCount,
    lastFlaggedAt: p.lastFlaggedAt ? p.lastFlaggedAt.toISOString() : null,
    moderationStatus: p.moderationStatus,
    reasons: [...(reasonsByPhoto.get(p.id) ?? [])],
    createdAt: p.createdAt.toISOString(),
  }));

  return { items, nextCursor };
};

// ---------- Bulk actions ----------

const purgePhotoArtifacts = async (
  db: DbClient,
  photo: { id: string; eventId: string; originalObjectKey: string },
  deps: ModerationDeps,
): Promise<void> => {
  const s3Client = deps.s3 ?? s3;
  const bucketCfg = deps.buckets ?? buckets;
  const qdrantClient = deps.qdrant ?? (defaultQdrant as unknown as ModerationDeps['qdrant']);

  // R2: original + every derivative object.
  const derivatives = await db
    .select({ objectKey: photoDerivatives.objectKey })
    .from(photoDerivatives)
    .where(eq(photoDerivatives.photoId, photo.id));
  const keys = [photo.originalObjectKey, ...derivatives.map((d) => d.objectKey)];
  for (const key of keys) {
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucketCfg.originals, Key: key }) as never,
    );
  }

  // Qdrant: drop the photo's points by payload filter, then the metadata rows.
  if (qdrantClient) {
    await qdrantClient.delete(collectionName(photo.eventId), {
      filter: { must: [{ key: 'photo_id', match: { value: photo.id } }] },
    });
  }
  await db.delete(faceVectors).where(eq(faceVectors.photoId, photo.id));
};

export const bulkModerate = async (
  db: DbClient,
  action: ModerationAction,
  photoIds: string[],
  ctx: { adminUserId: string },
  deps: ModerationDeps = {},
): Promise<BulkResult> => {
  if (photoIds.length === 0) {
    throw new ModerationError('invalid_request', 'photoIds must not be empty');
  }
  if (photoIds.length > BULK_MAX) {
    throw new ModerationError('too_many', `at most ${BULK_MAX} photos per request`);
  }

  const failed: string[] = [];
  let updated = 0;

  if (action === 'hide' || action === 'show') {
    const moderationStatus = action === 'hide' ? 'hidden' : 'visible';
    const hidden = action === 'hide';
    for (const photoId of photoIds) {
      await db
        .update(photos)
        .set({ moderationStatus, hidden, updatedAt: new Date() })
        .where(eq(photos.id, photoId));
      await writeAudit(db, {
        action: `moderation.photo.${action}`,
        actorKind: 'user',
        actorUserId: ctx.adminUserId,
        targetKind: 'photo',
        targetId: photoId,
      });
      updated += 1;
    }
    return { updated, failed };
  }

  // delete: purge artifacts first; only flip the row on success.
  const rows = await db
    .select({
      id: photos.id,
      eventId: photos.eventId,
      originalObjectKey: photos.originalObjectKey,
    })
    .from(photos)
    .where(inArray(photos.id, photoIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const photoId of photoIds) {
    const photo = byId.get(photoId);
    if (!photo) {
      failed.push(photoId);
      continue;
    }
    try {
      await purgePhotoArtifacts(db, photo, deps);
      await db
        .update(photos)
        .set({
          moderationStatus: 'deleted',
          status: 'takedown',
          hidden: true,
          takedownAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(photos.id, photoId));
      await writeAudit(db, {
        action: 'moderation.photo.delete',
        actorKind: 'user',
        actorUserId: ctx.adminUserId,
        targetKind: 'photo',
        targetId: photoId,
        eventId: photo.eventId,
      });
      updated += 1;
    } catch {
      // Per-photo isolation: leave the row untouched, surface for retry.
      failed.push(photoId);
    }
  }

  return { updated, failed };
};

// Re-export so callers needing the raw sql tag stay consistent (unused-safe).
export const __internal = { sql };

// F3.13 — surface F3.12 quality flags in the photographer dashboard.
//
// Two reads, both owner-scoped to the authenticated photographer:
//   - listPhotographerPhotos: the caller's photos, optionally filtered by a
//     single quality_flag (blur | eyes_closed | near_duplicate), newest-first,
//     keyset-paginated. Near-duplicate rows carry their duplicate_group_id so
//     the UI can fetch siblings.
//   - getPhotoQuality: raw scores (blur_score, eyes-closed face count, nearest
//     neighbour) + a plain-language explanation + the duplicate group siblings.
//
// Flags are ADVISORY. Nothing here hides a photo or changes buyer-facing
// visibility — the dashboard bulk-hide action (F3.2 moderation) is the only
// path that does, and only on explicit photographer input.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, sql } from 'drizzle-orm';

import { type CursorPayload, decodeCursor, encodeCursor } from '../lib/cursor.js';

const { photos } = schema.photos;

export type QualityFlagFilter = 'blur' | 'eyes_closed' | 'near_duplicate';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface QualityFlagsShape {
  blur?: boolean;
  near_duplicate_of?: string;
  duplicate_group_id?: string;
  eyes_closed?: { faces: number };
}

export interface PhotoQualityListItem {
  photoId: string;
  eventId: string;
  status: string;
  hidden: boolean;
  blurScore: number | null;
  qualityFlags: QualityFlagsShape | null;
  duplicateGroupId: string | null;
  createdAt: string;
}

export interface ListPhotographerPhotosResult {
  items: PhotoQualityListItem[];
  nextCursor: string | null;
}

// jsonb predicates for each advisory flag.
const flagPredicate = (filter: QualityFlagFilter) => {
  switch (filter) {
    case 'blur':
      return sql`${photos.qualityFlags} ->> 'blur' = 'true'`;
    case 'eyes_closed':
      return sql`${photos.qualityFlags} -> 'eyes_closed' IS NOT NULL`;
    case 'near_duplicate':
      return sql`${photos.qualityFlags} ->> 'near_duplicate_of' IS NOT NULL`;
  }
};

const toListItem = (row: {
  id: string;
  eventId: string;
  status: string;
  hidden: boolean;
  blurScore: string | null;
  qualityFlags: unknown;
  createdAt: Date;
}): PhotoQualityListItem => {
  const flags = (row.qualityFlags as QualityFlagsShape | null) ?? null;
  return {
    photoId: row.id,
    eventId: row.eventId,
    status: row.status,
    hidden: row.hidden,
    blurScore: row.blurScore !== null ? Number(row.blurScore) : null,
    qualityFlags: flags,
    duplicateGroupId: flags?.duplicate_group_id ?? null,
    createdAt: row.createdAt.toISOString(),
  };
};

export const listPhotographerPhotos = async (
  db: DbClient,
  photographerUserId: string,
  opts: { eventId?: string; qualityFlag?: QualityFlagFilter; cursor?: string; limit?: number } = {},
): Promise<ListPhotographerPhotosResult> => {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor: CursorPayload | null = decodeCursor(opts.cursor);

  const filters = [eq(photos.photographerUserId, photographerUserId)];
  if (opts.eventId) filters.push(eq(photos.eventId, opts.eventId));
  if (opts.qualityFlag) filters.push(flagPredicate(opts.qualityFlag));
  // Keyset: rows strictly older than the cursor (createdAt, id) tuple.
  if (cursor) {
    filters.push(sql`(${photos.createdAt}, ${photos.id}) < (${cursor.createdAt}, ${cursor.id})`);
  }

  const rows = await db
    .select({
      id: photos.id,
      eventId: photos.eventId,
      status: photos.status,
      hidden: photos.hidden,
      blurScore: photos.blurScore,
      qualityFlags: photos.qualityFlags,
      createdAt: photos.createdAt,
    })
    .from(photos)
    .where(and(...filters))
    .orderBy(desc(photos.createdAt), desc(photos.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(toListItem);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null;

  return { items, nextCursor };
};

export interface PhotoQualityDetail {
  photoId: string;
  eventId: string;
  blurScore: number | null;
  phash: string | null;
  flags: QualityFlagsShape | null;
  explanation: string[];
  duplicateGroupId: string | null;
  duplicateSiblings: string[];
}

const EXPLANATIONS: Record<QualityFlagFilter, string> = {
  blur: 'Blur is estimated from the variance of the Laplacian on the luma channel; a low score means the image is soft or out of focus. This is advisory and can produce false positives on intentionally shallow-depth-of-field shots.',
  eyes_closed:
    'Eyes-closed is detected per face from the eye-aspect-ratio of facial landmarks. The count is the number of faces with both eyes below the threshold. Advisory only — blinks and squints can trigger it.',
  near_duplicate:
    'Near-duplicate is detected via perceptual-hash (pHash) Hamming distance against other photos in this event. Burst shots are commonly intentional, so these are never auto-hidden.',
};

export const getPhotoQuality = async (
  db: DbClient,
  photoId: string,
  photographerUserId: string,
): Promise<PhotoQualityDetail | null> => {
  const rows = await db
    .select({
      id: photos.id,
      eventId: photos.eventId,
      photographerUserId: photos.photographerUserId,
      blurScore: photos.blurScore,
      phash: photos.phash,
      qualityFlags: photos.qualityFlags,
    })
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);

  const row = rows[0];
  // Anti-enumeration: same null for "not found" and "not your photo".
  if (!row || row.photographerUserId !== photographerUserId) return null;

  const flags = (row.qualityFlags as QualityFlagsShape | null) ?? null;
  const explanation: string[] = [];
  if (flags?.blur) explanation.push(EXPLANATIONS.blur);
  if (flags?.eyes_closed) explanation.push(EXPLANATIONS.eyes_closed);
  if (flags?.near_duplicate_of) explanation.push(EXPLANATIONS.near_duplicate);

  const duplicateGroupId = flags?.duplicate_group_id ?? null;
  let duplicateSiblings: string[] = [];
  if (duplicateGroupId) {
    const siblings = await db
      .select({ id: photos.id })
      .from(photos)
      .where(
        and(
          eq(photos.eventId, row.eventId),
          sql`${photos.qualityFlags} ->> 'duplicate_group_id' = ${duplicateGroupId}`,
          sql`${photos.id} <> ${photoId}`,
        ),
      );
    duplicateSiblings = siblings.map((s) => s.id);
  }

  return {
    photoId: row.id,
    eventId: row.eventId,
    blurScore: row.blurScore !== null ? Number(row.blurScore) : null,
    phash: row.phash !== null ? String(row.phash) : null,
    flags,
    explanation,
    duplicateGroupId,
    duplicateSiblings,
  };
};

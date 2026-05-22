// Media context — uploads, photos, derivatives.
// All tables live in the Postgres `app` schema.
// Cross-context FKs stay as plain uuid columns; application code enforces.
// Within file, FK + cascade used freely (e.g. derivatives onDelete cascade with photos).

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// ---------- Enums ----------

export const uploadSessionStatus = app.enum('upload_session_status', [
  'in_progress',
  'completed',
  'aborted',
  'expired',
]);

export const photoStatus = app.enum('photo_status', [
  'processing',
  'ready',
  'hidden',
  'failed',
  'takedown',
]);

export const derivativeKind = app.enum('derivative_kind', ['thumb', 'preview', 'web', 'full']);

// F3.2 moderation. moderation_status is the source of truth; the legacy
// `hidden` boolean is kept in sync by the moderation service.
export const photoModerationStatus = app.enum('photo_moderation_status', [
  'visible',
  'hidden',
  'deleted',
]);

export const photoReportReason = app.enum('photo_report_reason', [
  'inappropriate',
  'copyright',
  'privacy',
  'quality',
  'other',
]);

// ---------- upload_sessions ----------
// Resumable multipart uploads (F1.11). Tracks an in-flight R2/S3 multipart
// upload from initiation to completion / abort / expiry. A GC worker scans
// for (status='in_progress', expires_at < now()) and aborts the R2 upload.

export const uploadSessions = app.table(
  'upload_sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK to avoid coupling schema files.
    eventId: uuid('event_id').notNull(),
    // refs users.id — cross-context, no FK.
    photographerUserId: uuid('photographer_user_id').notNull(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    totalBytes: bigint('total_bytes', { mode: 'bigint' }).notNull(),
    // The multipart upload id returned by R2/S3 CreateMultipartUpload.
    r2UploadId: text('r2_upload_id').notNull(),
    // Final destination key, e.g. `originals/{event_id}/{uuid}.jpg`.
    r2ObjectKey: text('r2_object_key').notNull(),
    chunksReceived: integer('chunks_received').notNull().default(0),
    chunkSizeBytes: integer('chunk_size_bytes').notNull(),
    status: uploadSessionStatus('status').notNull().default('in_progress'),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    completedAt: timestamp('completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // List/poll sessions for a given event by lifecycle state.
    eventStatusIdx: index('upload_sessions_event_status_idx').on(table.eventId, table.status),
    // GC scan: find orphaned in-progress sessions past their TTL.
    gcIdx: index('upload_sessions_gc_idx').on(table.status, table.expiresAt),
  }),
);

// ---------- photos ----------
// Canonical record for an uploaded original. Width/height/EXIF are filled in
// post-decode by the derivatives worker (F1.13); rows start in 'processing'.

export const photos = app.table(
  'photos',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK.
    eventId: uuid('event_id').notNull(),
    // refs users.id — cross-context, no FK.
    photographerUserId: uuid('photographer_user_id').notNull(),
    // Same-file FK is fine; sessions may be pruned independently of photos
    // once finalized, so set null on delete to preserve the photo row.
    uploadSessionId: uuid('upload_session_id').references(() => uploadSessions.id, {
      onDelete: 'set null',
    }),
    originalObjectKey: text('original_object_key').notNull(),
    originalBytes: bigint('original_bytes', { mode: 'bigint' }).notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    // From EXIF DateTimeOriginal; null until parsed by derivatives worker.
    capturedAt: timestamp('captured_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // Full EXIF blob kept for debugging and future filters (camera, lens, GPS).
    // GPS is scrubbed from delivered derivatives, not from this row.
    exifJsonb: jsonb('exif_jsonb'),
    status: photoStatus('status').notNull().default('processing'),
    // Soft-hide for moderation (F3.2). Distinct from status='hidden' which is
    // a terminal moderation state; `hidden=true` is a reversible toggle.
    hidden: boolean('hidden').notNull().default(false),
    // F3.2 moderation source of truth; kept in sync with `hidden` by the
    // moderation service ('hidden'->hidden=true, 'visible'->hidden=false).
    moderationStatus: photoModerationStatus('moderation_status').notNull().default('visible'),
    // Number of reports/auto-flags; drives moderation-queue severity ordering.
    flagCount: integer('flag_count').notNull().default(0),
    lastFlaggedAt: timestamp('last_flagged_at', { withTimezone: true, mode: 'date' }),
    // F3.13 dashboard surfacing.
    featured: boolean('featured').notNull().default(false),
    // Set by F3.5 takedown workflow. Non-null implies status='takedown'.
    takedownAt: timestamp('takedown_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    // updated_at: application or future trigger responsibility.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Primary gallery list query: visible photos in an event, newest first.
    eventListIdx: index('photos_event_list_idx').on(
      table.eventId,
      table.status,
      table.hidden,
      table.createdAt,
    ),
    // Time-sorted gallery using capture time rather than upload time.
    eventCapturedAtIdx: index('photos_event_captured_at_idx').on(table.eventId, table.capturedAt),
    // "My photos in event" for photographer dashboards.
    photographerEventIdx: index('photos_photographer_event_idx').on(
      table.photographerUserId,
      table.eventId,
    ),
  }),
);

// ---------- photo_derivatives ----------
// Generated renditions of a photo (F1.13). One row per (photo, kind).
// Cascade delete with the photo; storage cleanup is queued separately.

export const photoDerivatives = app.table(
  'photo_derivatives',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    photoId: uuid('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    kind: derivativeKind('kind').notNull(),
    objectKey: text('object_key').notNull(),
    bytes: integer('bytes').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    watermarked: boolean('watermarked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Only one derivative of each kind per photo.
    photoKindIdx: uniqueIndex('photo_derivatives_photo_kind_idx').on(table.photoId, table.kind),
  }),
);

// ---------- photo_reports ----------
// F3.2 — user/auto-generated reports feeding the moderation queue. reporterId
// null = anonymous report or system auto-flag. Cross-context refs, no FK.

export const photoReports = app.table(
  'photo_reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    photoId: uuid('photo_id').notNull(),
    reporterId: uuid('reporter_id'),
    reason: photoReportReason('reason').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    photoIdx: index('photo_reports_photo_idx').on(table.photoId),
  }),
);

// ---------- photo_views ----------
// F3.10 — cheap append-only view tracking for photographer analytics. viewerHash
// is a salted hash of IP+UA (no raw PII). Retained ~90 days (GC sweep later).

export const photoViews = app.table(
  'photo_views',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    photoId: uuid('photo_id').notNull(),
    viewerHash: text('viewer_hash').notNull(),
    source: text('source'),
    viewedAt: timestamp('viewed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    photoViewedIdx: index('photo_views_photo_viewed_idx').on(table.photoId, table.viewedAt),
    gcIdx: index('photo_views_gc_idx').on(table.viewedAt),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  uploadSessions,
  photos,
  photoDerivatives,
  photoReports,
  photoViews,
};

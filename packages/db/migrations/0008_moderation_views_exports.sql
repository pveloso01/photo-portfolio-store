-- M3 Wave 1 — moderation (F3.2), photographer view tracking (F3.10), audit
-- exports (F3.11). All objects live in the "app" schema.

-- ------------------------------------------------------------------ enums --

CREATE TYPE "app"."photo_moderation_status" AS ENUM ('visible', 'hidden', 'deleted');

CREATE TYPE "app"."photo_report_reason" AS ENUM (
  'inappropriate',
  'copyright',
  'privacy',
  'quality',
  'other'
);

CREATE TYPE "app"."audit_export_status" AS ENUM ('pending', 'running', 'ready', 'failed');

-- --------------------------------------------------------------- F3.2 photos --
-- moderation_status is the moderation source of truth; the legacy `hidden`
-- boolean is kept in sync by the moderation service so existing gallery queries
-- (which filter on hidden) keep working.

ALTER TABLE "app"."photos"
  ADD COLUMN "moderation_status" "app"."photo_moderation_status" NOT NULL DEFAULT 'visible';
ALTER TABLE "app"."photos" ADD COLUMN "flag_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "app"."photos" ADD COLUMN "last_flagged_at" timestamp with time zone;

-- Moderation queue ordering: severity (flag_count) then recency, scoped to
-- photos that need attention.
CREATE INDEX "photos_moderation_queue_idx"
  ON "app"."photos" ("flag_count", "last_flagged_at")
  WHERE "flag_count" > 0;

-- photo_reports: user/auto-generated reports that feed the moderation queue.
-- reporter_id is nullable (anonymous reports / auto-flags). refs photos.id and
-- users.id are cross-context (no FK).
CREATE TABLE "app"."photo_reports" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "photo_id"    uuid NOT NULL,                                    -- refs photos.id (cross-context)
  "reporter_id" uuid,                                             -- refs users.id (cross-context); null = anonymous/auto
  "reason"      "app"."photo_report_reason" NOT NULL,
  "notes"       text,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "photo_reports_photo_idx" ON "app"."photo_reports" ("photo_id");

-- --------------------------------------------------------- F3.10 photo_views --
-- Cheap append-only view tracking for photographer analytics. viewer_hash is a
-- salted hash of IP+UA (no raw PII). Retained 90 days (GC handled by a later
-- sweep). refs photos.id is cross-context (no FK).
CREATE TABLE "app"."photo_views" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "photo_id"    uuid NOT NULL,                                    -- refs photos.id (cross-context)
  "viewer_hash" text NOT NULL,
  "source"      text,
  "viewed_at"   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "photo_views_photo_viewed_idx" ON "app"."photo_views" ("photo_id", "viewed_at");
CREATE INDEX "photo_views_gc_idx" ON "app"."photo_views" ("viewed_at");

-- ------------------------------------------------------- F3.11 audit_exports --
-- Async audit-log CSV export jobs. file_key points at the R2 object once ready.
-- requested_by refs users.id (cross-context, no FK).
CREATE TABLE "app"."audit_exports" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "requested_by" uuid NOT NULL,                                   -- refs users.id (cross-context)
  "filters"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"       "app"."audit_export_status" NOT NULL DEFAULT 'pending',
  "row_count"    integer,
  "file_key"     text,
  "expires_at"   timestamp with time zone,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "audit_exports_requested_by_idx" ON "app"."audit_exports" ("requested_by", "created_at");

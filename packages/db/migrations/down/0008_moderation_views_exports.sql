-- Reverses 0008_moderation_views_exports.sql

DROP INDEX IF EXISTS "app"."audit_exports_requested_by_idx";
DROP TABLE IF EXISTS "app"."audit_exports";

DROP INDEX IF EXISTS "app"."photo_views_gc_idx";
DROP INDEX IF EXISTS "app"."photo_views_photo_viewed_idx";
DROP TABLE IF EXISTS "app"."photo_views";

DROP INDEX IF EXISTS "app"."photo_reports_photo_idx";
DROP TABLE IF EXISTS "app"."photo_reports";

DROP INDEX IF EXISTS "app"."photos_moderation_queue_idx";
ALTER TABLE "app"."photos" DROP COLUMN IF EXISTS "last_flagged_at";
ALTER TABLE "app"."photos" DROP COLUMN IF EXISTS "flag_count";
ALTER TABLE "app"."photos" DROP COLUMN IF EXISTS "moderation_status";

DROP TYPE IF EXISTS "app"."audit_export_status";
DROP TYPE IF EXISTS "app"."photo_report_reason";
DROP TYPE IF EXISTS "app"."photo_moderation_status";

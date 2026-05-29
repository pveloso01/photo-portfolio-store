-- Reverses 0009_takedowns_bipa.sql

DROP INDEX IF EXISTS "app"."consents_retention_window_idx";
ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "retention_window_ends_at";
ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "signature_payload";
ALTER TABLE "app"."consents" DROP COLUMN IF EXISTS "region";

DROP INDEX IF EXISTS "app"."takedown_verification_tokens_tracking_idx";
DROP TABLE IF EXISTS "app"."takedown_verification_tokens";

DROP TRIGGER IF EXISTS "set_takedown_sla_due_at" ON "app"."takedown_requests";
DROP FUNCTION IF EXISTS "app"."set_takedown_sla_due_at"();

DROP INDEX IF EXISTS "app"."takedown_requests_subject_user_idx";
DROP INDEX IF EXISTS "app"."takedown_requests_subject_email_idx";
DROP INDEX IF EXISTS "app"."takedown_requests_status_sla_idx";
DROP TABLE IF EXISTS "app"."takedown_requests";

DROP TYPE IF EXISTS "app"."takedown_status";
DROP TYPE IF EXISTS "app"."takedown_reason";

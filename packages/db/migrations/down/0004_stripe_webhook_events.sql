-- Reverses 0004_stripe_webhook_events.sql

DROP INDEX IF EXISTS "app"."stripe_webhook_events_unprocessed_idx";
DROP INDEX IF EXISTS "app"."stripe_webhook_events_type_idx";
DROP TABLE IF EXISTS "app"."stripe_webhook_events";

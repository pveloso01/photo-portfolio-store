-- F1.30 — Stripe webhook event log. Natural primary key (Stripe event id)
-- gives idempotency for free: a replayed event is a duplicate insert and is
-- rejected before any downstream side effects fire.

CREATE TABLE "app"."stripe_webhook_events" (
  "id" text PRIMARY KEY,                    -- Stripe event id (evt_*); natural pk gives idempotency for free
  "type" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,
  "payload_jsonb" jsonb NOT NULL,
  "result" text                             -- 'success' | 'ignored' | 'error'
);

CREATE INDEX "stripe_webhook_events_type_idx" ON "app"."stripe_webhook_events" ("type", "received_at");
CREATE INDEX "stripe_webhook_events_unprocessed_idx" ON "app"."stripe_webhook_events" ("received_at") WHERE "processed_at" IS NULL;

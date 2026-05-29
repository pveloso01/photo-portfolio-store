-- M3 Wave 2 — takedown workflow (F3.3) + BIPA per-state consent columns
-- (F3.8). All objects live in the "app" schema.

-- ------------------------------------------------------------------ enums --

CREATE TYPE "app"."takedown_reason" AS ENUM ('lgpd', 'gdpr', 'bipa', 'copyright', 'other');

CREATE TYPE "app"."takedown_status" AS ENUM (
  'received',
  'verifying',
  'fulfilled',
  'rejected'
);

-- ---------------------------------------------------- F3.3 takedown_requests --
-- Legally-binding takedown requests (LGPD Art. 18, GDPR Art. 17, BIPA 15(a)).
-- Separate from generic moderation so the SLA timer and legal evidence are
-- first-class. SLA hard cap: 24h from `received_at` to `sla_due_at`.
-- photo_ids is a text[] of uuids (some submissions reference photo ids without
-- the subject having any account; FK-free intentional). subject_user_id refs
-- users.id (cross-context, no FK).

CREATE TABLE "app"."takedown_requests" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_email"    text NOT NULL,
  "subject_user_id"  uuid,                                              -- refs users.id (cross-context)
  "photo_ids"        text[] NOT NULL DEFAULT '{}',
  "reason"           "app"."takedown_reason" NOT NULL,
  "legal_basis"      text NOT NULL,
  "evidence_url"     text,
  "status"           "app"."takedown_status" NOT NULL DEFAULT 'received',
  "sla_due_at"       timestamp with time zone NOT NULL,
  "received_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "verified_at"      timestamp with time zone,
  "fulfilled_at"     timestamp with time zone,
  "fulfilled_by"     uuid,                                              -- refs users.id (cross-context)
  "rejection_reason" text,
  "notes"            text,
  -- Append-only structured trail: every state transition + every artifact
  -- removed. App-layer enforces append-only; later we may add a trigger.
  "audit_trail"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "submitter_ip_hash" text                                              -- sha256(ip); raw never stored
);

CREATE INDEX "takedown_requests_status_sla_idx"
  ON "app"."takedown_requests" ("status", "sla_due_at");
CREATE INDEX "takedown_requests_subject_email_idx" ON "app"."takedown_requests" ("subject_email");
CREATE INDEX "takedown_requests_subject_user_idx"
  ON "app"."takedown_requests" ("subject_user_id")
  WHERE "subject_user_id" IS NOT NULL;

-- SLA trigger: auto-populate sla_due_at = received_at + 24h on insert when the
-- caller hasn't supplied it explicitly.
CREATE FUNCTION "app"."set_takedown_sla_due_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.received_at IS NULL THEN
    NEW.received_at := now();
  END IF;
  IF NEW.sla_due_at IS NULL THEN
    NEW.sla_due_at := NEW.received_at + interval '24 hours';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "set_takedown_sla_due_at"
  BEFORE INSERT ON "app"."takedown_requests"
  FOR EACH ROW EXECUTE FUNCTION "app"."set_takedown_sla_due_at"();

-- F3.4 — email verification tokens. token_hash is sha256(token); raw token is
-- emailed once and never persisted. 24h expiry.
CREATE TABLE "app"."takedown_verification_tokens" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tracking_id"  uuid NOT NULL REFERENCES "app"."takedown_requests" ("id") ON DELETE CASCADE,
  "token_hash"   text NOT NULL UNIQUE,
  "expires_at"   timestamp with time zone NOT NULL,
  "consumed_at"  timestamp with time zone,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "takedown_verification_tokens_tracking_idx"
  ON "app"."takedown_verification_tokens" ("tracking_id");

-- ----------------------------------------------------- F3.8 BIPA consent cols --
-- region is ISO 3166-2 (e.g. 'US-IL') for per-state BIPA gating. signature is
-- the full signed-consent payload (statutory disclosure hash + timestamp).
-- retention_window_ends_at is the computed destruction deadline (3y for IL,
-- after 1y inactivity for TX, etc.) — set by app code based on jurisdiction +
-- granted_at.

ALTER TABLE "app"."consents" ADD COLUMN "region" text;
ALTER TABLE "app"."consents" ADD COLUMN "signature_payload" jsonb;
ALTER TABLE "app"."consents"
  ADD COLUMN "retention_window_ends_at" timestamp with time zone;

CREATE INDEX "consents_retention_window_idx"
  ON "app"."consents" ("retention_window_ends_at")
  WHERE "retention_window_ends_at" IS NOT NULL AND "revoked_at" IS NULL;

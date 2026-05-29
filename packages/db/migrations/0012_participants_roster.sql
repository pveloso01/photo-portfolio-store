-- M4 Wave 1 — F4.5 CSV roster import: participants + roster_imports.
-- Manual roster ingest path for events without a timing provider.

CREATE TYPE "app"."roster_import_status" AS ENUM ('previewed', 'imported', 'failed');

CREATE TABLE "app"."participants" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   uuid NOT NULL,                                  -- refs events.id (cross-context)
  -- bib is text to preserve leading zeros and alphanumeric bibs.
  "bib"        text NOT NULL,
  "name"       text NOT NULL,
  "email"      text,                                           -- normalized (lowercase) by import
  "phone"      text,
  "team"       text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- One participant per (event, bib).
CREATE UNIQUE INDEX "participants_event_bib_idx" ON "app"."participants" ("event_id", "bib");
-- Lookup by email within an event (notification targeting, F4.12).
CREATE INDEX "participants_event_email_idx" ON "app"."participants" ("event_id", "email");

CREATE TABLE "app"."roster_imports" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"      uuid NOT NULL,
  "filename"      text NOT NULL,
  "total_rows"    integer NOT NULL DEFAULT 0,
  "imported_rows" integer NOT NULL DEFAULT 0,
  "skipped_rows"  integer NOT NULL DEFAULT 0,
  "status"        "app"."roster_import_status" NOT NULL DEFAULT 'previewed',
  "report_json"   jsonb,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "roster_imports_event_idx" ON "app"."roster_imports" ("event_id", "created_at");

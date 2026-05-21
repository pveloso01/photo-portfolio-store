-- F2.12 payout idempotency + F2.5 order discount persistence.
-- All objects live in the "app" schema.

-- Payout idempotency: at most one payout per (account, period_end).
CREATE UNIQUE INDEX "payouts_account_period_unique"
  ON "app"."payouts" ("payout_account_id", "period_end");

-- Ledger idempotency for payout entries: one entry per (payout, account, direction).
CREATE UNIQUE INDEX "ledger_entries_payout_dedupe_idx"
  ON "app"."ledger_entries" ("payout_id", "account_id", "direction")
  WHERE "payout_id" IS NOT NULL;

-- F2.5 — persist the evaluated discount + breakdown on the order (receipts/disputes).
ALTER TABLE "app"."orders"
  ADD COLUMN "discount_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "app"."orders"
  ADD COLUMN "pricing_breakdown" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Reverses 0007_payouts_and_discounts.sql

ALTER TABLE "app"."orders" DROP COLUMN IF EXISTS "pricing_breakdown";
ALTER TABLE "app"."orders" DROP COLUMN IF EXISTS "discount_cents";

DROP INDEX IF EXISTS "app"."ledger_entries_payout_dedupe_idx";
DROP INDEX IF EXISTS "app"."payouts_account_period_unique";

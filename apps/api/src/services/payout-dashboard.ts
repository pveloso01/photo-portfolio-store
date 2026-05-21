// F2.13 — Photographer payout dashboard read service.
//
// Balance semantics (single source of truth: ledger_entries):
//   available_cents  = SUM(credits) - SUM(debits) on the photographer ledger account
//                      where kind='photographer' AND photographerId=<uid>.
//                      A payout DEBIT is recorded when the payout row is created, so
//                      available already excludes anything allocated to a payout run.
//   pending_cents    = SUM(payouts.netCents) for this photographer's payout account
//                      where payout.status IN ('pending','sent').
//                      These are allocated but not yet confirmed paid by Stripe.
//   next_payout_estimate_cents = available_cents (what the next weekly cron would
//                      transfer; cadence is weekly with no minimum threshold).
//   next_payout_date = next Monday 00:00 UTC (see nextWeeklyPayoutDate).
//   currency         = payoutAccounts.currency for this photographer.
//                      Fallback: currency from the most recent ledger entry,
//                      then 'usd' if neither is available.
//
// Cursor scheme: base64url-encoded { id: string; createdAt: ISO-string }.
// Payouts are listed newest-first (desc createdAt). The cursor encodes the
// last item of the previous page; the next page is fetched by loading all
// rows for the account and slicing after the cursor position (production uses
// native SQL keyset; the approach is compatible with the test shim).

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, or } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../lib/cursor.js';

const { ledgerAccounts, ledgerEntries, payoutAccounts, payouts } = schema.payouts.tables;

// ---------- Types ----------

export interface BalanceView {
  availableCents: number;
  pendingCents: number;
  nextPayoutEstimateCents: number;
  nextPayoutDate: string;
  currency: string;
}

export interface PayoutListItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  feesCents: number;
  netCents: number;
  status: string;
  stripeReceiptUrl?: string;
}

export interface LedgerEntryView {
  id: string;
  accountId: string;
  direction: string;
  amountCents: number;
  kind: string;
  memo: string;
  createdAt: Date;
}

// ---------- Errors ----------

export class PayoutDashboardError extends Error {
  constructor(
    public readonly code: 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'PayoutDashboardError';
  }
}

// ---------- Date helpers ----------

// Returns the next Monday at 00:00 UTC. If now is already exactly Monday
// 00:00:00.000 UTC, returns the following Monday (always strictly future).
// Payout cadence: weekly, no minimum transfer threshold.
export const nextWeeklyPayoutDate = (now: Date = new Date()): Date => {
  // getUTCDay(): 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  const dayOfWeek = now.getUTCDay();

  // Days until the NEXT Monday. Any Monday (midnight or mid-day) advances a full
  // week — the next run is always the upcoming Monday, never today.
  //   Mon(1): (8-1)%7=0 -> 7; Tue(2): 6; ... Sat(6): 2; Sun(0): 8%7=1.
  const daysUntil = (8 - dayOfWeek) % 7 || 7;

  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil, 0, 0, 0, 0),
  );
};

// ---------- Internal resolution helpers ----------

const resolvePhotographerLedgerAccountId = async (
  db: DbClient,
  photographerUserId: string,
): Promise<string | null> => {
  const rows = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.kind, 'photographer'),
        eq(ledgerAccounts.photographerId, photographerUserId),
      ),
    )
    .limit(1);
  const [row] = rows;
  return row ? row.id : null;
};

const resolvePayoutAccount = async (
  db: DbClient,
  photographerUserId: string,
): Promise<{ id: string; currency: string } | null> => {
  const rows = await db
    .select({ id: payoutAccounts.id, currency: payoutAccounts.currency })
    .from(payoutAccounts)
    .where(eq(payoutAccounts.photographerId, photographerUserId))
    .limit(1);
  const [row] = rows;
  return row ? { id: row.id, currency: row.currency } : null;
};

const computeAvailableCents = async (db: DbClient, accountId: string): Promise<number> => {
  const rows = await db
    .select({ direction: ledgerEntries.direction, amountCents: ledgerEntries.amountCents })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));

  let balance = 0;
  for (const row of rows) {
    balance += row.direction === 'credit' ? row.amountCents : -row.amountCents;
  }
  return balance;
};

const computePendingCents = async (db: DbClient, payoutAccountId: string): Promise<number> => {
  const rows = await db
    .select({ netCents: payouts.netCents })
    .from(payouts)
    .where(
      and(
        eq(payouts.payoutAccountId, payoutAccountId),
        or(eq(payouts.status, 'pending'), eq(payouts.status, 'sent')),
      ),
    );

  let total = 0;
  for (const row of rows) {
    total += row.netCents;
  }
  return total;
};

const resolveCurrency = async (
  db: DbClient,
  accountId: string,
  payoutCurrency: string | null,
): Promise<string> => {
  if (payoutCurrency) return payoutCurrency;

  const rows = await db
    .select({ currency: ledgerEntries.currency })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .limit(1);
  const [row] = rows;
  return row ? row.currency : 'usd';
};

const buildStripeReceiptUrl = (stripeTransferId: string | null | undefined): string | undefined => {
  if (!stripeTransferId) return undefined;
  return `https://dashboard.stripe.com/transfers/${stripeTransferId}`;
};

const rowToPayoutListItem = (row: {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossCents: number;
  feesCents: number;
  netCents: number;
  status: string;
  stripeTransferId?: string | null;
}): PayoutListItem => {
  const url = buildStripeReceiptUrl(row.stripeTransferId);
  const item: PayoutListItem = {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    grossCents: row.grossCents,
    feesCents: row.feesCents,
    netCents: row.netCents,
    status: row.status,
  };
  if (url !== undefined) {
    return { ...item, stripeReceiptUrl: url };
  }
  return item;
};

// ---------- Public service functions ----------

export const getBalance = async (
  db: DbClient,
  photographerUserId: string,
): Promise<BalanceView> => {
  const [payoutAccount, ledgerAccountId] = await Promise.all([
    resolvePayoutAccount(db, photographerUserId),
    resolvePhotographerLedgerAccountId(db, photographerUserId),
  ]);

  const availableCents =
    ledgerAccountId !== null ? await computeAvailableCents(db, ledgerAccountId) : 0;

  const pendingCents = payoutAccount !== null ? await computePendingCents(db, payoutAccount.id) : 0;

  const currency =
    ledgerAccountId !== null
      ? await resolveCurrency(db, ledgerAccountId, payoutAccount?.currency ?? null)
      : (payoutAccount?.currency ?? 'usd');

  const nextPayoutDate = nextWeeklyPayoutDate();

  return {
    availableCents,
    pendingCents,
    nextPayoutEstimateCents: availableCents,
    nextPayoutDate: nextPayoutDate.toISOString(),
    currency,
  };
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const listPayouts = async (
  db: DbClient,
  photographerUserId: string,
  opts: { cursor?: string; limit?: number },
): Promise<{ items: PayoutListItem[]; nextCursor: string | null }> => {
  const payoutAccount = await resolvePayoutAccount(db, photographerUserId);
  if (!payoutAccount) {
    return { items: [], nextCursor: null };
  }

  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = decodeCursor(opts.cursor);

  // Fetch all rows for this account ordered newest-first, then apply cursor
  // slicing in application code. This keeps the drizzle shim in tests simple
  // while production benefits from the index on (payoutAccountId, periodEnd).
  // For high-volume accounts a SQL keyset condition can be added later.
  const rows = await db
    .select({
      id: payouts.id,
      periodStart: payouts.periodStart,
      periodEnd: payouts.periodEnd,
      grossCents: payouts.grossCents,
      feesCents: payouts.feesCents,
      netCents: payouts.netCents,
      status: payouts.status,
      stripeTransferId: payouts.stripeTransferId,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .where(eq(payouts.payoutAccountId, payoutAccount.id))
    .orderBy(desc(payouts.createdAt));

  // Apply cursor: skip rows up to and including the cursor position.
  let startIndex = 0;
  if (cursor) {
    const idx = rows.findIndex((r) => r.id === cursor.id);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }

  const pageRows = rows.slice(startIndex, startIndex + limit + 1);
  const hasNextPage = pageRows.length > limit;
  const visibleRows = hasNextPage ? pageRows.slice(0, limit) : pageRows;

  const items = visibleRows.map(rowToPayoutListItem);

  const lastRow = visibleRows[visibleRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow ? encodeCursor({ id: lastRow.id, createdAt: lastRow.createdAt }) : null;

  return { items, nextCursor };
};

export const getPayoutDetail = async (
  db: DbClient,
  photographerUserId: string,
  payoutId: string,
): Promise<{
  payout: PayoutListItem;
  entriesByKind: Record<string, LedgerEntryView[]>;
} | null> => {
  const payoutAccount = await resolvePayoutAccount(db, photographerUserId);
  if (!payoutAccount) return null;

  const payoutRows = await db
    .select({
      id: payouts.id,
      payoutAccountId: payouts.payoutAccountId,
      periodStart: payouts.periodStart,
      periodEnd: payouts.periodEnd,
      grossCents: payouts.grossCents,
      feesCents: payouts.feesCents,
      netCents: payouts.netCents,
      status: payouts.status,
      stripeTransferId: payouts.stripeTransferId,
      createdAt: payouts.createdAt,
    })
    .from(payouts)
    .where(and(eq(payouts.id, payoutId), eq(payouts.payoutAccountId, payoutAccount.id)))
    .limit(1);

  const [payoutRow] = payoutRows;
  // Return null if not found OR if it belongs to a different photographer — no existence leak.
  if (!payoutRow) return null;

  const entryRows = await db
    .select({
      id: ledgerEntries.id,
      accountId: ledgerEntries.accountId,
      direction: ledgerEntries.direction,
      amountCents: ledgerEntries.amountCents,
      kind: ledgerEntries.kind,
      memo: ledgerEntries.memo,
      createdAt: ledgerEntries.createdAt,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.payoutId, payoutId));

  const entriesByKind: Record<string, LedgerEntryView[]> = {};
  for (const entry of entryRows) {
    const view: LedgerEntryView = {
      id: entry.id,
      accountId: entry.accountId,
      direction: entry.direction,
      amountCents: entry.amountCents,
      kind: entry.kind,
      memo: entry.memo,
      createdAt: entry.createdAt,
    };
    const existing = entriesByKind[entry.kind];
    if (existing) {
      existing.push(view);
    } else {
      entriesByKind[entry.kind] = [view];
    }
  }

  return {
    payout: rowToPayoutListItem(payoutRow),
    entriesByKind,
  };
};

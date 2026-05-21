// F2.12 — payout run + reconciliation.
//
// CADENCE: weekly, no minimum (min_payout_cents = 0) — locked product decision.
//
// MODEL: a payout settles a photographer's owed ledger balance.
//   net = accountBalanceCents(photographer) = SUM(sale credits) - SUM(refund debits)
//         - SUM(prior payout debits). After this payout's debit posts, balance -> 0.
//   The payout writes a BALANCED pair (both kind='payout', payoutId set) ONLY on
//   transfer success:
//     DEBIT  photographer   net   (reduces what we owe)
//     CREDIT platform_cash  net   (cash leaves the platform)
//   A FAILED transfer writes no ledger entry, so the balance stays put and the
//   funds roll into the next period (or a manual retry). The transfer.paid
//   webhook re-posts the pair idempotently to cover a crash between a successful
//   transfer and the ledger write. A sent->failed transition reverses the pair.
//   Idempotency: payouts unique (payout_account_id, period_end); the ledger payout
//   dedupe index (payout_id, account_id, direction); Stripe idempotency key
//   `payout:{payout_id}`. Re-running the cron for a period is a no-op.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import type Stripe from 'stripe';

import { writeAudit } from '../lib/audit.js';
import { stripe as defaultStripe } from '../lib/stripe.js';
import {
  type LedgerEntryInput,
  accountBalanceCents,
  ensurePhotographerAccount,
  getPlatformAccountId,
  postLedgerBatch,
} from './ledger.js';

const { payoutAccounts, payouts, ledgerAccounts, ledgerEntries } = schema.payouts.tables;

// ---------- Config ----------

export const MIN_PAYOUT_CENTS = 0;

// ---------- Seams ----------

export type StripeTransferClient = Pick<Stripe, 'transfers'>;

export type PayoutAlert = (message: string, context: Record<string, unknown>) => void;

// ---------- Errors ----------

export class PayoutError extends Error {
  constructor(
    public readonly code: 'mismatch' | 'not_found' | 'not_failed' | 'no_stripe_account',
    message: string,
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

// ---------- Types ----------

export interface PayoutSummary {
  payoutId: string;
  payoutAccountId: string;
  photographerId: string;
  netCents: number;
  currency: string;
  status: string;
}

export interface RunPayoutsOptions {
  now?: Date;
  minPayoutCents?: number;
  stripe?: StripeTransferClient;
  alert?: PayoutAlert;
}

export interface RunPayoutsResult {
  created: PayoutSummary[];
  skipped: Array<{ payoutAccountId: string; reason: string }>;
}

// ---------- Helpers ----------

const toDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

interface PeriodTotals {
  grossCents: number;
  refundCents: number;
}

// Sum sale credits and refund debits on the account since `since` (exclusive).
const periodTotals = async (
  db: DbClient,
  ledgerAccountId: string,
  since: Date,
): Promise<PeriodTotals> => {
  const rows = await db
    .select({
      direction: ledgerEntries.direction,
      amountCents: ledgerEntries.amountCents,
      kind: ledgerEntries.kind,
    })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountId, ledgerAccountId), gt(ledgerEntries.createdAt, since)));

  let grossCents = 0;
  let refundCents = 0;
  for (const row of rows) {
    if (row.kind === 'sale' && row.direction === 'credit') grossCents += row.amountCents;
    else if (row.kind === 'refund' && row.direction === 'debit') refundCents += row.amountCents;
  }
  return { grossCents, refundCents };
};

const latestPayout = async (
  db: DbClient,
  payoutAccountId: string,
): Promise<{ periodEnd: string } | undefined> => {
  const rows = await db
    .select({ periodEnd: payouts.periodEnd })
    .from(payouts)
    .where(eq(payouts.payoutAccountId, payoutAccountId))
    .orderBy(desc(payouts.periodEnd))
    .limit(1);
  return rows[0];
};

// Build the balanced payout ledger pair.
const payoutLedgerPair = (
  photographerAccountId: string,
  platformCashAccountId: string,
  netCents: number,
  currency: string,
  payoutId: string,
): LedgerEntryInput[] => [
  {
    accountId: photographerAccountId,
    direction: 'debit',
    amountCents: netCents,
    currency,
    kind: 'payout',
    memo: `payout ${payoutId} to photographer`,
    payoutId,
  },
  {
    accountId: platformCashAccountId,
    direction: 'credit',
    amountCents: netCents,
    currency,
    kind: 'payout',
    memo: `payout ${payoutId} cash out`,
    payoutId,
  },
];

const isUniqueViolation = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const code = (err as unknown as { code?: string }).code;
  return code === '23505' || /unique|duplicate/i.test(err.message);
};

// ---------- Run ----------

export const runPayouts = async (
  db: DbClient,
  opts: RunPayoutsOptions = {},
): Promise<RunPayoutsResult> => {
  const now = opts.now ?? new Date();
  const minPayoutCents = opts.minPayoutCents ?? MIN_PAYOUT_CENTS;
  const stripe = opts.stripe ?? defaultStripe;
  const periodEnd = toDateOnly(now);

  const accounts = await db
    .select({
      id: payoutAccounts.id,
      photographerId: payoutAccounts.photographerId,
      stripeAccountId: payoutAccounts.stripeAccountId,
      currency: payoutAccounts.currency,
      payoutsEnabled: payoutAccounts.payoutsEnabled,
      createdAt: payoutAccounts.createdAt,
    })
    .from(payoutAccounts)
    .where(eq(payoutAccounts.payoutsEnabled, true));

  const created: PayoutSummary[] = [];
  const skipped: Array<{ payoutAccountId: string; reason: string }> = [];

  for (const account of accounts) {
    if (!account.stripeAccountId) {
      skipped.push({ payoutAccountId: account.id, reason: 'no_stripe_account' });
      continue;
    }

    const ledgerAccountId = await ensurePhotographerAccount(db, account.photographerId);
    const netCents = await accountBalanceCents(db, ledgerAccountId);
    if (netCents <= minPayoutCents) {
      skipped.push({ payoutAccountId: account.id, reason: 'below_minimum' });
      continue;
    }

    const last = await latestPayout(db, account.id);
    const since = last ? new Date(last.periodEnd) : account.createdAt;
    const { grossCents, refundCents } = await periodTotals(db, ledgerAccountId, since);

    // Defensive: the transfer amount must equal the ledger-computed net.
    if (grossCents - refundCents !== netCents) {
      opts.alert?.('payout net mismatch — aborting account', {
        payoutAccountId: account.id,
        netCents,
        grossCents,
        refundCents,
      });
      skipped.push({ payoutAccountId: account.id, reason: 'net_mismatch' });
      continue;
    }

    const periodStart = last ? last.periodEnd : toDateOnly(account.createdAt);

    // Create the payout row (pending). Unique (account, period_end) makes a
    // duplicate run for the same period a no-op.
    let payoutId: string;
    try {
      const inserted = await db
        .insert(payouts)
        .values({
          payoutAccountId: account.id,
          periodStart,
          periodEnd,
          grossCents,
          feesCents: refundCents,
          netCents,
          currency: account.currency,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: payouts.id });
      const row = inserted[0];
      if (!row) {
        skipped.push({ payoutAccountId: account.id, reason: 'already_run_this_period' });
        continue;
      }
      payoutId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        skipped.push({ payoutAccountId: account.id, reason: 'already_run_this_period' });
        continue;
      }
      throw err;
    }

    // Issue the Stripe Connect transfer. The ledger pair is posted only on
    // success — a failed transfer writes nothing so the balance rolls over.
    const cashAccountId = await getPlatformAccountId(db, 'platform_cash');
    try {
      const transfer = await stripe.transfers.create(
        {
          amount: netCents,
          currency: account.currency,
          destination: account.stripeAccountId,
        },
        { idempotencyKey: `payout:${payoutId}` },
      );
      await postLedgerBatch(
        db,
        payoutLedgerPair(ledgerAccountId, cashAccountId, netCents, account.currency, payoutId),
      );
      await db
        .update(payouts)
        .set({ status: 'sent', stripeTransferId: transfer.id, sentAt: now })
        .where(eq(payouts.id, payoutId));
      await writeAudit(db, {
        action: 'payout.sent',
        actorKind: 'cron',
        targetKind: 'payout',
        targetId: payoutId,
        payload: { payoutAccountId: account.id, netCents, transferId: transfer.id },
      });
      created.push({
        payoutId,
        payoutAccountId: account.id,
        photographerId: account.photographerId,
        netCents,
        currency: account.currency,
        status: 'sent',
      });
    } catch (err) {
      await db.update(payouts).set({ status: 'failed' }).where(eq(payouts.id, payoutId));
      await writeAudit(db, {
        action: 'payout.failed',
        actorKind: 'cron',
        targetKind: 'payout',
        targetId: payoutId,
        payload: { netCents, error: err instanceof Error ? err.message : String(err) },
      });
      opts.alert?.('payout transfer failed', {
        payoutId,
        payoutAccountId: account.id,
        error: err instanceof Error ? err.message : String(err),
      });
      created.push({
        payoutId,
        payoutAccountId: account.id,
        photographerId: account.photographerId,
        netCents,
        currency: account.currency,
        status: 'failed',
      });
    }
  }

  return { created, skipped };
};

// Was the payout's ledger pair already posted (i.e. a transfer once succeeded)?
const payoutPairExists = async (db: DbClient, payoutId: string): Promise<boolean> => {
  const rows = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.payoutId, payoutId),
        eq(ledgerEntries.kind, 'payout'),
        eq(ledgerEntries.direction, 'debit'),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

// Reverse a previously-posted payout pair (flipped directions; distinct under
// the payout dedupe index).
const reversePayoutPair = async (
  db: DbClient,
  payoutId: string,
  photographerAccountId: string,
  platformCashAccountId: string,
  netCents: number,
  currency: string,
): Promise<void> => {
  await postLedgerBatch(db, [
    {
      accountId: photographerAccountId,
      direction: 'credit',
      amountCents: netCents,
      currency,
      kind: 'payout',
      memo: `payout ${payoutId} reversal (transfer failed)`,
      payoutId,
    },
    {
      accountId: platformCashAccountId,
      direction: 'debit',
      amountCents: netCents,
      currency,
      kind: 'payout',
      memo: `payout ${payoutId} reversal cash`,
      payoutId,
    },
  ]);
};

// ---------- Webhook reconciliation ----------

export const reconcilePayoutFromWebhook = async (
  db: DbClient,
  event: { type: string; transfer: { id: string } },
  opts: { alert?: PayoutAlert } = {},
): Promise<void> => {
  const rows = await db
    .select({
      id: payouts.id,
      status: payouts.status,
      payoutAccountId: payouts.payoutAccountId,
      netCents: payouts.netCents,
      currency: payouts.currency,
    })
    .from(payouts)
    .where(eq(payouts.stripeTransferId, event.transfer.id))
    .limit(1);
  const payout = rows[0];
  if (!payout) return;

  const resolvePhotographerAccountId = async (): Promise<string | undefined> => {
    const acctRows = await db
      .select({ photographerId: payoutAccounts.photographerId })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.id, payout.payoutAccountId))
      .limit(1);
    const acct = acctRows[0];
    if (!acct) return undefined;
    const accRows = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.kind, 'photographer'),
          eq(ledgerAccounts.photographerId, acct.photographerId),
        ),
      )
      .limit(1);
    return accRows[0]?.id;
  };

  if (event.type === 'transfer.paid' || event.type === 'transfer.updated') {
    // Backstop: if the cron crashed after a successful transfer but before the
    // ledger write, post the pair now (idempotent), then mark paid.
    const photographerAccountId = await resolvePhotographerAccountId();
    if (photographerAccountId) {
      const cashAccountId = await getPlatformAccountId(db, 'platform_cash');
      await postLedgerBatch(
        db,
        payoutLedgerPair(
          photographerAccountId,
          cashAccountId,
          payout.netCents,
          payout.currency,
          payout.id,
        ),
      );
    }
    if (payout.status === 'paid') return;
    await db
      .update(payouts)
      .set({ status: 'paid', paidAt: new Date() })
      .where(eq(payouts.id, payout.id));
    await writeAudit(db, {
      action: 'payout.paid',
      actorKind: 'webhook',
      targetKind: 'payout',
      targetId: payout.id,
      payload: { transferId: event.transfer.id },
    });
    return;
  }

  if (event.type === 'transfer.failed') {
    if (payout.status === 'failed') return;
    // Only reverse if a pair was actually posted (a prior 'sent').
    if (await payoutPairExists(db, payout.id)) {
      const photographerAccountId = await resolvePhotographerAccountId();
      const cashAccountId = await getPlatformAccountId(db, 'platform_cash');
      if (photographerAccountId) {
        await reversePayoutPair(
          db,
          payout.id,
          photographerAccountId,
          cashAccountId,
          payout.netCents,
          payout.currency,
        );
      }
    }
    await db.update(payouts).set({ status: 'failed' }).where(eq(payouts.id, payout.id));
    await writeAudit(db, {
      action: 'payout.failed',
      actorKind: 'webhook',
      targetKind: 'payout',
      targetId: payout.id,
      payload: { transferId: event.transfer.id, reversed: true },
    });
    opts.alert?.('payout reported failed by Stripe', { payoutId: payout.id });
  }
};

// ---------- Manual retry (admin) ----------

export const retryPayout = async (
  db: DbClient,
  payoutId: string,
  opts: { stripe?: StripeTransferClient; now?: Date } = {},
): Promise<PayoutSummary> => {
  const stripe = opts.stripe ?? defaultStripe;
  const now = opts.now ?? new Date();

  const rows = await db
    .select({
      id: payouts.id,
      status: payouts.status,
      payoutAccountId: payouts.payoutAccountId,
      netCents: payouts.netCents,
      currency: payouts.currency,
    })
    .from(payouts)
    .where(eq(payouts.id, payoutId))
    .limit(1);
  const payout = rows[0];
  if (!payout) throw new PayoutError('not_found', 'payout not found');
  if (payout.status !== 'failed') {
    throw new PayoutError('not_failed', `payout is ${payout.status}, only failed payouts retry`);
  }

  const acctRows = await db
    .select({
      photographerId: payoutAccounts.photographerId,
      stripeAccountId: payoutAccounts.stripeAccountId,
    })
    .from(payoutAccounts)
    .where(eq(payoutAccounts.id, payout.payoutAccountId))
    .limit(1);
  const account = acctRows[0];
  if (!account?.stripeAccountId) {
    throw new PayoutError('no_stripe_account', 'payout account has no Stripe account');
  }

  const ledgerAccountId = await ensurePhotographerAccount(db, account.photographerId);
  const cashAccountId = await getPlatformAccountId(db, 'platform_cash');

  // Re-post the payout pair (the failed run reversed it). A fresh idempotency
  // key — the prior key may map to a permanently-failed transfer.
  await postLedgerBatch(
    db,
    payoutLedgerPair(ledgerAccountId, cashAccountId, payout.netCents, payout.currency, payoutId),
  );

  const transfer = await stripe.transfers.create(
    { amount: payout.netCents, currency: payout.currency, destination: account.stripeAccountId },
    { idempotencyKey: `payout:${payoutId}:retry:${now.getTime()}` },
  );
  await db
    .update(payouts)
    .set({ status: 'sent', stripeTransferId: transfer.id, sentAt: now })
    .where(eq(payouts.id, payoutId));
  await writeAudit(db, {
    action: 'payout.retried',
    actorKind: 'admin',
    targetKind: 'payout',
    targetId: payoutId,
    payload: { transferId: transfer.id },
  });

  return {
    payoutId,
    payoutAccountId: payout.payoutAccountId,
    photographerId: account.photographerId,
    netCents: payout.netCents,
    currency: payout.currency,
    status: 'sent',
  };
};

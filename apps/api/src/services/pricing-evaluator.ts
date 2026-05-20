// Pricing-rule evaluator (F2.5). Pure: no DB writes.
//
// PCT CONVENTION
// --------------
// All `pct` values in rule params are INTEGER PERCENT (0..100).
// Example: pct:10 means a 10% discount. Conversion to fraction (/ 100) happens
// internally before computing cent amounts. This matches the issue examples
// (e.g. "pct:10", "pct:15") and avoids floating-point confusion at boundaries.
//
// PRECEDENCE + STACKABILITY ALGORITHM
// ------------------------------------
// 1. Load all active rules of kind in (qty_discount, time_window, pre_event)
//    that are scoped to 'global' OR explicitly targeted at ctx.eventId via
//    pricing_rule_targets (targetType='event'). tier_uplift rules are excluded.
// 2. Filter to rules that are currently applicable:
//      qty_discount  -> at least one tier threshold (min) is met by totalQuantity
//      time_window   -> now is within [rule.startsAt, rule.endsAt]
//      pre_event     -> now is within [eventDate - days_before*days, eventDate)
// 3. Sort survivors by:
//      a. priority DESC  (higher number = evaluated first)
//      b. scope specificity DESC:
//           bundle=4 > photographer=3 > event=2 > global=1
//      c. createdAt ASC  (older rule wins on tie)
// 4. Apply discounts:
//      a. Take the first (highest-precedence) rule as the "top rule".
//      b. If top rule is NOT stackable: apply it alone and stop.
//      c. If top rule IS stackable: collect it plus every subsequent rule in the
//         sorted list that also has stackable:true. Apply them sequentially on the
//         running subtotal — each discount is computed on the amount remaining
//         after earlier discounts, never on the original subtotal. This prevents
//         double-counting and guarantees the combined discount cannot exceed 100%.
// 5. Clamp: sum(discounts) is clamped to subtotalCents. totalCents = max(0, subtotal - sum).
//    All cent amounts use Math.round. totalCents is always >= 0.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

const { pricingRules, pricingRuleTargets } = schema.catalog.tables;
const { events } = schema.events.tables;

// ---------- Public types ----------

export interface EvalLineItem {
  productId?: string;
  bundleId?: string;
  photoId?: string;
  licenseTierId?: string;
  unitPriceCents: number;
  quantity: number;
}

export interface EvalContext {
  eventId?: string;
  buyerId?: string;
  now?: Date;
}

export interface EvalDiscount {
  ruleId: string;
  label: string;
  amountCents: number;
}

export interface EvalResult {
  subtotalCents: number;
  discounts: EvalDiscount[];
  totalCents: number;
  currency: string;
}

// ---------- Error ----------

export class PricingEvalError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'mixed_currency',
    message: string,
  ) {
    super(message);
    this.name = 'PricingEvalError';
  }
}

// ---------- Zod params schemas ----------

const qtyTierSchema = z.object({
  min: z.number(),
  pct: z.number().min(0).max(100),
});

export const qtyDiscountParamsSchema = z.object({
  tiers: z.array(qtyTierSchema).min(1),
  stackable: z.boolean().optional(),
});

export const timeWindowParamsSchema = z.object({
  // pct is integer percent 0..100.
  pct: z.number().min(0).max(100),
  stackable: z.boolean().optional(),
});

export const preEventParamsSchema = z.object({
  days_before: z.number().int().positive(),
  // pct is integer percent 0..100.
  pct: z.number().min(0).max(100),
  stackable: z.boolean().optional(),
});

export type QtyDiscountParams = z.infer<typeof qtyDiscountParamsSchema>;
export type TimeWindowParams = z.infer<typeof timeWindowParamsSchema>;
export type PreEventParams = z.infer<typeof preEventParamsSchema>;

// ---------- Scope specificity weights ----------

const SCOPE_WEIGHT: Readonly<Record<string, number>> = {
  bundle: 4,
  photographer: 3,
  event: 2,
  global: 1,
};

function scopeWeight(scope: string): number {
  return SCOPE_WEIGHT[scope] ?? 0;
}

// ---------- Exported pure helpers (testable in isolation) ----------

/**
 * Given qty_discount params and totalQuantity, return the best matching pct
 * (integer 0..100) or null when no tier threshold is met.
 * "Best" = highest `min` that is still <= totalQuantity.
 */
export function selectQtyDiscountPct(
  params: QtyDiscountParams,
  totalQuantity: number,
): number | null {
  // Sort descending by min to find the highest applicable tier first.
  const sorted = [...params.tiers].sort((a, b) => b.min - a.min);
  const [best] = sorted.filter((t) => t.min <= totalQuantity);
  if (!best) return null;
  return best.pct;
}

/**
 * Returns true when `now` falls within [startsAt, endsAt] (both inclusive).
 * A null boundary is open (no constraint on that side).
 */
export function isTimeWindowActive(now: Date, startsAt: Date | null, endsAt: Date | null): boolean {
  if (startsAt !== null && now < startsAt) return false;
  if (endsAt !== null && now > endsAt) return false;
  return true;
}

/**
 * Returns true when `now` is within the pre-event discount window:
 * [eventDate - daysBefore*days, eventDate)  — exclusive of event day itself.
 */
export function isPreEventActive(now: Date, eventDate: Date, daysBefore: number): boolean {
  const windowStart = new Date(eventDate.getTime() - daysBefore * 24 * 60 * 60 * 1000);
  return now >= windowStart && now < eventDate;
}

// ---------- Internal types ----------

interface CandidateRule {
  id: string;
  scope: string;
  kind: string;
  params: unknown;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
}

// ---------- Main evaluator ----------

export async function evaluatePricing(
  db: DbClient,
  items: EvalLineItem[],
  ctx: EvalContext,
  currency: string,
): Promise<EvalResult> {
  if (items.length === 0) {
    throw new PricingEvalError('invalid_request', 'items must not be empty');
  }

  const now = ctx.now ?? new Date();

  const subtotalCents = items.reduce(
    (sum, item) => sum + Math.round(item.unitPriceCents * item.quantity),
    0,
  );

  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);

  const candidates = await loadCandidateRules(db, ctx.eventId);

  // Fetch event date only when at least one pre_event rule is present.
  let eventDate: Date | null = null;
  const hasPreEvent = candidates.some((r) => r.kind === 'pre_event');
  if (hasPreEvent && ctx.eventId) {
    eventDate = await loadEventDate(db, ctx.eventId);
  }

  const applicable = candidates.filter((rule) =>
    isRuleApplicable(rule, now, totalQuantity, eventDate),
  );

  // Sort by precedence: priority desc, scope specificity desc, createdAt asc.
  const sorted = [...applicable].sort((a, b) => {
    const byPriority = b.priority - a.priority;
    if (byPriority !== 0) return byPriority;
    const byScope = scopeWeight(b.scope) - scopeWeight(a.scope);
    if (byScope !== 0) return byScope;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const discounts = buildDiscounts(sorted, subtotalCents, totalQuantity);

  // Clamp so sum(discounts) never exceeds subtotal.
  const rawSum = discounts.reduce((s, d) => s + d.amountCents, 0);
  const clampedSum = Math.min(rawSum, subtotalCents);
  const finalDiscounts = clampDiscounts(discounts, clampedSum);

  const totalCents = Math.max(0, subtotalCents - clampedSum);

  return { subtotalCents, discounts: finalDiscounts, totalCents, currency };
}

// ---------- Private helpers ----------

async function loadCandidateRules(
  db: DbClient,
  eventId: string | undefined,
): Promise<CandidateRule[]> {
  const DISCOUNT_KINDS = ['qty_discount', 'time_window', 'pre_event'] as const;

  const globalRows = await db
    .select({
      id: pricingRules.id,
      scope: pricingRules.scope,
      kind: pricingRules.kind,
      params: pricingRules.params,
      priority: pricingRules.priority,
      startsAt: pricingRules.startsAt,
      endsAt: pricingRules.endsAt,
      createdAt: pricingRules.createdAt,
    })
    .from(pricingRules)
    .where(
      and(
        eq(pricingRules.active, true),
        eq(pricingRules.scope, 'global'),
        inArray(pricingRules.kind, [...DISCOUNT_KINDS]),
      ),
    )
    .orderBy(desc(pricingRules.priority), asc(pricingRules.createdAt));

  const candidates: CandidateRule[] = globalRows.map(rowToCandidate);

  if (eventId) {
    const eventRows = await db
      .select({
        id: pricingRules.id,
        scope: pricingRules.scope,
        kind: pricingRules.kind,
        params: pricingRules.params,
        priority: pricingRules.priority,
        startsAt: pricingRules.startsAt,
        endsAt: pricingRules.endsAt,
        createdAt: pricingRules.createdAt,
      })
      .from(pricingRules)
      .innerJoin(pricingRuleTargets, eq(pricingRuleTargets.ruleId, pricingRules.id))
      .where(
        and(
          eq(pricingRules.active, true),
          inArray(pricingRules.kind, [...DISCOUNT_KINDS]),
          eq(pricingRuleTargets.targetType, 'event'),
          eq(pricingRuleTargets.targetId, eventId),
        ),
      )
      .orderBy(desc(pricingRules.priority), asc(pricingRules.createdAt));

    candidates.push(...eventRows.map(rowToCandidate));
  }

  // Deduplicate by id (safety guard; duplicates should not occur in practice).
  const seen = new Set<string>();
  return candidates.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function rowToCandidate(row: {
  id: string;
  scope: string;
  kind: string;
  params: unknown;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
}): CandidateRule {
  return { ...row };
}

async function loadEventDate(db: DbClient, eventId: string): Promise<Date | null> {
  const rows = await db
    .select({ eventDate: events.eventDate })
    .from(events)
    .where(eq(events.id, eventId));
  const [first] = rows;
  if (!first) return null;
  // events.eventDate is typed as Date (mode: 'date'); cast for safety when
  // running against the in-memory test shim that may return a plain string.
  return first.eventDate instanceof Date ? first.eventDate : new Date(first.eventDate as string);
}

function isRuleApplicable(
  rule: CandidateRule,
  now: Date,
  totalQuantity: number,
  eventDate: Date | null,
): boolean {
  if (rule.kind === 'qty_discount') {
    const parsed = qtyDiscountParamsSchema.safeParse(rule.params);
    if (!parsed.success) return false;
    return selectQtyDiscountPct(parsed.data, totalQuantity) !== null;
  }

  if (rule.kind === 'time_window') {
    const parsed = timeWindowParamsSchema.safeParse(rule.params);
    if (!parsed.success) return false;
    // Bounds come from the rule's own startsAt/endsAt columns.
    return isTimeWindowActive(now, rule.startsAt, rule.endsAt);
  }

  if (rule.kind === 'pre_event') {
    if (!eventDate) return false;
    const parsed = preEventParamsSchema.safeParse(rule.params);
    if (!parsed.success) return false;
    return isPreEventActive(now, eventDate, parsed.data.days_before);
  }

  return false;
}

/** Returns integer cents discount amount from a pct (0..100) and a base. */
function centsFromPct(pct: number, baseCents: number): number {
  return Math.round(baseCents * (pct / 100));
}

/** Human label: discount_qty_20pct, discount_time_window_10pct, discount_pre_event_15pct */
function makeLabel(kind: string, pct: number): string {
  const kindSlug =
    kind === 'qty_discount'
      ? 'qty'
      : kind === 'time_window'
        ? 'time_window'
        : kind === 'pre_event'
          ? 'pre_event'
          : kind;
  return `discount_${kindSlug}_${Math.round(pct)}pct`;
}

function isStackable(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  return (params as Record<string, unknown>).stackable === true;
}

function getPct(rule: CandidateRule, totalQuantity: number): number | null {
  if (rule.kind === 'qty_discount') {
    const parsed = qtyDiscountParamsSchema.safeParse(rule.params);
    if (!parsed.success) return null;
    return selectQtyDiscountPct(parsed.data, totalQuantity);
  }
  if (rule.kind === 'time_window') {
    const parsed = timeWindowParamsSchema.safeParse(rule.params);
    if (!parsed.success) return null;
    return parsed.data.pct;
  }
  if (rule.kind === 'pre_event') {
    const parsed = preEventParamsSchema.safeParse(rule.params);
    if (!parsed.success) return null;
    return parsed.data.pct;
  }
  return null;
}

/**
 * Build the discount list from sorted applicable rules applying the
 * stackability algorithm documented in the file header.
 */
function buildDiscounts(
  sorted: CandidateRule[],
  subtotalCents: number,
  totalQuantity: number,
): EvalDiscount[] {
  if (sorted.length === 0) return [];

  const [topRule] = sorted;
  if (!topRule) return [];

  const topPct = getPct(topRule, totalQuantity);
  if (topPct === null) return [];

  if (!isStackable(topRule.params)) {
    // Non-stackable: apply top rule only.
    return [
      {
        ruleId: topRule.id,
        label: makeLabel(topRule.kind, topPct),
        amountCents: centsFromPct(topPct, subtotalCents),
      },
    ];
  }

  // Stackable: collect all stackable rules, apply sequentially on running subtotal.
  const stackable = sorted.filter((r) => isStackable(r.params));
  const discounts: EvalDiscount[] = [];
  let running = subtotalCents;

  for (const rule of stackable) {
    if (running <= 0) break;
    const pct = getPct(rule, totalQuantity);
    if (pct === null) continue;
    const amount = centsFromPct(pct, running);
    discounts.push({
      ruleId: rule.id,
      label: makeLabel(rule.kind, pct),
      amountCents: amount,
    });
    running = Math.max(0, running - amount);
  }

  return discounts;
}

/**
 * If the raw sum of discounts exceeds the clamped cap, reduce the last
 * discount's amount to absorb the excess. Returns a new array.
 */
function clampDiscounts(discounts: EvalDiscount[], clampedSum: number): EvalDiscount[] {
  const rawSum = discounts.reduce((s, d) => s + d.amountCents, 0);
  if (rawSum <= clampedSum || discounts.length === 0) return discounts;

  let excess = rawSum - clampedSum;
  const result = discounts.map((d) => ({ ...d }));

  // Walk from the last discount backwards, trimming excess.
  for (let i = result.length - 1; i >= 0 && excess > 0; i--) {
    const entry = result[i];
    if (!entry) continue;
    const trim = Math.min(entry.amountCents, excess);
    result[i] = { ...entry, amountCents: entry.amountCents - trim };
    excess -= trim;
  }

  return result.filter((d) => d.amountCents > 0);
}

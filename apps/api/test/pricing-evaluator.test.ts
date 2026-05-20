// Unit tests for apps/api/src/services/pricing-evaluator.ts.
// All DB calls are mocked via a minimal in-memory store; no real Postgres.
// Mirrors the shim pattern from pricing-tiers.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Types ----------

type Row = Record<string, unknown>;

interface Store {
  licenseTiers: Row[];
  pricingRules: Row[];
  pricingRuleTargets: Row[];
  events: Row[];
}

const newStore = (): Store => ({
  licenseTiers: [],
  pricingRules: [],
  pricingRuleTargets: [],
  events: [],
});

const TABLE_KEY = Symbol('table-key');

const tableMarker = (key: keyof Store): Row => {
  const obj: Record<string | symbol, unknown> = {};
  obj[TABLE_KEY] = key;
  return obj as Row;
};

let uuidCounter = 0;
const fakeUuid = (): string => {
  uuidCounter += 1;
  const n = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};

// ---------- Mocks ----------

vi.mock('@pkg/db', () => {
  const catalogTables = {
    licenseTiers: tableMarker('licenseTiers'),
    pricingRules: tableMarker('pricingRules'),
    pricingRuleTargets: tableMarker('pricingRuleTargets'),
    products: tableMarker('licenseTiers'),
    bundles: tableMarker('licenseTiers'),
    bundleItems: tableMarker('licenseTiers'),
  };
  const eventsTables = {
    events: tableMarker('events'),
    eventMembers: tableMarker('events'),
    eventSettings: tableMarker('events'),
    eventFtpCredentials: tableMarker('events'),
    eventRosterEntries: tableMarker('events'),
  };
  return {
    createDbClient: () => ({}),
    schema: {
      catalog: { tables: catalogTables },
      commerce: { tables: {} },
      photos: { tables: {} },
      events: { tables: eventsTables },
      compliance: { tables: {} },
    },
  };
});

vi.mock('@pkg/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://stub' }),
  z: {
    object: () => ({
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    }),
    string: () => ({ min: () => ({}) }),
  },
}));

// ---------- Mock drizzle-orm ----------

vi.mock('drizzle-orm', () => {
  type Field = { column: string };
  const isField = (v: unknown): v is Field =>
    typeof v === 'object' && v !== null && 'column' in (v as Field);
  const valueOf = (v: unknown, row: Row): unknown => (isField(v) ? row[(v as Field).column] : v);

  const eq = (a: unknown, b: unknown) => (row: Row) => valueOf(a, row) === valueOf(b, row);
  const and =
    (...preds: Array<(r: Row) => boolean>) =>
    (row: Row) =>
      preds.every((p) => p(row));
  const inArray = (field: unknown, values: unknown[]) => (row: Row) =>
    values.includes(valueOf(field, row));
  const desc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    if (av instanceof Date && bv instanceof Date) return bv.getTime() - av.getTime();
    return (av as number) > (bv as number) ? -1 : (av as number) < (bv as number) ? 1 : 0;
  };
  const asc = (field: Field) => (a: Row, b: Row) => {
    const av = a[field.column];
    const bv = b[field.column];
    if (av instanceof Date && bv instanceof Date) return av.getTime() - bv.getTime();
    return (av as number) < (bv as number) ? -1 : (av as number) > (bv as number) ? 1 : 0;
  };
  const sqlTag = ((_strings: TemplateStringsArray) => ({ __sql: '' })) as unknown as Record<
    string,
    unknown
  >;
  return { eq, and, inArray, desc, asc, sql: sqlTag };
});

// ---------- Fake DB builder ----------

let store: Store = newStore();

const makeFakeDb = (): unknown => {
  const runSelect = (
    bucket: keyof Store,
    filterFn: (r: Row) => boolean,
    sortFn?: (a: Row, b: Row) => number,
    limit?: number,
  ): Row[] => {
    let rows = store[bucket].filter(filterFn);
    if (sortFn) rows = [...rows].sort(sortFn);
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map((r) => ({ ...r }));
  };

  const selectBuilder = (_selection?: Record<string, unknown>) => {
    let bucket: keyof Store | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    let sortFn: ((a: Row, b: Row) => number) | undefined;
    let limitN: number | undefined;
    let joinBucket: keyof Store | null = null;
    let joinOnFn: ((mergedRow: Row) => boolean) | null = null;

    const api = {
      from(table: Row) {
        bucket = table[TABLE_KEY] as keyof Store;
        return api;
      },
      innerJoin(table: Row, on: (mergedRow: Row) => boolean) {
        joinBucket = table[TABLE_KEY] as keyof Store;
        joinOnFn = on;
        return api;
      },
      where(predicate: (r: Row) => boolean) {
        filters.push(predicate);
        return api;
      },
      // drizzle .orderBy accepts comparator functions (e.g. desc(col)) or a
      // raw column Field for ascending order (e.g. orderBy(table.col)).
      orderBy(...args: Array<((a: Row, b: Row) => number) | { column: string }>) {
        const comparators = args.map((arg) => {
          if (typeof arg === 'function') return arg;
          const col = arg.column;
          return (a: Row, b: Row) => {
            const av = a[col] as number | string;
            const bv = b[col] as number | string;
            return av > bv ? 1 : av < bv ? -1 : 0;
          };
        });
        sortFn = (a, b) => {
          for (const c of comparators) {
            const v = c(a, b);
            if (v !== 0) return v;
          }
          return 0;
        };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      then(resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) {
        try {
          if (!bucket) return resolve([]);
          const filterFn = (r: Row) => filters.every((f) => f(r));
          let rows: Row[];
          if (joinBucket && joinOnFn) {
            const primary = store[bucket];
            const secondary = store[joinBucket];
            rows = primary
              .flatMap((p) =>
                secondary.map((s) => ({ ...s, ...p })).filter((merged) => joinOnFn!(merged)),
              )
              .filter(filterFn);
          } else {
            rows = runSelect(bucket, filterFn, sortFn, limitN);
          }
          if (sortFn) rows = [...rows].sort(sortFn);
          if (limitN !== undefined) rows = rows.slice(0, limitN);
          return resolve(rows.map((r) => ({ ...r })));
        } catch (e) {
          return reject(e);
        }
      },
    };
    return api;
  };

  return {
    select: (selection?: Record<string, unknown>) => selectBuilder(selection),
  };
};

// ---------- Field shims ----------

const installFieldShims = async (): Promise<void> => {
  const { schema } = await import('@pkg/db');
  const ruleTbl = schema.catalog.tables.pricingRules as Record<string, unknown>;
  const targetTbl = schema.catalog.tables.pricingRuleTargets as Record<string, unknown>;
  const eventTbl = schema.events.tables.events as Record<string, unknown>;

  for (const col of [
    'id',
    'scope',
    'kind',
    'params',
    'priority',
    'startsAt',
    'endsAt',
    'active',
    'createdAt',
  ]) {
    ruleTbl[col] = { column: col };
  }
  for (const col of ['ruleId', 'targetType', 'targetId']) {
    targetTbl[col] = { column: col };
  }
  for (const col of ['id', 'eventDate', 'orgId', 'name', 'slug', 'status', 'currency']) {
    eventTbl[col] = { column: col };
  }
};

// ---------- Lifecycle ----------

let db: ReturnType<typeof makeFakeDb>;

const EVENT_ID = '00000000-0000-4000-8000-0000000000aa';
const RULE_A = '00000000-0000-4000-8000-000000000010';
const RULE_B = '00000000-0000-4000-8000-000000000011';
const RULE_C = '00000000-0000-4000-8000-000000000012';

const BASE_ITEM = { unitPriceCents: 1000, quantity: 1 };

beforeEach(async () => {
  store = newStore();
  uuidCounter = 0;
  await installFieldShims();
  db = makeFakeDb();
});

// ---------- Pure helper: selectQtyDiscountPct ----------

describe('selectQtyDiscountPct', () => {
  it('returns null when no tier threshold is met', async () => {
    const { selectQtyDiscountPct } = await import('../src/services/pricing-evaluator.js');
    const params = { tiers: [{ min: 5, pct: 10 }] };
    expect(selectQtyDiscountPct(params, 4)).toBeNull();
  });

  it('returns pct when exactly at the min threshold (N=5)', async () => {
    const { selectQtyDiscountPct } = await import('../src/services/pricing-evaluator.js');
    const params = { tiers: [{ min: 5, pct: 10 }] };
    expect(selectQtyDiscountPct(params, 5)).toBe(10);
  });

  it('returns the highest matching tier at N=12 (tiers at min=5 and min=10)', async () => {
    const { selectQtyDiscountPct } = await import('../src/services/pricing-evaluator.js');
    const params = {
      tiers: [
        { min: 5, pct: 10 },
        { min: 10, pct: 20 },
      ],
    };
    expect(selectQtyDiscountPct(params, 12)).toBe(20);
  });

  it('returns the lower tier pct when quantity falls between tiers (N=7 with min=5,10)', async () => {
    const { selectQtyDiscountPct } = await import('../src/services/pricing-evaluator.js');
    const params = {
      tiers: [
        { min: 5, pct: 10 },
        { min: 10, pct: 20 },
      ],
    };
    expect(selectQtyDiscountPct(params, 7)).toBe(10);
  });

  it('returns null at N=4 when single tier min=5', async () => {
    const { selectQtyDiscountPct } = await import('../src/services/pricing-evaluator.js');
    const params = { tiers: [{ min: 5, pct: 10 }] };
    expect(selectQtyDiscountPct(params, 4)).toBeNull();
  });
});

// ---------- Pure helper: isTimeWindowActive ----------

describe('isTimeWindowActive', () => {
  const now = new Date('2024-06-15T12:00:00Z');

  it('returns true when now is within window', async () => {
    const { isTimeWindowActive } = await import('../src/services/pricing-evaluator.js');
    expect(
      isTimeWindowActive(now, new Date('2024-06-01T00:00:00Z'), new Date('2024-06-30T00:00:00Z')),
    ).toBe(true);
  });

  it('returns false when now is before window starts', async () => {
    const { isTimeWindowActive } = await import('../src/services/pricing-evaluator.js');
    expect(
      isTimeWindowActive(now, new Date('2024-07-01T00:00:00Z'), new Date('2024-07-31T00:00:00Z')),
    ).toBe(false);
  });

  it('returns false when now is after window ends', async () => {
    const { isTimeWindowActive } = await import('../src/services/pricing-evaluator.js');
    expect(
      isTimeWindowActive(now, new Date('2024-01-01T00:00:00Z'), new Date('2024-05-01T00:00:00Z')),
    ).toBe(false);
  });

  it('returns true when startsAt is null (open start)', async () => {
    const { isTimeWindowActive } = await import('../src/services/pricing-evaluator.js');
    expect(isTimeWindowActive(now, null, new Date('2024-12-31T00:00:00Z'))).toBe(true);
  });

  it('returns true when endsAt is null (open end)', async () => {
    const { isTimeWindowActive } = await import('../src/services/pricing-evaluator.js');
    expect(isTimeWindowActive(now, new Date('2024-01-01T00:00:00Z'), null)).toBe(true);
  });

  it('returns true when both bounds are null', async () => {
    const { isTimeWindowActive } = await import('../src/services/pricing-evaluator.js');
    expect(isTimeWindowActive(now, null, null)).toBe(true);
  });
});

// ---------- Pure helper: isPreEventActive ----------

describe('isPreEventActive', () => {
  const eventDate = new Date('2024-07-01T00:00:00Z');

  it('returns true when 5 days before event (days_before=7)', async () => {
    const { isPreEventActive } = await import('../src/services/pricing-evaluator.js');
    const now = new Date('2024-06-26T00:00:00Z'); // 5 days before
    expect(isPreEventActive(now, eventDate, 7)).toBe(true);
  });

  it('returns false when 8 days before event (days_before=7)', async () => {
    const { isPreEventActive } = await import('../src/services/pricing-evaluator.js');
    const now = new Date('2024-06-23T00:00:00Z'); // 8 days before
    expect(isPreEventActive(now, eventDate, 7)).toBe(false);
  });

  it('returns false on the event day itself', async () => {
    const { isPreEventActive } = await import('../src/services/pricing-evaluator.js');
    expect(isPreEventActive(eventDate, eventDate, 7)).toBe(false);
  });

  it('returns true on the exact boundary (exactly days_before days before)', async () => {
    const { isPreEventActive } = await import('../src/services/pricing-evaluator.js');
    // Exactly 7 days before = windowStart, which is inclusive.
    const now = new Date(eventDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(isPreEventActive(now, eventDate, 7)).toBe(true);
  });
});

// ---------- evaluatePricing: error cases ----------

describe('evaluatePricing: validation', () => {
  it('throws PricingEvalError with code invalid_request for empty items', async () => {
    const { evaluatePricing, PricingEvalError } = await import(
      '../src/services/pricing-evaluator.js'
    );
    await expect(evaluatePricing(db as never, [], {}, 'USD')).rejects.toBeInstanceOf(
      PricingEvalError,
    );
    try {
      await evaluatePricing(db as never, [], {}, 'USD');
    } catch (err) {
      expect((err as { code: string }).code).toBe('invalid_request');
    }
  });
});

// ---------- evaluatePricing: no matching rules ----------

describe('evaluatePricing: no rules', () => {
  it('returns subtotal with no discounts when no rules exist', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    const result = await evaluatePricing(db as never, [BASE_ITEM], {}, 'USD');
    expect(result.subtotalCents).toBe(1000);
    expect(result.discounts).toHaveLength(0);
    expect(result.totalCents).toBe(1000);
    expect(result.currency).toBe('USD');
  });
});

// ---------- evaluatePricing: qty_discount ----------

describe('evaluatePricing: qty_discount', () => {
  const seedQtyRule = (
    id: string,
    tiers: Array<{ min: number; pct: number }>,
    priority = 0,
  ): void => {
    store.pricingRules.push({
      id,
      scope: 'global',
      kind: 'qty_discount',
      params: { tiers },
      priority,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
  };

  it('applies 10% qty discount when quantity >= 5', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedQtyRule(RULE_A, [{ min: 5, pct: 10 }]);
    const items = [{ unitPriceCents: 1000, quantity: 5 }];
    const result = await evaluatePricing(db as never, items, {}, 'USD');
    expect(result.subtotalCents).toBe(5000);
    expect(result.discounts).toHaveLength(1);
    const [d] = result.discounts;
    expect(d?.amountCents).toBe(500);
    expect(d?.label).toBe('discount_qty_10pct');
    expect(result.totalCents).toBe(4500);
  });

  it('does not apply discount when quantity < min (N=4, min=5)', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedQtyRule(RULE_A, [{ min: 5, pct: 10 }]);
    const items = [{ unitPriceCents: 1000, quantity: 4 }];
    const result = await evaluatePricing(db as never, items, {}, 'USD');
    expect(result.discounts).toHaveLength(0);
    expect(result.totalCents).toBe(4000);
  });

  it('selects the higher tier at N=12 (tiers: min=5 pct=10, min=10 pct=20)', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedQtyRule(RULE_A, [
      { min: 5, pct: 10 },
      { min: 10, pct: 20 },
    ]);
    const items = [{ unitPriceCents: 1000, quantity: 12 }];
    const result = await evaluatePricing(db as never, items, {}, 'USD');
    expect(result.subtotalCents).toBe(12000);
    const [d] = result.discounts;
    expect(d?.amountCents).toBe(2400); // 12000 * 0.20
    expect(d?.label).toBe('discount_qty_20pct');
  });
});

// ---------- evaluatePricing: time_window ----------

describe('evaluatePricing: time_window', () => {
  const NOW = new Date('2024-06-15T12:00:00Z');

  const seedTimeRule = (
    id: string,
    pct: number,
    startsAt: Date | null,
    endsAt: Date | null,
  ): void => {
    store.pricingRules.push({
      id,
      scope: 'global',
      kind: 'time_window',
      params: { pct },
      priority: 0,
      startsAt,
      endsAt,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
  };

  it('applies time_window discount when now is inside the window', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedTimeRule(RULE_A, 15, new Date('2024-06-01T00:00:00Z'), new Date('2024-06-30T00:00:00Z'));
    const items = [{ unitPriceCents: 2000, quantity: 1 }];
    const result = await evaluatePricing(db as never, items, { now: NOW }, 'USD');
    expect(result.discounts).toHaveLength(1);
    const [d] = result.discounts;
    expect(d?.amountCents).toBe(300); // 2000 * 0.15
    expect(d?.label).toBe('discount_time_window_15pct');
    expect(result.totalCents).toBe(1700);
  });

  it('does not apply time_window discount when now is outside the window', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedTimeRule(RULE_A, 15, new Date('2024-07-01T00:00:00Z'), new Date('2024-07-31T00:00:00Z'));
    const items = [{ unitPriceCents: 2000, quantity: 1 }];
    const result = await evaluatePricing(db as never, items, { now: NOW }, 'USD');
    expect(result.discounts).toHaveLength(0);
    expect(result.totalCents).toBe(2000);
  });
});

// ---------- evaluatePricing: pre_event ----------

describe('evaluatePricing: pre_event', () => {
  const EVENT_DATE = new Date('2024-07-01T00:00:00Z');

  const seedEvent = (): void => {
    store.events.push({ id: EVENT_ID, eventDate: EVENT_DATE });
  };

  const seedPreEventRule = (id: string, pct: number, daysBefore: number): void => {
    store.pricingRules.push({
      id,
      scope: 'event',
      kind: 'pre_event',
      params: { days_before: daysBefore, pct },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
    store.pricingRuleTargets.push({ ruleId: id, targetType: 'event', targetId: EVENT_ID });
  };

  it('applies pre_event discount at 5 days before event (days_before=7)', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedEvent();
    seedPreEventRule(RULE_A, 15, 7);
    const now = new Date('2024-06-26T00:00:00Z'); // 5 days before
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { eventId: EVENT_ID, now },
      'USD',
    );
    expect(result.discounts).toHaveLength(1);
    const [d] = result.discounts;
    expect(d?.amountCents).toBe(150);
    expect(d?.label).toBe('discount_pre_event_15pct');
    expect(result.totalCents).toBe(850);
  });

  it('does not apply pre_event discount at 8 days before (days_before=7)', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedEvent();
    seedPreEventRule(RULE_A, 15, 7);
    const now = new Date('2024-06-23T00:00:00Z'); // 8 days before
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { eventId: EVENT_ID, now },
      'USD',
    );
    expect(result.discounts).toHaveLength(0);
    expect(result.totalCents).toBe(1000);
  });

  it('does not apply pre_event when no eventId in context', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    seedEvent();
    seedPreEventRule(RULE_A, 15, 7);
    const now = new Date('2024-06-26T00:00:00Z');
    // No eventId provided: pre_event rules cannot apply.
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { now }, // no eventId
      'USD',
    );
    expect(result.discounts).toHaveLength(0);
  });
});

// ---------- evaluatePricing: precedence ----------

describe('evaluatePricing: precedence', () => {
  const NOW = new Date('2024-06-15T12:00:00Z');

  it('applies only the highest-priority rule (non-stackable)', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    // Priority 20 should win over priority 10.
    store.pricingRules.push(
      {
        id: RULE_A,
        scope: 'global',
        kind: 'time_window',
        params: { pct: 10 },
        priority: 10,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-01'),
      },
      {
        id: RULE_B,
        scope: 'global',
        kind: 'time_window',
        params: { pct: 20 },
        priority: 20,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-02'),
      },
    );
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { now: NOW },
      'USD',
    );
    expect(result.discounts).toHaveLength(1);
    const [d] = result.discounts;
    // Only RULE_B (priority 20, pct 20%) applies.
    expect(d?.ruleId).toBe(RULE_B);
    expect(d?.amountCents).toBe(200);
    expect(result.totalCents).toBe(800);
  });

  it('applies both rules when both are stackable', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push(
      {
        id: RULE_A,
        scope: 'global',
        kind: 'time_window',
        params: { pct: 10, stackable: true },
        priority: 10,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-01'),
      },
      {
        id: RULE_B,
        scope: 'global',
        kind: 'time_window',
        params: { pct: 10, stackable: true },
        priority: 20,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-02'),
      },
    );
    // subtotal = 1000
    // RULE_B (priority 20): 10% of 1000 = 100 -> running = 900
    // RULE_A (priority 10): 10% of 900 = 90  -> running = 810
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { now: NOW },
      'USD',
    );
    expect(result.discounts).toHaveLength(2);
    const totalDiscount = result.discounts.reduce((s, d) => s + d.amountCents, 0);
    expect(totalDiscount).toBe(190);
    expect(result.totalCents).toBe(810);
  });

  it('non-stackable top rule suppresses a lower stackable rule', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push(
      {
        id: RULE_A,
        scope: 'global',
        kind: 'time_window',
        // stackable: true but lower priority — suppressed by non-stackable RULE_B
        params: { pct: 5, stackable: true },
        priority: 5,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-01'),
      },
      {
        id: RULE_B,
        scope: 'global',
        kind: 'time_window',
        // non-stackable top rule
        params: { pct: 15 },
        priority: 20,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-02'),
      },
    );
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { now: NOW },
      'USD',
    );
    expect(result.discounts).toHaveLength(1);
    const [d] = result.discounts;
    expect(d?.ruleId).toBe(RULE_B);
    expect(result.totalCents).toBe(850);
  });
});

// ---------- Property-style checks ----------

describe('evaluatePricing: invariants', () => {
  const NOW = new Date('2024-06-15T12:00:00Z');

  it('totalCents is never negative (100% discount rule)', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push({
      id: RULE_A,
      scope: 'global',
      kind: 'time_window',
      params: { pct: 100 },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 500, quantity: 3 }],
      { now: NOW },
      'USD',
    );
    expect(result.totalCents).toBeGreaterThanOrEqual(0);
  });

  it('sum(discounts) never exceeds subtotalCents', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    // Two stackable rules each at 80% — combined would exceed 100%.
    store.pricingRules.push(
      {
        id: RULE_A,
        scope: 'global',
        kind: 'time_window',
        params: { pct: 80, stackable: true },
        priority: 20,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-01'),
      },
      {
        id: RULE_B,
        scope: 'global',
        kind: 'time_window',
        params: { pct: 80, stackable: true },
        priority: 10,
        startsAt: null,
        endsAt: null,
        active: true,
        createdAt: new Date('2024-01-02'),
      },
    );
    const items = [{ unitPriceCents: 1000, quantity: 1 }];
    const result = await evaluatePricing(db as never, items, { now: NOW }, 'USD');
    const discountSum = result.discounts.reduce((s, d) => s + d.amountCents, 0);
    expect(discountSum).toBeLessThanOrEqual(result.subtotalCents);
    expect(result.totalCents).toBeGreaterThanOrEqual(0);
  });

  it('multiple items: subtotal is sum of all line totals', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    const items = [
      { unitPriceCents: 500, quantity: 2 },
      { unitPriceCents: 750, quantity: 3 },
    ];
    const result = await evaluatePricing(db as never, items, {}, 'USD');
    // 500*2 + 750*3 = 1000 + 2250 = 3250
    expect(result.subtotalCents).toBe(3250);
  });

  it('all amountCents in discounts are non-negative integers', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push({
      id: RULE_A,
      scope: 'global',
      kind: 'time_window',
      params: { pct: 33, stackable: true },
      priority: 10,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { now: NOW },
      'USD',
    );
    for (const d of result.discounts) {
      expect(d.amountCents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d.amountCents)).toBe(true);
    }
  });

  it('inactive rules are not applied', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push({
      id: RULE_A,
      scope: 'global',
      kind: 'time_window',
      params: { pct: 50 },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: false, // inactive
      createdAt: new Date('2024-01-01'),
    });
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 1000, quantity: 1 }],
      { now: NOW },
      'USD',
    );
    expect(result.discounts).toHaveLength(0);
    expect(result.totalCents).toBe(1000);
  });

  it('returns correct currency in result', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    const result = await evaluatePricing(db as never, [BASE_ITEM], {}, 'EUR');
    expect(result.currency).toBe('EUR');
  });
});

// ---------- evaluatePricing: multi-tier qty boundary ----------

describe('evaluatePricing: qty boundary edge cases', () => {
  it('N=5 qualifies for min=5 tier', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push({
      id: fakeUuid(),
      scope: 'global',
      kind: 'qty_discount',
      params: { tiers: [{ min: 5, pct: 10 }] },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 100, quantity: 5 }],
      {},
      'USD',
    );
    expect(result.discounts).toHaveLength(1);
  });

  it('N=4 does not qualify for min=5 tier', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push({
      id: fakeUuid(),
      scope: 'global',
      kind: 'qty_discount',
      params: { tiers: [{ min: 5, pct: 10 }] },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 100, quantity: 4 }],
      {},
      'USD',
    );
    expect(result.discounts).toHaveLength(0);
  });

  it('N=12 selects min=10 tier over min=5 tier', async () => {
    const { evaluatePricing } = await import('../src/services/pricing-evaluator.js');
    store.pricingRules.push({
      id: fakeUuid(),
      scope: 'global',
      kind: 'qty_discount',
      params: {
        tiers: [
          { min: 5, pct: 10 },
          { min: 10, pct: 20 },
        ],
      },
      priority: 0,
      startsAt: null,
      endsAt: null,
      active: true,
      createdAt: new Date('2024-01-01'),
    });
    const result = await evaluatePricing(
      db as never,
      [{ unitPriceCents: 100, quantity: 12 }],
      {},
      'USD',
    );
    const [d] = result.discounts;
    expect(d?.label).toBe('discount_qty_20pct');
  });
});

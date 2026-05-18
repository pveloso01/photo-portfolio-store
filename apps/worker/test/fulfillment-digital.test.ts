// F1.31 — fulfillment-digital worker tests.
//
// The worker is exercised against in-memory fakes for DB, S3, archiver, and
// the email sender. We never touch the network or Redis. The shared db fake
// is a small dispatcher that returns canned select results in order and
// records inserts/updates.

import { Buffer } from 'node:buffer';
import { PassThrough, Readable } from 'node:stream';
import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mock @pkg/db so the worker module loads without postgres ----------

vi.mock('@pkg/db', () => {
  const t = (name: string) => ({ __table: name });
  return {
    createDbClient: () => ({}),
    schema: {
      commerce: {
        orders: t('orders'),
        orderItems: t('order_items'),
        fulfillments: t('fulfillments'),
      },
      photos: {
        photos: t('photos'),
        photoDerivatives: t('photo_derivatives'),
      },
      events: {
        events: t('events'),
        eventSettings: t('event_settings'),
      },
      compliance: {
        auditLog: t('audit_log'),
      },
    },
  };
});

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (a: unknown, b: unknown) => ({ __op: 'eq', a, b }),
    and: (...parts: unknown[]) => ({ __op: 'and', parts }),
    sql: actual.sql,
  };
});

// Avoid pulling in real archiver (its native deps differ across platforms) —
// stub it to a Readable that ends quickly and exposes the expected surface.
vi.mock('archiver', () => {
  const factory = () => {
    const stream = new PassThrough();
    const appendCalls: { name: string }[] = [];
    const endListeners: Array<() => void> = [];
    const api: Record<string, unknown> = {
      pipe: (dst: NodeJS.WritableStream) => stream.pipe(dst),
      append: (_src: unknown, opts: { name: string }) => {
        appendCalls.push({ name: opts.name });
        return api;
      },
      finalize: async () => {
        stream.end(Buffer.from('zip-bytes'));
        // Fire 'end' listeners on the next tick so the awaiting promise resolves.
        await new Promise((resolve) => setImmediate(resolve));
        for (const cb of endListeners) cb();
      },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'end') {
          endListeners.push(cb as () => void);
        } else if (event === 'error') {
          stream.on('error', cb);
        }
        return api;
      },
      __appendCalls: appendCalls,
    };
    return api;
  };
  return { default: factory };
});

import type { FulfillmentDigitalJobData } from '../src/queues/fulfillment.js';
import { processFulfillmentDigital } from '../src/workers/fulfillment-digital.js';

// ---------- Helpers ----------

const buildJob = (
  orderId: string,
  opts: { attempts?: number; attemptsMade?: number } = {},
): Job<FulfillmentDigitalJobData> =>
  ({
    data: { orderId },
    opts: { attempts: opts.attempts ?? 3 },
    attemptsMade: opts.attemptsMade ?? 0,
  }) as unknown as Job<FulfillmentDigitalJobData>;

const buildS3 = () => {
  const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetObjectCommand') {
      return { Body: Readable.from([Buffer.from('photo-bytes')]) };
    }
    return {};
  });
  return { send } as const;
};

beforeEach(() => {
  process.env.APP_BASE_URL = 'http://test.local';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- A simpler DB fake that matches what processFulfillmentDigital actually does ----------

// The real query shapes are:
//   1. select({id,...status:fulfillments.status}).from(fulfillments).where(...).limit(1)   -> existing check
//   2. select({...}).from(orders).where(...).limit(1)
//   3. select({name,timezone}).from(events).where(...).limit(1)
//   4. select({downloadExpiryHours}).from(eventSettings).where(...).limit(1)
//   5. select({photoId,derivativeKey}).from(orderItems).innerJoin(...).innerJoin(...).where(...) <- no limit
//
// We dispatch using the FROM table identity captured by .from() argument.

const makeDispatchDb = (
  responses: {
    existingFulfillment?: Array<{ id: string; downloadToken: string | null; status: string }>;
    order?: Array<{ id: string; eventId: string; buyerEmail: string }>;
    event?: Array<{ name: string; timezone: string }>;
    settings?: Array<{ downloadExpiryHours: number }>;
    items?: Array<{ photoId: string; derivativeKey: string }>;
  },
  side?: { insertReturnId?: string; insertThrows?: boolean },
) => {
  const inserts: Array<{ tableName: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ set: Record<string, unknown> }> = [];

  const buildSelect = () =>
    vi.fn((_cols: unknown) => {
      let table = '';
      const from = vi.fn((tbl: { __table?: string }) => {
        table = tbl.__table ?? '';
        const where = vi.fn();
        const innerJoin = vi.fn().mockReturnValue({ where, innerJoin: vi.fn() });
        const limit = vi.fn(async () => {
          switch (table) {
            case 'fulfillments':
              return responses.existingFulfillment ?? [];
            case 'orders':
              return responses.order ?? [];
            case 'events':
              return responses.event ?? [];
            case 'event_settings':
              return responses.settings ?? [];
            default:
              return [];
          }
        });
        // .where() may return { limit } OR be awaitable (items query).
        where.mockImplementation(() => {
          if (table === 'order_items') {
            return Promise.resolve(responses.items ?? []);
          }
          return { limit };
        });
        // For the items query, the chain is: from(orderItems).innerJoin(...).innerJoin(...).where(...)
        // Make innerJoin re-return the same chain that exposes where.
        const joinChain: Record<string, unknown> = {};
        joinChain.innerJoin = vi.fn().mockReturnValue(joinChain);
        joinChain.where = vi.fn().mockImplementation(() => {
          if (table === 'order_items') {
            return Promise.resolve(responses.items ?? []);
          }
          return { limit };
        });
        innerJoin.mockReturnValue(joinChain);
        return { where, innerJoin };
      });
      return { from };
    });

  const select = buildSelect();

  const returning = vi.fn().mockResolvedValue([{ id: side?.insertReturnId ?? 'ful-1' }]);
  const insertValues = vi.fn((values: Record<string, unknown>) => {
    inserts.push({ tableName: 'fulfillments', values });
    if (side?.insertThrows) {
      const err = new Error('insert failed');
      return Promise.reject(err);
    }
    const obj = {
      returning,
      then: (resolve: (v: unknown) => void) => resolve(undefined),
    };
    return obj;
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn((set: Record<string, unknown>) => {
    updates.push({ set });
    return { where: updateWhere };
  });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  return { select, insert, update, inserts, updates };
};

describe('processFulfillmentDigital', () => {
  it('builds a zip, inserts fulfillment, emails buyer, audits', async () => {
    const db = makeDispatchDb({
      existingFulfillment: [],
      order: [{ id: 'order-1', eventId: 'event-1', buyerEmail: 'buyer@example.com' }],
      event: [{ name: 'Summer 5K', timezone: 'America/New_York' }],
      settings: [{ downloadExpiryHours: 48 }],
      items: [
        { photoId: 'p1', derivativeKey: 'derivatives/event-1/p1/full.jpg' },
        { photoId: 'p2', derivativeKey: 'derivatives/event-1/p2/full.jpg' },
      ],
    });
    const s3 = buildS3();
    const uploadZip = vi.fn(async (params: { body: NodeJS.ReadableStream }) => {
      // Consume the stream so archiver finalizes.
      for await (const _ of params.body as AsyncIterable<Buffer>) {
        // discard
      }
    });
    const sendEmail = vi.fn(async () => ({ sent: true }));

    const result = await processFulfillmentDigital(buildJob('order-1'), {
      db: db as never,
      s3: s3 as never,
      buckets: { originals: 'orig', derivatives: 'deriv' },
      uploadZip,
      sendEmail,
      now: () => new Date('2025-01-01T00:00:00Z'),
      appBaseUrl: 'http://test.local',
    });

    expect(result.status).toBe('completed');
    expect(result.downloadToken).toBeTruthy();
    expect(result.downloadToken?.length).toBeGreaterThan(20);

    // Two photos -> two GETs from S3.
    const getCalls = s3.send.mock.calls.filter(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'GetObjectCommand',
    );
    expect(getCalls.length).toBe(2);

    // One zip upload.
    expect(uploadZip).toHaveBeenCalledTimes(1);
    expect(uploadZip.mock.calls[0]?.[0].key).toMatch(/^bundles\/order-1\/.+\.zip$/);

    // Email sent with the signed-style URL.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const emailArg = sendEmail.mock.calls[0]?.[0];
    expect(emailArg?.to).toBe('buyer@example.com');
    expect(emailArg?.eventName).toBe('Summer 5K');
    expect(emailArg?.itemCount).toBe(2);
    expect(emailArg?.downloadUrl).toMatch(
      /^http:\/\/test\.local\/v1\/orders\/order-1\/downloads\/.+$/,
    );

    // Fulfillment inserted in 'in_progress', then updated to 'completed'.
    const fulfillmentInsert = db.inserts.find(
      (i) => i.values && (i.values as Record<string, unknown>).status === 'in_progress',
    );
    expect(fulfillmentInsert).toBeTruthy();
    expect(db.updates.some((u) => (u.set as Record<string, unknown>).status === 'completed')).toBe(
      true,
    );
  });

  it('order with 0 items -> marks failed and does not upload', async () => {
    const db = makeDispatchDb({
      existingFulfillment: [],
      order: [{ id: 'order-2', eventId: 'event-1', buyerEmail: 'buyer@example.com' }],
      event: [{ name: 'Empty Event', timezone: 'UTC' }],
      settings: [{ downloadExpiryHours: 72 }],
      items: [],
    });
    const s3 = buildS3();
    const uploadZip = vi.fn(async () => undefined);
    const sendEmail = vi.fn(async () => ({ sent: true }));

    const result = await processFulfillmentDigital(buildJob('order-2'), {
      db: db as never,
      s3: s3 as never,
      buckets: { originals: 'orig', derivatives: 'deriv' },
      uploadZip,
      sendEmail,
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_items');
    expect(uploadZip).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    // A failed fulfillment row was written.
    expect(db.inserts.some((i) => (i.values as Record<string, unknown>).status === 'failed')).toBe(
      true,
    );
  });

  it('stream error on an item -> entire job fails (no completed update)', async () => {
    const db = makeDispatchDb({
      existingFulfillment: [],
      order: [{ id: 'order-3', eventId: 'event-1', buyerEmail: 'buyer@example.com' }],
      event: [{ name: 'Race Day', timezone: 'UTC' }],
      settings: [{ downloadExpiryHours: 72 }],
      items: [{ photoId: 'p1', derivativeKey: 'derivatives/event-1/p1/full.jpg' }],
    });
    const s3 = {
      send: vi.fn(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          throw new Error('s3 fetch failed');
        }
        return {};
      }),
    };
    const uploadZip = vi.fn(async () => undefined);
    const sendEmail = vi.fn(async () => ({ sent: true }));

    await expect(
      processFulfillmentDigital(buildJob('order-3', { attempts: 1 }), {
        db: db as never,
        s3: s3 as never,
        buckets: { originals: 'orig', derivatives: 'deriv' },
        uploadZip,
        sendEmail,
      }),
    ).rejects.toThrow(/s3 fetch failed/);

    // No 'completed' update should have been written.
    expect(db.updates.every((u) => (u.set as Record<string, unknown>).status !== 'completed')).toBe(
      true,
    );
    // Final attempt -> a 'failed' update should have been issued.
    expect(db.updates.some((u) => (u.set as Record<string, unknown>).status === 'failed')).toBe(
      true,
    );
  });

  it('is idempotent: existing completed fulfillment short-circuits', async () => {
    const db = makeDispatchDb({
      existingFulfillment: [
        { id: 'ful-existing', downloadToken: 'existing-token', status: 'completed' },
      ],
      order: [{ id: 'order-4', eventId: 'event-1', buyerEmail: 'buyer@example.com' }],
      event: [{ name: 'Whatever', timezone: 'UTC' }],
      settings: [{ downloadExpiryHours: 72 }],
      items: [],
    });
    const s3 = buildS3();
    const uploadZip = vi.fn(async () => undefined);
    const sendEmail = vi.fn(async () => ({ sent: true }));

    const result = await processFulfillmentDigital(buildJob('order-4'), {
      db: db as never,
      s3: s3 as never,
      buckets: { originals: 'orig', derivatives: 'deriv' },
      uploadZip,
      sendEmail,
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('already_completed');
    expect(result.fulfillmentId).toBe('ful-existing');
    expect(uploadZip).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('email send failure does not flip fulfillment to failed', async () => {
    const db = makeDispatchDb({
      existingFulfillment: [],
      order: [{ id: 'order-5', eventId: 'event-1', buyerEmail: 'buyer@example.com' }],
      event: [{ name: 'Marathon', timezone: 'UTC' }],
      settings: [{ downloadExpiryHours: 72 }],
      items: [{ photoId: 'p1', derivativeKey: 'derivatives/event-1/p1/full.jpg' }],
    });
    const s3 = buildS3();
    const uploadZip = vi.fn(async (params: { body: NodeJS.ReadableStream }) => {
      for await (const _ of params.body as AsyncIterable<Buffer>) {
        // discard
      }
    });
    const sendEmail = vi.fn(async () => {
      throw new Error('smtp down');
    });

    const result = await processFulfillmentDigital(buildJob('order-5'), {
      db: db as never,
      s3: s3 as never,
      buckets: { originals: 'orig', derivatives: 'deriv' },
      uploadZip,
      sendEmail,
    });

    expect(result.status).toBe('completed');
    // The fulfillment was still marked completed.
    expect(db.updates.some((u) => (u.set as Record<string, unknown>).status === 'completed')).toBe(
      true,
    );
  });
});

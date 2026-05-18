// F1.31 — fulfillment:digital queue.
//
// The Stripe webhook handler (F1.30) enqueues `{ orderId }` here on
// charge.succeeded. The fulfillment-digital worker consumes the job, builds
// a zip bundle of the order's `full` derivatives, and emails the buyer a
// signed download link.
//
// Lazy-constructed for the same reasons as other queues: tests import this
// module without a live Redis.

import { Queue } from 'bullmq';

import { getRedis } from '../lib/redis.js';
import { DEFAULT_JOB_OPTIONS } from './index.js';

export const FULFILLMENT_QUEUE_NAME = 'fulfillment:digital' as const;

export interface FulfillmentDigitalJobData {
  orderId: string;
}

let cached: Queue<FulfillmentDigitalJobData> | undefined;

export const getFulfillmentQueue = (): Queue<FulfillmentDigitalJobData> => {
  if (!cached) {
    cached = new Queue<FulfillmentDigitalJobData>(FULFILLMENT_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return cached;
};

// Proxy convenience: lets callers `import { fulfillmentQueue }` without
// triggering queue construction at import time.
export const fulfillmentQueue: Queue<FulfillmentDigitalJobData> = new Proxy(
  {} as Queue<FulfillmentDigitalJobData>,
  {
    get(_target, prop) {
      const real = getFulfillmentQueue() as unknown as Record<PropertyKey, unknown>;
      const value = real[prop];
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(real)
        : value;
    },
  },
) as Queue<FulfillmentDigitalJobData>;

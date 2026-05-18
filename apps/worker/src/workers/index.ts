// Worker registry. Exposes a single `startWorkers` so the top-level
// `src/index.ts` can opt into running the BullMQ consumers. Each worker
// installs its own error listener that funnels into Sentry; pino logs the
// structured failure.

import * as Sentry from '@sentry/node';
import { type Worker as BullWorker, Worker } from 'bullmq';

import { logger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';
import { FACE_QUEUE_NAME } from '../queues/face.js';
import { FULFILLMENT_QUEUE_NAME } from '../queues/fulfillment.js';
import { QUEUE_NAMES } from '../queues/index.js';
import { derivativesProcessor } from './derivatives.js';
import { faceProcessor } from './face.js';
import { fulfillmentDigitalProcessor } from './fulfillment-digital.js';
import { ingestProcessor } from './ingest.js';
import { watermarkProcessor } from './watermark.js';

export interface WorkerSet {
  ingest: BullWorker;
  derivatives: BullWorker;
  watermark: BullWorker;
  face: BullWorker;
  fulfillmentDigital: BullWorker;
}

const attachLifecycle = (worker: BullWorker, name: string): void => {
  worker.on('failed', (job, err) => {
    Sentry.captureException(err, { tags: { worker: name, jobId: job?.id ?? 'unknown' } });
    logger.error(
      { worker: name, jobId: job?.id, err: err.message, attempts: job?.attemptsMade },
      'job failed',
    );
  });
  worker.on('error', (err) => {
    Sentry.captureException(err, { tags: { worker: name } });
    logger.error({ worker: name, err: err.message }, 'worker error');
  });
};

export const startWorkers = (): WorkerSet => {
  const connection = getRedis();
  const ingest = new Worker(QUEUE_NAMES.ingestFanOut, ingestProcessor, {
    connection,
    concurrency: 5,
  });
  const derivatives = new Worker(QUEUE_NAMES.derivatives, derivativesProcessor, {
    connection,
    concurrency: 3,
  });
  const watermark = new Worker(QUEUE_NAMES.watermark, watermarkProcessor, {
    connection,
    concurrency: 5,
  });
  // F1.22 — face detect + embed. Concurrency 2 to bound concurrent inference
  // load on the Python service; bump per its capacity.
  const face = new Worker(FACE_QUEUE_NAME, faceProcessor, {
    connection,
    concurrency: 2,
  });
  // F1.31 — digital fulfillment. Concurrency 3 keeps zip generation bounded.
  const fulfillmentDigital = new Worker(FULFILLMENT_QUEUE_NAME, fulfillmentDigitalProcessor, {
    connection,
    concurrency: 3,
  });

  attachLifecycle(ingest, 'ingest');
  attachLifecycle(derivatives, 'derivatives');
  attachLifecycle(watermark, 'watermark');
  attachLifecycle(face, 'face');
  attachLifecycle(fulfillmentDigital, 'fulfillment-digital');

  logger.info('workers started: ingest, derivatives, watermark, face, fulfillment-digital');
  return { ingest, derivatives, watermark, face, fulfillmentDigital };
};

export const stopWorkers = async (set: WorkerSet): Promise<void> => {
  await Promise.allSettled([
    set.ingest.close(),
    set.derivatives.close(),
    set.watermark.close(),
    set.face.close(),
    set.fulfillmentDigital.close(),
  ]);
};

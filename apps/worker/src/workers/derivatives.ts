// F1.13 — derivatives worker.
//
// Pulls the original from R2, generates thumb/preview/web/full via sharp,
// uploads each to the derivatives bucket, and upserts photo_derivatives rows.
// Updates the parent photo to status='ready' once all four are persisted.

import { Buffer } from 'node:buffer';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type DbClient, schema } from '@pkg/db';
import * as Sentry from '@sentry/node';
import type { Job, Processor, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';

import { writeWorkerAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { buckets as defaultBuckets, getS3 } from '../lib/storage.js';
import { DEFAULT_JOB_OPTIONS, type DerivativesJobData } from '../queues/index.js';
import { type QualityJobData, getQualityQueue } from '../queues/quality.js';

const { photos, photoDerivatives } = schema.photos;
const { eventSettings } = schema.events;

export type DerivativeKind = 'thumb' | 'preview' | 'web' | 'full';

interface DerivativeSpec {
  kind: DerivativeKind;
  maxDimension: number | null; // null = keep original dimensions
  quality: number;
}

const THUMB_MAX = 200;
const WEB_MAX = 2400;
const DEFAULT_PREVIEW_MAX = 1600;

export interface DerivativesDeps {
  db?: DbClient;
  s3?: S3Client;
  buckets?: { originals: string; derivatives: string };
  // Allow tests to inject a sharp constructor; defaults to the real one.
  sharpFactory?: typeof sharp;
  // F3.12 — quality scoring queue; enqueued once derivatives are ready.
  qualityQueue?: Queue<QualityJobData>;
}

export interface DerivativesResult {
  status: 'ready' | 'skipped';
  reason?: string;
  derivatives?: DerivativeKind[];
}

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    body &&
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray ===
      'function'
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }
  // Node Readable stream fallback.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const derivativeKey = (eventId: string, photoId: string, kind: DerivativeKind): string =>
  `derivatives/${eventId}/${photoId}/${kind}.jpg`;

export const processDerivatives = async (
  job: Job<DerivativesJobData>,
  deps: DerivativesDeps = {},
): Promise<DerivativesResult> => {
  const dbClient = deps.db ?? defaultDb;
  const s3 = deps.s3 ?? getS3();
  const bucketCfg = deps.buckets ?? {
    originals: defaultBuckets.originals,
    derivatives: defaultBuckets.derivatives,
  };
  const sharpFn = deps.sharpFactory ?? sharp;
  const { photoId } = job.data;

  try {
    const rows = await dbClient
      .select({
        id: photos.id,
        eventId: photos.eventId,
        originalObjectKey: photos.originalObjectKey,
        status: photos.status,
      })
      .from(photos)
      .where(sql`${photos.id} = ${photoId}`)
      .limit(1);

    const row = rows[0];
    if (!row) {
      logger.warn({ photoId }, 'derivatives: photo not found');
      return { status: 'skipped', reason: 'not_found' };
    }

    const settingsRows = await dbClient
      .select({ previewMaxPixels: eventSettings.previewMaxPixels })
      .from(eventSettings)
      .where(sql`${eventSettings.eventId} = ${row.eventId}`)
      .limit(1);
    const previewMax = settingsRows[0]?.previewMaxPixels ?? DEFAULT_PREVIEW_MAX;

    // Download original.
    const getRes = await s3.send(
      new GetObjectCommand({ Bucket: bucketCfg.originals, Key: row.originalObjectKey }),
    );
    const originalBuffer = await streamToBuffer(getRes.Body);

    // Capture true dimensions from the source.
    const meta = await sharpFn(originalBuffer).metadata();
    const originalWidth = meta.width ?? 0;
    const originalHeight = meta.height ?? 0;

    const specs: DerivativeSpec[] = [
      { kind: 'thumb', maxDimension: THUMB_MAX, quality: 80 },
      { kind: 'preview', maxDimension: previewMax, quality: 82 },
      { kind: 'web', maxDimension: WEB_MAX, quality: 85 },
      // 'full' re-encodes the original to JPEG quality 90 with EXIF stripped.
      // Original EXIF lives in photos.exif_jsonb and is not surfaced here.
      { kind: 'full', maxDimension: null, quality: 90 },
    ];

    const produced: DerivativeKind[] = [];

    for (const spec of specs) {
      let pipeline = sharpFn(originalBuffer).rotate(); // auto-orient via EXIF
      if (spec.maxDimension) {
        pipeline = pipeline.resize({
          width: spec.maxDimension,
          height: spec.maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
      const { data, info } = await pipeline
        .jpeg({ quality: spec.quality, mozjpeg: true })
        .withMetadata({ exif: {}, icc: undefined })
        .toBuffer({ resolveWithObject: true });

      const key = derivativeKey(row.eventId, photoId, spec.kind);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketCfg.derivatives,
          Key: key,
          Body: data,
          ContentType: 'image/jpeg',
        }),
      );

      // Upsert via ON CONFLICT on the unique (photo_id, kind) index.
      await dbClient
        .insert(photoDerivatives)
        .values({
          photoId,
          kind: spec.kind,
          objectKey: key,
          bytes: info.size,
          width: info.width,
          height: info.height,
          watermarked: false,
        })
        .onConflictDoUpdate({
          target: [photoDerivatives.photoId, photoDerivatives.kind],
          set: {
            objectKey: key,
            bytes: info.size,
            width: info.width,
            height: info.height,
            watermarked: false,
          },
        });
      produced.push(spec.kind);
    }

    await dbClient
      .update(photos)
      .set({
        status: 'ready',
        width: originalWidth || undefined,
        height: originalHeight || undefined,
        updatedAt: new Date(),
      })
      .where(sql`${photos.id} = ${photoId}`);

    await writeWorkerAudit(dbClient, {
      action: 'media.derivatives.complete',
      targetKind: 'photo',
      targetId: photoId,
      eventId: row.eventId,
      payload: { kinds: produced, width: originalWidth, height: originalHeight },
    });

    // F3.12 — enqueue quality scoring now that derivatives exist. Stable job id
    // keeps it idempotent across derivative retries. Best-effort: a queue
    // failure must not fail the (already-complete) derivative job.
    try {
      const qualityQueue = deps.qualityQueue ?? getQualityQueue();
      await qualityQueue.add(
        'quality',
        { photoId },
        { ...DEFAULT_JOB_OPTIONS, jobId: `quality:${photoId}` },
      );
    } catch (err) {
      logger.warn(
        { photoId, err: err instanceof Error ? err.message : String(err) },
        'derivatives: failed to enqueue quality job (continuing)',
      );
    }

    logger.info({ photoId, kinds: produced }, 'derivatives: complete');
    return { status: 'ready', derivatives: produced };
  } catch (error) {
    Sentry.captureException(error, { tags: { worker: 'derivatives', photoId } });
    logger.error(
      { photoId, err: error instanceof Error ? error.message : String(error) },
      'derivatives: failed',
    );
    // Mark photo failed on final attempt so retries can flip it back.
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      try {
        await dbClient
          .update(photos)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(sql`${photos.id} = ${photoId}`);
      } catch {
        // best effort
      }
    }
    throw error;
  }
};

export const derivativesProcessor: Processor<DerivativesJobData, DerivativesResult> = (job) =>
  processDerivatives(job);

// F1.31 — digital fulfillment worker.
//
// Builds a zip of every photo's `full` derivative on a paid order, uploads
// it to R2 as `bundles/{orderId}/{downloadToken}.zip`, persists a
// fulfillments row, and emails the buyer a signed link to the API download
// endpoint.
//
// Idempotency: if a 'completed' digital fulfillment already exists for the
// order, this job is a no-op and returns the existing token.
//
// Streaming: photo bytes flow R2 -> archiver -> in-memory PassThrough -> R2.
// We hand the PassThrough to PutObjectCommand which buffers as needed, but
// per-photo bytes are never fully materialized into a Node Buffer.
//
// Email is best-effort: send failures DO NOT mark the fulfillment failed.
// The fulfillment row stays 'completed' and the download endpoint still
// works; a separate M2 cron can re-send.

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type DbClient, schema } from '@pkg/db';
import * as Sentry from '@sentry/node';
import archiver from 'archiver';
import type { Job, Processor } from 'bullmq';
import { and, eq } from 'drizzle-orm';

import { LICENSE_PDF_TEMPLATE_VERSION, generateLicensePdf } from '../lib/license-pdf.js';

import { writeWorkerAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { buckets as defaultBuckets, getS3 } from '../lib/storage.js';
import type { FulfillmentDigitalJobData } from '../queues/fulfillment.js';
import {
  type FulfillmentEmailInput,
  sendFulfillmentEmail as defaultSendEmail,
} from '../services/fulfillment-emailer.js';

const { orders, orderItems, fulfillments } = schema.commerce;
const { photoDerivatives } = schema.photos;
const { events, eventSettings } = schema.events;
const { licenseTiers } = schema.catalog;

const DEFAULT_EXPIRY_HOURS = 72;
const ZLIB_LEVEL = 6;

export interface FulfillmentDigitalDeps {
  db?: DbClient;
  s3?: S3Client;
  buckets?: { originals: string; derivatives: string };
  // Allow tests to inject a uploader (Upload from @aws-sdk/lib-storage is hard
  // to mock; tests instead supply a plain function).
  uploadZip?: (params: {
    s3: S3Client;
    bucket: string;
    key: string;
    body: NodeJS.ReadableStream;
  }) => Promise<void>;
  // Test seam for the email step.
  sendEmail?: (input: FulfillmentEmailInput) => Promise<{ sent: boolean }>;
  // Test seam for app base URL resolution.
  appBaseUrl?: string;
  // Test seam for clock.
  now?: () => Date;
}

export interface FulfillmentDigitalResult {
  status: 'completed' | 'skipped';
  reason?: 'already_completed' | 'no_items';
  fulfillmentId?: string;
  downloadToken?: string;
}

interface OrderLoadResult {
  orderId: string;
  eventId: string;
  buyerEmail: string;
  eventName: string;
  eventTimezone: string;
  downloadExpiryHours: number;
  items: { photoId: string; objectKey: string; filename: string }[];
  // License tier data for PDF generation (from first item; all items share the tier on a cart).
  tierCode: string;
  tierName: string;
  tierScope: string;
}

const generateToken = (): string => randomBytes(32).toString('base64url');

const streamFromS3 = async (
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<NodeJS.ReadableStream> => {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`empty body for s3://${bucket}/${key}`);
  if (typeof (body as { pipe?: unknown }).pipe === 'function') {
    return body as unknown as NodeJS.ReadableStream;
  }
  // AWS sdk v3 sometimes returns a web ReadableStream; coerce via byte array.
  if (
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray ===
    'function'
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    const pass = new PassThrough();
    pass.end(Buffer.from(bytes));
    return pass;
  }
  throw new Error(`unsupported S3 body type for s3://${bucket}/${key}`);
};

const defaultUploadZip = async (params: {
  s3: S3Client;
  bucket: string;
  key: string;
  body: NodeJS.ReadableStream;
}): Promise<void> => {
  // Prefer @aws-sdk/lib-storage Upload for stream-friendly multipart when it
  // is available; otherwise buffer the stream and use PutObjectCommand. Tests
  // inject their own uploader and never trigger this path.
  try {
    const mod = (await import('@aws-sdk/lib-storage')) as {
      Upload: new (args: unknown) => { done: () => Promise<unknown> };
    };
    const upload = new mod.Upload({
      client: params.s3,
      params: {
        Bucket: params.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: 'application/zip',
      },
    });
    await upload.done();
    return;
  } catch (err) {
    if (!(err instanceof Error) || !/Cannot find (module|package)/.test(err.message)) {
      throw err;
    }
    // Fall through to PutObject fallback.
  }
  const chunks: Buffer[] = [];
  for await (const chunk of params.body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: Buffer.concat(chunks),
      ContentType: 'application/zip',
    }),
  );
};

/** Resolve `full` derivative for a single photoId. Returns null when not found. */
const resolveDerivative = async (
  db: DbClient,
  photoId: string,
): Promise<{ photoId: string; objectKey: string; filename: string } | null> => {
  const rows = await db
    .select({ objectKey: photoDerivatives.objectKey })
    .from(photoDerivatives)
    .where(and(eq(photoDerivatives.photoId, photoId), eq(photoDerivatives.kind, 'full')))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const last = row.objectKey.split('/').pop() ?? `${photoId}.jpg`;
  return { photoId, objectKey: row.objectKey, filename: `${photoId}-${last}` };
};

const loadOrder = async (db: DbClient, orderId: string): Promise<OrderLoadResult | null> => {
  const orderRows = await db
    .select({
      id: orders.id,
      eventId: orders.eventId,
      buyerEmail: orders.buyerEmail,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const order = orderRows[0];
  if (!order) return null;

  const eventRows = await db
    .select({ name: events.name, timezone: events.timezone })
    .from(events)
    .where(eq(events.id, order.eventId))
    .limit(1);
  const event = eventRows[0];
  if (!event) return null;

  const settingsRows = await db
    .select({ downloadExpiryHours: eventSettings.downloadExpiryHours })
    .from(eventSettings)
    .where(eq(eventSettings.eventId, order.eventId))
    .limit(1);
  const downloadExpiryHours = settingsRows[0]?.downloadExpiryHours ?? DEFAULT_EXPIRY_HOURS;

  // Load all order_items for this order including their metadata snapshot.
  const rawItemRows = await db
    .select({
      photoId: orderItems.photoId,
      licenseTierId: orderItems.licenseTierId,
      metadataJsonb: orderItems.metadataJsonb,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  // Collect all (photoId, licenseTierId) pairs to resolve.
  // For bundle items, expand from metadataJsonb.bundleSnapshot.
  // For single-photo items, use the direct photoId.
  interface DeliveryCandidate {
    photoId: string;
    licenseTierId: string;
  }

  const candidates: DeliveryCandidate[] = [];

  for (const rawItem of rawItemRows) {
    const meta = (rawItem.metadataJsonb ?? {}) as Record<string, unknown>;
    const bundleSnapshot = meta.bundleSnapshot;

    if (Array.isArray(bundleSnapshot) && bundleSnapshot.length > 0 && rawItem.photoId === null) {
      // Bundle item: expand each snapshot photoId.
      for (const pid of bundleSnapshot) {
        if (typeof pid === 'string') {
          candidates.push({ photoId: pid, licenseTierId: rawItem.licenseTierId });
        }
      }
    } else if (rawItem.photoId !== null) {
      // Single-photo item.
      candidates.push({ photoId: rawItem.photoId, licenseTierId: rawItem.licenseTierId });
    }
  }

  // Resolve derivatives for all candidates.
  const deliveryItems: OrderLoadResult['items'] = [];
  for (const candidate of candidates) {
    const resolved = await resolveDerivative(db, candidate.photoId);
    if (resolved) {
      deliveryItems.push(resolved);
    } else {
      logger.warn(
        { orderId, photoId: candidate.photoId },
        'fulfillment: no full derivative for photo, skipping',
      );
    }
  }

  // Resolve license tier for PDF generation. Use the first item's tier.
  const firstTierId = rawItemRows[0]?.licenseTierId ?? null;
  let tierCode = 'personal';
  let tierName = 'Personal use';
  let tierScope = '';
  if (firstTierId) {
    const tierRows = await db
      .select({
        code: licenseTiers.code,
        name: licenseTiers.name,
        description: licenseTiers.description,
      })
      .from(licenseTiers)
      .where(eq(licenseTiers.id, firstTierId))
      .limit(1);
    const tier = tierRows[0];
    if (tier) {
      tierCode = tier.code;
      tierName = tier.name;
      tierScope = tier.description;
    }
  }

  return {
    orderId: order.id,
    eventId: order.eventId,
    buyerEmail: order.buyerEmail,
    eventName: event.name,
    eventTimezone: event.timezone,
    downloadExpiryHours,
    items: deliveryItems,
    tierCode,
    tierName,
    tierScope,
  };
};

const findExistingCompleted = async (
  db: DbClient,
  orderId: string,
): Promise<{ id: string; downloadToken: string | null } | null> => {
  const rows = await db
    .select({
      id: fulfillments.id,
      downloadToken: fulfillments.downloadToken,
      status: fulfillments.status,
    })
    .from(fulfillments)
    .where(and(eq(fulfillments.orderId, orderId), eq(fulfillments.kind, 'digital_download')))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== 'completed') return null;
  return { id: row.id, downloadToken: row.downloadToken };
};

const buildAndUploadBundle = async (params: {
  s3: S3Client;
  derivativesBucket: string;
  bundleKey: string;
  items: { objectKey: string; filename: string }[];
  uploadZip: NonNullable<FulfillmentDigitalDeps['uploadZip']>;
  licensePdf?: { filename: string; bytes: Buffer };
}): Promise<void> => {
  const archive = archiver('zip', { zlib: { level: ZLIB_LEVEL } });
  const pass = new PassThrough();
  archive.pipe(pass);

  const archiveDone = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    archive.on('end', () => resolve());
  });

  // Kick off the upload first so it consumes the PassThrough as archiver
  // pushes bytes — keeps memory bounded.
  const uploadDone = params.uploadZip({
    s3: params.s3,
    bucket: params.derivativesBucket,
    key: params.bundleKey,
    body: pass,
  });

  for (const item of params.items) {
    const stream = await streamFromS3(params.s3, params.derivativesBucket, item.objectKey);
    // Archiver expects Node `Readable`; S3 SDK returns Web ReadableStream in some setups.
    // biome-ignore lint/suspicious/noExplicitAny: archiver types narrow but accept both at runtime
    archive.append(stream as any, { name: item.filename });
  }

  // Staple the license PDF into the zip if provided.
  if (params.licensePdf) {
    const pdfPass = new PassThrough();
    pdfPass.end(params.licensePdf.bytes);
    // biome-ignore lint/suspicious/noExplicitAny: archiver types narrow but accept both at runtime
    archive.append(pdfPass as any, { name: params.licensePdf.filename });
  }

  await archive.finalize();
  await archiveDone;
  await uploadDone;
};

export const processFulfillmentDigital = async (
  job: Job<FulfillmentDigitalJobData>,
  deps: FulfillmentDigitalDeps = {},
): Promise<FulfillmentDigitalResult> => {
  const db = deps.db ?? defaultDb;
  const s3 = deps.s3 ?? getS3();
  const bucketCfg = deps.buckets ?? {
    originals: defaultBuckets.originals,
    derivatives: defaultBuckets.derivatives,
  };
  const uploadZip = deps.uploadZip ?? defaultUploadZip;
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const now = deps.now ?? (() => new Date());
  const appBaseUrl = deps.appBaseUrl ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';

  const { orderId } = job.data;

  try {
    // Idempotency: short-circuit if already completed.
    const existing = await findExistingCompleted(db, orderId);
    if (existing) {
      logger.info({ orderId, fulfillmentId: existing.id }, 'fulfillment: already completed');
      return {
        status: 'skipped',
        reason: 'already_completed',
        fulfillmentId: existing.id,
        downloadToken: existing.downloadToken ?? undefined,
      };
    }

    const order = await loadOrder(db, orderId);
    if (!order) {
      throw new Error(`order ${orderId} not found`);
    }
    if (order.items.length === 0) {
      logger.error({ orderId }, 'fulfillment: order has no items');
      await db.insert(fulfillments).values({
        orderId,
        kind: 'digital_download',
        status: 'failed',
        payloadJsonb: { reason: 'no_items' },
      });
      await writeWorkerAudit(db, {
        action: 'fulfillment.digital.failed',
        targetKind: 'order',
        targetId: orderId,
        eventId: order.eventId,
        payload: { reason: 'no_items' },
      });
      return { status: 'skipped', reason: 'no_items' };
    }

    const downloadToken = generateToken();
    const downloadExpiresAt = new Date(
      now().getTime() + order.downloadExpiryHours * 60 * 60 * 1000,
    );
    const bundleKey = `bundles/${orderId}/${downloadToken}.zip`;

    // Generate the license PDF before building the archive.
    const licensePdfBytes = await generateLicensePdf({
      buyerName: order.buyerEmail, // name not captured yet; email used as fallback
      buyerEmail: order.buyerEmail,
      photoIds: order.items.map((i) => i.photoId),
      tierCode: order.tierCode,
      tierName: order.tierName,
      tierScope: order.tierScope,
      orderId,
      issuedAt: now(),
      templateVersion: LICENSE_PDF_TEMPLATE_VERSION,
    });

    // Insert in_progress fulfillment row first so failures leave a trail.
    // templateVersion is persisted in payloadJsonb for license audit.
    const inserted = await db
      .insert(fulfillments)
      .values({
        orderId,
        kind: 'digital_download',
        status: 'in_progress',
        downloadToken,
        downloadExpiresAt,
        payloadJsonb: {
          bundleKey,
          itemCount: order.items.length,
          licensePdfTemplateVersion: LICENSE_PDF_TEMPLATE_VERSION,
          tierCode: order.tierCode,
        },
      })
      .returning({ id: fulfillments.id });
    const fulfillmentId = inserted[0]?.id;
    if (!fulfillmentId) throw new Error('failed to insert fulfillment row');

    await buildAndUploadBundle({
      s3,
      derivativesBucket: bucketCfg.derivatives,
      bundleKey,
      items: order.items,
      uploadZip,
      licensePdf: { filename: `license-${order.tierCode}.pdf`, bytes: licensePdfBytes },
    });

    await db
      .update(fulfillments)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(fulfillments.id, fulfillmentId));

    // Email is best-effort.
    const downloadUrl = `${appBaseUrl.replace(/\/$/, '')}/v1/orders/${orderId}/downloads/${downloadToken}`;
    try {
      await sendEmail({
        to: order.buyerEmail,
        eventName: order.eventName,
        eventTimezone: order.eventTimezone,
        downloadUrl,
        expiresAt: downloadExpiresAt,
        itemCount: order.items.length,
      });
    } catch (mailErr) {
      logger.error(
        { orderId, err: mailErr instanceof Error ? mailErr.message : String(mailErr) },
        'fulfillment: email send threw (swallowed)',
      );
    }

    await writeWorkerAudit(db, {
      action: 'fulfillment.digital.completed',
      targetKind: 'order',
      targetId: orderId,
      eventId: order.eventId,
      payload: {
        fulfillmentId,
        bundleKey,
        itemCount: order.items.length,
        expiresAt: downloadExpiresAt.toISOString(),
      },
    });

    logger.info(
      { orderId, fulfillmentId, items: order.items.length },
      'fulfillment: digital download ready',
    );
    return { status: 'completed', fulfillmentId, downloadToken };
  } catch (error) {
    Sentry.captureException(error, { tags: { worker: 'fulfillment-digital', orderId } });
    logger.error(
      { orderId, err: error instanceof Error ? error.message : String(error) },
      'fulfillment: failed',
    );
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      try {
        await db
          .update(fulfillments)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(and(eq(fulfillments.orderId, orderId), eq(fulfillments.kind, 'digital_download')));
        await writeWorkerAudit(db, {
          action: 'fulfillment.digital.failed',
          targetKind: 'order',
          targetId: orderId,
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      } catch {
        // best effort
      }
    }
    throw error;
  }
};

export const fulfillmentDigitalProcessor: Processor<
  FulfillmentDigitalJobData,
  FulfillmentDigitalResult
> = (job) => processFulfillmentDigital(job);

// Spec-named export alias for downstream wiring code that prefers a verb name.
export const processor = fulfillmentDigitalProcessor;

// F3.12 — quality scoring worker.
//
// Runs after derivative generation. Pulls the original from R2, computes the
// blur score (Laplacian variance on luma) and a perceptual hash, then flags:
//   - blur: blur_score below the configured threshold.
//   - near_duplicate: another photo in the SAME event whose phash is within the
//     configured Hamming distance; both photos get near_duplicate_of + a shared
//     duplicate_group_id.
//   - eyes_closed: delegated to the Python inference /quality endpoint (EAR on
//     facial landmarks). Best-effort — an inference outage never blocks the
//     blur + near-duplicate signals.
//
// Flags are advisory only — nothing is hidden. The job is idempotent: re-running
// on the same photo overwrites the flags deterministically (phash + blur_score
// are pure functions of the pixels).

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type DbClient, schema } from '@pkg/db';
import * as Sentry from '@sentry/node';
import type { Job, Processor } from 'bullmq';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import sharp from 'sharp';

import { writeWorkerAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { workerEnv } from '../lib/env.js';
import { type QualityResponse, scoreQuality } from '../lib/inference-client.js';
import { logger } from '../lib/logger.js';
import { analyzeImage, hammingDistance } from '../lib/quality.js';
import { buckets as defaultBuckets, getS3 } from '../lib/storage.js';
import type { QualityJobData } from '../queues/quality.js';

const { photos } = schema.photos;

export interface EyesClosedFlag {
  faces: number;
}

export interface QualityFlags {
  blur: boolean;
  near_duplicate_of?: string;
  duplicate_group_id?: string;
  eyes_closed?: EyesClosedFlag;
}

export interface QualityThresholds {
  blurThreshold: number;
  hammingMax: number;
}

// Injectable so tests don't hit the network; defaults to the inference client.
export type EyesClosedScorer = (
  imageBytes: Buffer,
  options?: { filename?: string; contentType?: string },
) => Promise<QualityResponse>;

export interface QualityDeps {
  db?: DbClient;
  s3?: S3Client;
  buckets?: { originals: string };
  sharpFactory?: typeof sharp;
  thresholds?: QualityThresholds;
  // Eyes-closed scorer (Python inference /quality). Best-effort: a failure or
  // omission leaves quality_flags.eyes_closed unset; blur + near-dup still run.
  eyesClosedScorer?: EyesClosedScorer;
}

export interface QualityResult {
  status: 'scored' | 'skipped';
  reason?: string;
  blurScore?: number;
  phash?: string;
  flags?: QualityFlags;
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
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

interface CandidateRow {
  id: string;
  phash: bigint | null;
  qualityFlags: unknown;
}

const resolveThresholds = (deps: QualityDeps): QualityThresholds =>
  deps.thresholds ?? {
    blurThreshold: workerEnv.QUALITY_BLUR_THRESHOLD,
    hammingMax: workerEnv.QUALITY_PHASH_HAMMING_MAX,
  };

export const processQuality = async (
  job: Job<QualityJobData>,
  deps: QualityDeps = {},
): Promise<QualityResult> => {
  const dbClient = deps.db ?? defaultDb;
  const s3 = deps.s3 ?? getS3();
  const originalsBucket = deps.buckets?.originals ?? defaultBuckets.originals;
  const sharpFn = deps.sharpFactory ?? sharp;
  const { blurThreshold, hammingMax } = resolveThresholds(deps);
  const { photoId } = job.data;

  try {
    const rows = await dbClient
      .select({
        id: photos.id,
        eventId: photos.eventId,
        originalObjectKey: photos.originalObjectKey,
      })
      .from(photos)
      .where(sql`${photos.id} = ${photoId}`)
      .limit(1);

    const photo = rows[0];
    if (!photo) {
      logger.warn({ photoId }, 'quality: photo not found');
      return { status: 'skipped', reason: 'not_found' };
    }

    const getRes = await s3.send(
      new GetObjectCommand({ Bucket: originalsBucket, Key: photo.originalObjectKey }),
    );
    const buffer = await streamToBuffer(getRes.Body);

    const { blurScore, phash } = await analyzeImage(buffer, sharpFn);

    // Eyes-closed via the Python inference /quality endpoint. Best-effort: an
    // inference outage must not block the blur + near-duplicate signals.
    let eyesClosed: EyesClosedFlag | undefined;
    const scorer = deps.eyesClosedScorer ?? scoreQuality;
    try {
      const q = await scorer(buffer, { filename: `${photoId}.jpg` });
      if (q.eyes_closed_faces > 0) eyesClosed = { faces: q.eyes_closed_faces };
    } catch (err) {
      logger.warn(
        { photoId, err: err instanceof Error ? err.message : String(err) },
        'quality: eyes-closed scoring failed (continuing)',
      );
    }

    // Near-duplicate scan: other already-scored photos in the same event.
    const candidates = (await dbClient
      .select({
        id: photos.id,
        phash: photos.phash,
        qualityFlags: photos.qualityFlags,
      })
      .from(photos)
      .where(
        and(
          eq(photos.eventId, photo.eventId),
          isNotNull(photos.phash),
          sql`${photos.id} <> ${photoId}`,
        ),
      )) as CandidateRow[];

    let nearest: { id: string; distance: number; flags: QualityFlags | null } | null = null;
    for (const candidate of candidates) {
      if (candidate.phash === null) continue;
      const distance = hammingDistance(phash, candidate.phash);
      if (distance <= hammingMax && (nearest === null || distance < nearest.distance)) {
        nearest = {
          id: candidate.id,
          distance,
          flags: (candidate.qualityFlags as QualityFlags | null) ?? null,
        };
      }
    }

    const flags: QualityFlags = { blur: blurScore < blurThreshold };
    if (eyesClosed) flags.eyes_closed = eyesClosed;
    if (nearest) {
      // Reuse the matched photo's existing group, else mint a new one and stamp
      // it back onto the match so both rows share the duplicate_group_id.
      const groupId = nearest.flags?.duplicate_group_id ?? randomUUID();
      flags.near_duplicate_of = nearest.id;
      flags.duplicate_group_id = groupId;

      const matchFlags: QualityFlags = {
        blur: nearest.flags?.blur ?? false,
        near_duplicate_of: photoId,
        duplicate_group_id: groupId,
        // Preserve the matched photo's own eyes-closed assessment.
        ...(nearest.flags?.eyes_closed ? { eyes_closed: nearest.flags.eyes_closed } : {}),
      };
      await dbClient
        .update(photos)
        .set({ qualityFlags: matchFlags, updatedAt: new Date() })
        .where(sql`${photos.id} = ${nearest.id}`);
    }

    await dbClient
      .update(photos)
      .set({
        blurScore: blurScore.toFixed(2),
        phash,
        qualityFlags: flags,
        updatedAt: new Date(),
      })
      .where(sql`${photos.id} = ${photoId}`);

    await writeWorkerAudit(dbClient, {
      action: 'media.quality.scored',
      targetKind: 'photo',
      targetId: photoId,
      eventId: photo.eventId,
      payload: {
        blurScore: Number(blurScore.toFixed(2)),
        blur: flags.blur,
        nearDuplicateOf: flags.near_duplicate_of ?? null,
        eyesClosedFaces: flags.eyes_closed?.faces ?? 0,
      },
    });

    logger.info({ photoId, blurScore, blur: flags.blur }, 'quality: scored');
    return {
      status: 'scored',
      blurScore,
      phash: phash.toString(),
      flags,
    };
  } catch (error) {
    Sentry.captureException(error, { tags: { worker: 'quality', photoId } });
    logger.error(
      { photoId, err: error instanceof Error ? error.message : String(error) },
      'quality: failed',
    );
    throw error;
  }
};

export const qualityProcessor: Processor<QualityJobData, QualityResult> = (job) =>
  processQuality(job);

// Signed-URL helpers for photo derivatives (preview + thumb).
//
// Used by search results to hand back short-lived (5 min) URLs without
// exposing raw S3 object keys. Both helpers cache the signed URL in a
// per-request memo so repeated lookups for the same photo within one
// request don't hit S3 multiple times.

import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, inArray } from 'drizzle-orm';

import { buckets, s3 } from './storage.js';

const { photoDerivatives } = schema.photos;

const TTL_SECONDS = 5 * 60;

export type DerivativeKind = 'thumb' | 'preview' | 'web' | 'full';

export interface PreviewUrlCache {
  // photoId -> kind -> url
  readonly urls: Map<string, Map<DerivativeKind, string>>;
}

export const createPreviewUrlCache = (): PreviewUrlCache => ({
  urls: new Map(),
});

const readCache = (
  cache: PreviewUrlCache,
  photoId: string,
  kind: DerivativeKind,
): string | undefined => cache.urls.get(photoId)?.get(kind);

const writeCache = (
  cache: PreviewUrlCache,
  photoId: string,
  kind: DerivativeKind,
  url: string,
): void => {
  const inner = cache.urls.get(photoId) ?? new Map<DerivativeKind, string>();
  inner.set(kind, url);
  cache.urls.set(photoId, inner);
};

const signObjectKey = async (objectKey: string, client: S3Client): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: buckets.derivatives,
    Key: objectKey,
  });
  return getSignedUrl(client, command, { expiresIn: TTL_SECONDS });
};

const loadDerivative = async (
  db: DbClient,
  photoId: string,
  kind: DerivativeKind,
): Promise<string | null> => {
  const rows = await db
    .select({ objectKey: photoDerivatives.objectKey })
    .from(photoDerivatives)
    .where(and(eq(photoDerivatives.photoId, photoId), eq(photoDerivatives.kind, kind)))
    .limit(1);
  const row = rows[0];
  return row?.objectKey ?? null;
};

export const getPreviewUrl = async (
  db: DbClient,
  photoId: string,
  cache: PreviewUrlCache,
  client: S3Client = s3,
): Promise<string | null> => {
  const cached = readCache(cache, photoId, 'preview');
  if (cached) return cached;
  const key = await loadDerivative(db, photoId, 'preview');
  if (!key) return null;
  const url = await signObjectKey(key, client);
  writeCache(cache, photoId, 'preview', url);
  return url;
};

export const getThumbUrl = async (
  db: DbClient,
  photoId: string,
  cache: PreviewUrlCache,
  client: S3Client = s3,
): Promise<string | null> => {
  const cached = readCache(cache, photoId, 'thumb');
  if (cached) return cached;
  const key = await loadDerivative(db, photoId, 'thumb');
  if (!key) return null;
  const url = await signObjectKey(key, client);
  writeCache(cache, photoId, 'thumb', url);
  return url;
};

// Batched variant — fetches all derivative keys for a set of photos in one
// query, then signs each. Used by search endpoints to avoid N+1 DB queries.
export interface PhotoUrls {
  thumbUrl: string | null;
  previewUrl: string | null;
}

export const getPhotoUrlsBatch = async (
  db: DbClient,
  photoIds: readonly string[],
  cache: PreviewUrlCache,
  client: S3Client = s3,
): Promise<Map<string, PhotoUrls>> => {
  const result = new Map<string, PhotoUrls>();
  if (photoIds.length === 0) return result;

  // Pull any uncached keys in a single query.
  const uncached = photoIds.filter(
    (id) => !readCache(cache, id, 'thumb') || !readCache(cache, id, 'preview'),
  );

  if (uncached.length > 0) {
    const rows = await db
      .select({
        photoId: photoDerivatives.photoId,
        kind: photoDerivatives.kind,
        objectKey: photoDerivatives.objectKey,
      })
      .from(photoDerivatives)
      .where(
        and(
          inArray(photoDerivatives.photoId, uncached as string[]),
          inArray(photoDerivatives.kind, ['thumb', 'preview']),
        ),
      );

    // Sign each (uncached) derivative once and stash in the cache.
    await Promise.all(
      rows.map(async (row) => {
        const kind = row.kind as DerivativeKind;
        if (kind !== 'thumb' && kind !== 'preview') return;
        if (readCache(cache, row.photoId, kind)) return;
        const url = await signObjectKey(row.objectKey, client);
        writeCache(cache, row.photoId, kind, url);
      }),
    );
  }

  for (const id of photoIds) {
    result.set(id, {
      thumbUrl: readCache(cache, id, 'thumb') ?? null,
      previewUrl: readCache(cache, id, 'preview') ?? null,
    });
  }

  return result;
};

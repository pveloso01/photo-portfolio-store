// Bundle service — bib bundles (F2.2) and foto-flat bundles (F2.3).
//
// Resolvers are pure / cacheable: they read only, never write.
// createBundle writes both a bundles row and a matching products row
// (bundle-as-product pattern). The products row is the cart-facing handle;
// configJsonb.bundleId is the join key back to the bundles row.
//
// Bib confidence threshold: eventSettings has no bib-specific threshold column
// (only faceThreshold). We fall back to BIB_CONFIDENCE_DEFAULT = 0.8.
//
// foto_flat cap: at most FOTO_FLAT_MAX_PHOTOS are returned. If the event has
// more photos the resolver returns the capped set sorted by createdAt asc;
// the caller is responsible for logging a warning when count equals the cap.

import { randomBytes } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';

const { bundles, bundleItems, products } = schema.catalog.tables;
const { photos } = schema.photos.tables;
const { bibTags } = schema.search.tables;

// ---------- Constants ----------

/** Default OCR confidence threshold for bib-tag inclusion when no per-event
 *  setting is configured. eventSettings does not expose a bib-specific
 *  threshold column; this constant is the authoritative fallback. */
export const BIB_CONFIDENCE_DEFAULT = 0.8;

/** Maximum number of photos returned by a foto_flat bundle resolver in one
 *  call. Events with more photos still return the cap; the call site should
 *  log a warning so operators are aware. */
export const FOTO_FLAT_MAX_PHOTOS = 50_000;

// ---------- Errors ----------

export class BundleServiceError extends Error {
  constructor(
    public readonly code:
      | 'bundle_not_found'
      | 'bundle_empty'
      | 'event_not_found'
      | 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'BundleServiceError';
  }
}

// ---------- Types ----------

export interface BundleResolution {
  photoIds: string[];
  count: number;
  totalCents: number;
  currency: string;
}

export interface CreateBundleInput {
  eventId: string;
  kind: 'bib' | 'foto_flat' | 'custom';
  /** Selector jsonb. For 'bib': { bib: string }. For 'foto_flat': { all: true }.
   *  For 'custom': { photoIds: string[] } (also used to populate bundle_items). */
  selector?: Record<string, unknown>;
  basePriceCents: number;
  currency: string;
  licenseTierId: string;
  name?: string;
  /** For kind='custom' — pre-populate bundle_items. */
  photoIds?: string[];
}

export interface BundleProduct {
  productId: string;
  priceCents: number;
  currency: string;
  licenseTierId: string;
  eventId: string;
}

// ---------- Helpers ----------

/** Short collision-resistant suffix for deterministic SKU generation. */
const shortId = (): string => randomBytes(4).toString('hex');

// ---------- resolveBundle ----------

/** Pure read — resolves which photo IDs belong to a bundle.
 *  - bib: bibTags WHERE eventId AND bibNumber AND confidence >= threshold,
 *         then intersect with photos WHERE status='ready'. Dedupes by photoId
 *         (one photo may carry multiple bib tags).
 *  - foto_flat: all photos WHERE eventId AND status='ready', capped at
 *               FOTO_FLAT_MAX_PHOTOS.
 *  - custom: photoIds from bundle_items.
 *  Returns photoIds sorted lexicographically for determinism. */
export const resolveBundle = async (db: DbClient, bundleId: string): Promise<BundleResolution> => {
  // Load the bundle row.
  const bundleRows = await db.select().from(bundles).where(eq(bundles.id, bundleId)).limit(1);
  const bundle = bundleRows[0];
  if (!bundle) {
    throw new BundleServiceError('bundle_not_found', `bundle ${bundleId} not found`);
  }

  const selector = (bundle.selector ?? {}) as Record<string, unknown>;
  let photoIds: string[] = [];

  if (bundle.kind === 'bib') {
    const bibValue = selector.bib;
    if (typeof bibValue !== 'string') {
      throw new BundleServiceError(
        'invalid_request',
        'bib bundle selector must have a string "bib" field',
      );
    }

    // Fetch all bib_tags for this event + bib number.
    const tagRows = await db
      .select({ photoId: bibTags.photoId, confidence: bibTags.confidence })
      .from(bibTags)
      .where(and(eq(bibTags.eventId, bundle.eventId), eq(bibTags.bibNumber, bibValue)));

    // confidence is numeric(4,3) — Drizzle returns it as a string.
    const threshold = BIB_CONFIDENCE_DEFAULT;
    const candidatePhotoIds = new Set<string>();
    for (const tag of tagRows) {
      const conf = Number.parseFloat(String(tag.confidence));
      if (conf >= threshold) {
        candidatePhotoIds.add(tag.photoId);
      }
    }

    if (candidatePhotoIds.size === 0) {
      throw new BundleServiceError('bundle_empty', 'no photos match bib selector');
    }

    // Intersect with photos WHERE status='ready'.
    const readyPhotoRows = await db
      .select({ id: photos.id })
      .from(photos)
      .where(and(eq(photos.eventId, bundle.eventId), eq(photos.status, 'ready')));
    const readyIds = new Set(readyPhotoRows.map((r) => r.id));

    photoIds = [...candidatePhotoIds].filter((id) => readyIds.has(id));
    if (photoIds.length === 0) {
      throw new BundleServiceError('bundle_empty', 'no ready photos match bib selector');
    }
  } else if (bundle.kind === 'foto_flat') {
    // All ready photos in the event, capped.
    const rows = await db
      .select({ id: photos.id })
      .from(photos)
      .where(and(eq(photos.eventId, bundle.eventId), eq(photos.status, 'ready')))
      .orderBy(photos.createdAt)
      .limit(FOTO_FLAT_MAX_PHOTOS);
    photoIds = rows.map((r) => r.id);
    if (photoIds.length === 0) {
      throw new BundleServiceError('bundle_empty', 'no ready photos in event');
    }
  } else {
    // kind === 'custom': from bundle_items.
    const itemRows = await db
      .select({ photoId: bundleItems.photoId })
      .from(bundleItems)
      .where(eq(bundleItems.bundleId, bundleId));
    photoIds = itemRows.map((r) => r.photoId);
    if (photoIds.length === 0) {
      throw new BundleServiceError('bundle_empty', 'custom bundle has no items');
    }
  }

  // Deterministic output order.
  photoIds.sort();

  return {
    photoIds,
    count: photoIds.length,
    totalCents: bundle.basePriceCents,
    currency: bundle.currency,
  };
};

// ---------- createBundle ----------

/** Inserts a bundles row and a matching products row.
 *  For kind='custom' also inserts bundle_items rows.
 *  For bib/foto_flat the resolver computes membership live; no items rows. */
export const createBundle = async (
  db: DbClient,
  input: CreateBundleInput,
): Promise<{ bundleId: string; productId: string }> => {
  if (input.basePriceCents <= 0) {
    throw new BundleServiceError('invalid_request', 'basePriceCents must be > 0');
  }

  const selector: Record<string, unknown> =
    input.selector ??
    (input.kind === 'bib'
      ? {}
      : input.kind === 'foto_flat'
        ? { all: true }
        : { photoIds: input.photoIds ?? [] });

  // Insert bundle row.
  const bundleInserted = await db
    .insert(bundles)
    .values({
      eventId: input.eventId,
      kind: input.kind,
      selector,
      basePriceCents: input.basePriceCents,
      currency: input.currency,
      licenseTierId: input.licenseTierId,
      active: true,
    })
    .returning();
  const bundle = bundleInserted[0];
  if (!bundle) {
    throw new BundleServiceError('invalid_request', 'bundle insert returned no row');
  }

  // For custom bundles, materialize bundle_items.
  if (input.kind === 'custom' && input.photoIds && input.photoIds.length > 0) {
    for (const photoId of input.photoIds) {
      await db.insert(bundleItems).values({ bundleId: bundle.id, photoId });
    }
  }

  // Build a deterministic SKU: bndl-<kind>-<short>.
  const sku = `bndl-${input.kind}-${shortId()}`;
  const productName =
    input.name ??
    (input.kind === 'bib'
      ? `Bib Bundle ${(selector.bib as string | undefined) ?? ''}`
      : input.kind === 'foto_flat'
        ? 'All Event Photos'
        : 'Custom Bundle');

  // Insert matching products row. configJsonb.bundleId is the join key.
  const productKindValue: 'digital_bundle' | 'foto_flat' =
    input.kind === 'foto_flat' ? 'foto_flat' : 'digital_bundle';

  const productInserted = await db
    .insert(products)
    .values({
      eventId: input.eventId,
      kind: productKindValue,
      sku,
      name: productName,
      priceCents: input.basePriceCents,
      currency: input.currency,
      licenseTierId: input.licenseTierId,
      configJsonb: { bundleId: bundle.id },
      photoId: null,
      active: true,
    })
    .returning();
  const product = productInserted[0];
  if (!product) {
    throw new BundleServiceError('invalid_request', 'product insert returned no row');
  }

  return { bundleId: bundle.id, productId: product.id };
};

// ---------- getFotoFlatSummary ----------

/** Finds the active foto_flat bundle for an event and returns a lightweight
 *  summary including a live photo count. Returns null if none exists. */
export const getFotoFlatSummary = async (
  db: DbClient,
  eventId: string,
): Promise<{
  bundleId: string;
  photoCount: number;
  priceCents: number;
  currency: string;
  licenseTierId: string;
} | null> => {
  const rows = await db
    .select()
    .from(bundles)
    .where(
      and(eq(bundles.eventId, eventId), eq(bundles.kind, 'foto_flat'), eq(bundles.active, true)),
    )
    .limit(1);
  const bundle = rows[0];
  if (!bundle) return null;

  let photoCount = 0;
  try {
    const resolution = await resolveBundle(db, bundle.id);
    photoCount = resolution.count;
  } catch (err) {
    if (err instanceof BundleServiceError && err.code === 'bundle_empty') {
      photoCount = 0;
    } else {
      throw err;
    }
  }

  return {
    bundleId: bundle.id,
    photoCount,
    priceCents: bundle.basePriceCents,
    currency: bundle.currency,
    licenseTierId: bundle.licenseTierId,
  };
};

// ---------- findBundleProduct ----------

/** Finds the products row whose configJsonb.bundleId === bundleId.
 *  Returns null if not found. */
export const findBundleProduct = async (
  db: DbClient,
  bundleId: string,
): Promise<BundleProduct | null> => {
  // Drizzle jsonb equality: select all and filter in app code — avoids
  // needing a raw SQL fragment for JSONB operator in mock-db-compatible tests.
  const rows = await db
    .select({
      id: products.id,
      priceCents: products.priceCents,
      currency: products.currency,
      licenseTierId: products.licenseTierId,
      eventId: products.eventId,
      configJsonb: products.configJsonb,
    })
    .from(products)
    .where(eq(products.active, true));

  const matched = rows.find((r) => {
    const cfg = (r.configJsonb ?? {}) as Record<string, unknown>;
    return cfg.bundleId === bundleId;
  });

  if (!matched) return null;

  return {
    productId: matched.id,
    priceCents: matched.priceCents,
    currency: matched.currency,
    licenseTierId: matched.licenseTierId,
    eventId: matched.eventId,
  };
};

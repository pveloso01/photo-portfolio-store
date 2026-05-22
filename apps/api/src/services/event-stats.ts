// F3.9 — organizer event analytics.
//
// Direct aggregation from base tables with a 60s in-memory TTL cache. Response
// shape is matview-ready: when scale demands it, an event_stats_mv can back
// getEventStats without changing the contract. Money is integer cents.
//
// net_revenue formula: sum(paid order totals) - sum(refunded_cents). This is
// buyer-facing net (what stays after refunds), not photographer net.
// conversionRate: paid orders / unique faces detected (falls back to
// photos_with_faces when no faces, then 0).
// sales_by_hour is bucketed in UTC. TODO: bucket in the event timezone — the
// matview will own tz-correct bucketing; documented deviation for now.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';

const { photos } = schema.photos.tables;
const { faceVectors } = schema.search.tables;
const { orders, orderItems } = schema.commerce.tables;

const CACHE_TTL_MS = 60_000;
const PAID_STATUSES = ['paid', 'partially_refunded', 'refunded'] as const;

export interface PhotographerSales {
  photographerUserId: string;
  salesCents: number;
}

export interface SalesBucket {
  hour: string;
  salesCents: number;
  orderCount: number;
}

export interface EventStats {
  totalPhotosUploaded: number;
  photosWithFaces: number;
  uniqueFacesDetected: number;
  totalOrders: number;
  grossRevenueCents: number;
  netRevenueCents: number;
  refundCount: number;
  refundAmountCents: number;
  conversionRate: number;
  topPhotographersBySales: PhotographerSales[];
  salesByHour: SalesBucket[];
  currency: string;
}

interface CacheEntry {
  at: number;
  value: EventStats;
}
const cache = new Map<string, CacheEntry>();

export const clearEventStatsCache = (): void => cache.clear();

const cacheKey = (eventId: string, from?: Date, to?: Date): string =>
  `${eventId}|${from?.toISOString() ?? ''}|${to?.toISOString() ?? ''}`;

export const getEventStats = async (
  db: DbClient,
  eventId: string,
  opts: { from?: Date; to?: Date; now?: Date } = {},
): Promise<EventStats> => {
  const key = cacheKey(eventId, opts.from, opts.to);
  const now = opts.now ?? new Date();
  const cached = cache.get(key);
  if (cached && now.getTime() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  // Photos + face coverage.
  const photoRows = await db
    .select({ id: photos.id, photographerUserId: photos.photographerUserId })
    .from(photos)
    .where(eq(photos.eventId, eventId));
  const totalPhotosUploaded = photoRows.length;
  const photoPhotographer = new Map(photoRows.map((p) => [p.id, p.photographerUserId]));

  const faceRows = await db
    .select({ photoId: faceVectors.photoId })
    .from(faceVectors)
    .where(eq(faceVectors.eventId, eventId));
  const photosWithFaces = new Set(faceRows.map((r) => r.photoId)).size;
  const uniqueFacesDetected = faceRows.length;

  // Orders in the optional time window.
  const orderConds = [eq(orders.eventId, eventId)];
  if (opts.from) orderConds.push(gte(orders.placedAt, opts.from));
  if (opts.to) orderConds.push(lte(orders.placedAt, opts.to));
  const orderRows = await db
    .select({
      id: orders.id,
      totalCents: orders.totalCents,
      refundedCents: orders.refundedCents,
      currency: orders.currency,
      status: orders.status,
      placedAt: orders.placedAt,
    })
    .from(orders)
    .where(and(...orderConds));

  const paidOrders = orderRows.filter((o) =>
    (PAID_STATUSES as readonly string[]).includes(o.status),
  );
  const totalOrders = paidOrders.length;
  const grossRevenueCents = paidOrders.reduce((s, o) => s + o.totalCents, 0);
  const refundAmountCents = paidOrders.reduce((s, o) => s + (o.refundedCents ?? 0), 0);
  const refundCount = paidOrders.filter((o) => (o.refundedCents ?? 0) > 0).length;
  const netRevenueCents = grossRevenueCents - refundAmountCents;
  const currency = paidOrders[0]?.currency ?? orderRows[0]?.currency ?? 'usd';

  // Top photographers by attributed line-item sales (paid orders only).
  const paidOrderIds = paidOrders.map((o) => o.id);
  const salesByPhotographer = new Map<string, number>();
  if (paidOrderIds.length > 0) {
    const items = await db
      .select({
        orderId: orderItems.orderId,
        photoId: orderItems.photoId,
        lineTotalCents: orderItems.lineTotalCents,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, paidOrderIds));
    // photoId -> photographer was loaded above with the photo rows.
    for (const item of items) {
      const uid = item.photoId ? photoPhotographer.get(item.photoId) : undefined;
      if (!uid) continue;
      salesByPhotographer.set(uid, (salesByPhotographer.get(uid) ?? 0) + item.lineTotalCents);
    }
  }
  const topPhotographersBySales: PhotographerSales[] = [...salesByPhotographer.entries()]
    .map(([photographerUserId, salesCents]) => ({ photographerUserId, salesCents }))
    .sort((a, b) => b.salesCents - a.salesCents)
    .slice(0, 5);

  // Sales by hour (UTC buckets).
  const buckets = new Map<string, { salesCents: number; orderCount: number }>();
  for (const o of paidOrders) {
    const hour = `${o.placedAt.toISOString().slice(0, 13)}:00:00Z`;
    const b = buckets.get(hour) ?? { salesCents: 0, orderCount: 0 };
    b.salesCents += o.totalCents;
    b.orderCount += 1;
    buckets.set(hour, b);
  }
  const salesByHour: SalesBucket[] = [...buckets.entries()]
    .map(([hour, v]) => ({ hour, salesCents: v.salesCents, orderCount: v.orderCount }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  const denominator = uniqueFacesDetected > 0 ? uniqueFacesDetected : photosWithFaces;
  const conversionRate = denominator > 0 ? totalOrders / denominator : 0;

  const value: EventStats = {
    totalPhotosUploaded,
    photosWithFaces,
    uniqueFacesDetected,
    totalOrders,
    grossRevenueCents,
    netRevenueCents,
    refundCount,
    refundAmountCents,
    conversionRate,
    topPhotographersBySales,
    salesByHour,
    currency,
  };

  cache.set(key, { at: now.getTime(), value });
  return value;
};

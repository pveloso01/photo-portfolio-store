// F3.10 — photographer dashboard analytics (self-service "me" routes).
//
// GET /v1/me/photographer/stats[.csv] — owner = request.user; NOT
// RBAC-permission-gated (the main thread adds /v1/me/photographer/* to the RBAC
// exempt list). 401 when unauthenticated.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import {
  type PhotographerStats,
  type StatsRange,
  getPhotographerStats,
} from '../services/photographer-stats.js';

const querySchema = z.object({
  range: z.enum(['7d', '30d', '90d', 'all']).optional(),
});

const csvEscape = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (stats: PhotographerStats): string => {
  const headers = [
    'total_photos',
    'total_sales',
    'gross_earnings_cents',
    'pending_payout_cents',
    'paid_payouts_cents',
    'conversion_rate',
    'face_match_appearance_rate',
  ];
  const values = [
    stats.totalPhotos,
    stats.totalSales,
    stats.grossEarningsCents,
    stats.pendingPayoutCents,
    stats.paidPayoutsCents,
    stats.conversionRate,
    stats.faceMatchAppearanceRate,
  ];
  const lines = [
    headers.join(','),
    values.map(csvEscape).join(','),
    '',
    'top_photo_id,revenue_cents,views,sales',
    ...stats.topPhotos.map((p) =>
      [p.photoId, p.revenueCents, p.views, p.sales].map(csvEscape).join(','),
    ),
  ];
  return lines.join('\n');
};

export interface MePhotographerOptions {
  db?: DbClient;
}

const mePhotographerRoutes = async (
  app: FastifyInstance,
  opts: MePhotographerOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  const resolveRange = (raw: unknown): StatsRange | null => {
    const q = querySchema.safeParse(raw);
    if (!q.success) return null;
    return q.data.range ?? '30d';
  };

  app.get('/v1/me/photographer/stats', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const range = resolveRange(request.query);
    if (!range) return reply.code(400).send({ error: 'invalid_request' });
    const stats = await getPhotographerStats(db, userId, { range });
    return reply.code(200).send(stats);
  });

  app.get('/v1/me/photographer/stats.csv', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const range = resolveRange(request.query);
    if (!range) return reply.code(400).send({ error: 'invalid_request' });
    const stats = await getPhotographerStats(db, userId, { range });
    return reply
      .code(200)
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="photographer-stats-${range}.csv"`)
      .send(toCsv(stats));
  });
};

export default mePhotographerRoutes;

// F3.9 — organizer event analytics routes.
//
// GET /v1/events/:id/stats[.csv] — gated by commerce:read_orders on the event
// resource, so an event organizer (event-scoped escalation) or admin passes.
// Stats never include PII.

import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { type EventStats, getEventStats } from '../services/event-stats.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const eventResource = (req: FastifyRequest): { kind: 'event'; id: string } | undefined => {
  const parsed = paramsSchema.safeParse(req.params);
  return parsed.success ? { kind: 'event', id: parsed.data.id } : undefined;
};

const csvEscape = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (stats: EventStats): string => {
  const scalarHeaders = [
    'total_photos_uploaded',
    'photos_with_faces',
    'unique_faces_detected',
    'total_orders',
    'gross_revenue_cents',
    'net_revenue_cents',
    'refund_count',
    'refund_amount_cents',
    'conversion_rate',
    'currency',
  ];
  const scalarValues = [
    stats.totalPhotosUploaded,
    stats.photosWithFaces,
    stats.uniqueFacesDetected,
    stats.totalOrders,
    stats.grossRevenueCents,
    stats.netRevenueCents,
    stats.refundCount,
    stats.refundAmountCents,
    stats.conversionRate,
    stats.currency,
  ];
  const lines = [
    scalarHeaders.join(','),
    scalarValues.map(csvEscape).join(','),
    '',
    'hour,sales_cents,order_count',
    ...stats.salesByHour.map((b) => [b.hour, b.salesCents, b.orderCount].map(csvEscape).join(',')),
  ];
  return lines.join('\n');
};

export interface EventStatsOptions {
  db?: DbClient;
}

const eventStatsRoutes = async (
  app: FastifyInstance,
  opts: EventStatsOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  const parseWindow = (raw: unknown): { from?: Date; to?: Date } | null => {
    const q = querySchema.safeParse(raw);
    if (!q.success) return null;
    const window: { from?: Date; to?: Date } = {};
    if (q.data.from) window.from = new Date(q.data.from);
    if (q.data.to) window.to = new Date(q.data.to);
    return window;
  };

  app.get(
    '/v1/events/:id/stats',
    { preHandler: app.requirePermission('commerce:read_orders', { resource: eventResource }) },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      const window = parseWindow(request.query);
      if (!window) return reply.code(400).send({ error: 'invalid_request' });
      const stats = await getEventStats(db, params.data.id, window);
      return reply.code(200).send(stats);
    },
  );

  app.get(
    '/v1/events/:id/stats.csv',
    { preHandler: app.requirePermission('commerce:read_orders', { resource: eventResource }) },
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
      const window = parseWindow(request.query);
      if (!window) return reply.code(400).send({ error: 'invalid_request' });
      const stats = await getEventStats(db, params.data.id, window);
      return reply
        .code(200)
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="event-${params.data.id}-stats.csv"`)
        .send(toCsv(stats));
    },
  );
};

export default eventStatsRoutes;

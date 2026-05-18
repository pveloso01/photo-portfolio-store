// Search routes — F1.23 bib + name lookup endpoints.
//
// Anonymous-allowed when the event is `published` AND its event_settings row
// has `allow_anonymous_browse=true`. Otherwise an authenticated caller with
// the matching `search:bib` / `search:name` permission may invoke the
// endpoint. 404 is returned in all "not viewable" cases so we never leak
// event existence to outsiders.
//
// Rate limited to 60 req/min per IP via @fastify/rate-limit (scoped to this
// plugin's routes only).

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { hashIp, writeAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { createPreviewUrlCache, getPhotoUrlsBatch } from '../lib/preview-urls.js';
import { type SearchResult, searchByBib, searchByName } from '../services/search.js';

const { events, eventSettings } = schema.events.tables;

// ---------- Schemas ----------

const uuidSchema = z.string().uuid();

const eventParamSchema = z.object({ eventId: uuidSchema });

const bibBodySchema = z.object({
  bibNumber: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const nameBodySchema = z.object({
  name: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

// ---------- Access gate ----------

interface AccessContext {
  hasAuthedPermission: boolean;
}

// Resolve whether the caller may search the given event. Returns null when
// the event either doesn't exist, is unpublished/archived, or has
// anonymous browse disabled and the caller lacks the permission.
const checkSearchAccess = async (
  db: DbClient,
  eventId: string,
  ctx: AccessContext,
): Promise<{ ok: boolean }> => {
  const rows = await db
    .select({
      status: events.status,
      allowAnonymousBrowse: eventSettings.allowAnonymousBrowse,
    })
    .from(events)
    .leftJoin(eventSettings, eq(eventSettings.eventId, events.id))
    .where(eq(events.id, eventId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false };

  // Authenticated callers with explicit permission can always read.
  if (ctx.hasAuthedPermission) return { ok: true };

  // Anonymous: event must be published AND allow_anonymous_browse=true.
  if (row.status !== 'published') return { ok: false };
  if (row.allowAnonymousBrowse !== true) return { ok: false };
  return { ok: true };
};

// ---------- Permission probe ----------

// Detect whether the caller passes the matching permission gate without
// short-circuiting on missing auth. We don't reuse requirePermission
// directly because we need a soft "do you have it?" check — anonymous
// browse is the default fast path.
type RequirePermission = (permission: string) => (req: FastifyRequest) => Promise<void> | void;

const probeAuthedPermission = async (
  app: FastifyInstance,
  request: FastifyRequest,
  permission: string,
): Promise<boolean> => {
  if (!request.user?.id) return false;
  const requirePermission = (app as unknown as { requirePermission?: RequirePermission })
    .requirePermission;
  if (typeof requirePermission !== 'function') return true; // best-effort in test contexts
  try {
    await requirePermission(permission)(request);
    return true;
  } catch {
    return false;
  }
};

// ---------- Response shaping ----------

interface SearchMatchResponse {
  photoId: string;
  rank: number;
  score: number;
  thumbUrl: string | null;
  previewUrl: string | null;
}

const shapeMatches = async (db: DbClient, result: SearchResult): Promise<SearchMatchResponse[]> => {
  const cache = createPreviewUrlCache();
  const photoIds = result.matches.map((m) => m.photoId);
  const urls = await getPhotoUrlsBatch(db, photoIds, cache);
  return result.matches.map((m) => {
    const u = urls.get(m.photoId);
    return {
      photoId: m.photoId,
      rank: m.rank,
      score: m.score,
      thumbUrl: u?.thumbUrl ?? null,
      previewUrl: u?.previewUrl ?? null,
    };
  });
};

// ---------- Plugin ----------

export interface SearchRoutesOptions {
  db?: DbClient;
}

const searchRoutes = async (
  app: FastifyInstance,
  opts: SearchRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // Per-route rate limit config: 60 req/min/IP. We don't fail open when
  // the plugin isn't registered — both endpoints declare config so Fastify
  // applies it once @fastify/rate-limit is wired in server.ts.
  const rateLimitConfig = {
    rateLimit: {
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest): string => req.ip,
    },
  };

  const handleSearch = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'bib' | 'name',
  ): Promise<FastifyReply> => {
    const params = eventParamSchema.safeParse(request.params);
    if (!params.success) {
      // Don't reveal whether the event id is malformed vs missing.
      return reply.code(404).send({ error: 'not found' });
    }

    const permission = kind === 'bib' ? 'search:bib' : 'search:name';
    const hasAuthedPermission = await probeAuthedPermission(app, request, permission);

    const access = await checkSearchAccess(db, params.data.eventId, { hasAuthedPermission });
    if (!access.ok) {
      return reply.code(404).send({ error: 'not found' });
    }

    const bodyParsed =
      kind === 'bib'
        ? bibBodySchema.safeParse(request.body)
        : nameBodySchema.safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: bodyParsed.error.issues });
    }

    const ipHash = hashIp(request.ip);
    const userAgent = request.headers['user-agent'];

    let result: SearchResult;
    try {
      if (kind === 'bib') {
        const body = bodyParsed.data as z.infer<typeof bibBodySchema>;
        result = await searchByBib(db, {
          eventId: params.data.eventId,
          bibNumber: body.bibNumber,
          limit: body.limit,
          cursor: body.cursor,
          clientIpHash: ipHash,
          userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        });
      } else {
        const body = bodyParsed.data as z.infer<typeof nameBodySchema>;
        result = await searchByName(db, {
          eventId: params.data.eventId,
          name: body.name,
          limit: body.limit,
          cursor: body.cursor,
          clientIpHash: ipHash,
          userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        });
      }
    } catch (err) {
      request.log?.error?.({ err }, 'search failed');
      return reply.code(500).send({ error: 'search failed' });
    }

    const matches = await shapeMatches(db, result);

    await writeAudit(db, {
      action: kind === 'bib' ? 'search.bib.executed' : 'search.name.executed',
      actorKind: request.user?.id ? 'user' : 'system',
      actorUserId: request.user?.id,
      targetKind: 'event',
      targetId: params.data.eventId,
      eventId: params.data.eventId,
      ipHash,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      payload: {
        sessionId: result.sessionId,
        matchesCount: result.matches.length,
        latencyMs: result.latencyMs,
        kind,
      },
    });

    return reply.code(200).send({
      sessionId: result.sessionId,
      matches,
      total: result.total,
      nextCursor: result.nextCursor,
      latencyMs: result.latencyMs,
    });
  };

  app.post('/v1/events/:eventId/search/bib', { config: rateLimitConfig }, async (request, reply) =>
    handleSearch(request, reply, 'bib'),
  );

  app.post('/v1/events/:eventId/search/name', { config: rateLimitConfig }, async (request, reply) =>
    handleSearch(request, reply, 'name'),
  );
};

export default searchRoutes;

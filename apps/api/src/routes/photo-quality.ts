// F3.13 — photo quality detail.
//
// GET /v1/photos/:id/quality — authed; owner = the photo's photographer.
// Returns the raw quality scores, a plain-language explanation per flag, and
// the near-duplicate group siblings. Owner-gated within the handler (RBAC does
// not model per-photo ownership), so the main thread adds this to the exempt
// list. Anti-enumeration: 404 for both "missing" and "not yours".

import type { DbClient } from '@pkg/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';
import { getPhotoQuality } from '../services/photo-quality.js';

const idParamSchema = z.object({ id: z.string().uuid() });

export interface PhotoQualityOptions {
  db?: DbClient;
}

const photoQualityRoutes = async (
  app: FastifyInstance,
  opts: PhotoQualityOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get('/v1/photos/:id/quality', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const detail = await getPhotoQuality(db, params.data.id, userId);
    if (!detail) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(detail);
  });
};

export default photoQualityRoutes;

// F3.4 — public takedown submission + verification + status.
//
// POST /v1/takedowns        — anonymous-allowed; rate-limited per IP.
// GET  /v1/takedowns/:id/verify?token= — anonymous-allowed; consumes the
//                              email-verification token.
// GET  /v1/takedowns/:id?token= — anonymous-allowed; token-gated subject view.

import rateLimit from '@fastify/rate-limit';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { hashIp } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import {
  type MailerFn,
  TakedownError,
  createTakedownRequest,
  getTakedownStatus,
  verifyTakedown,
} from '../services/takedowns.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const tokenQuerySchema = z.object({ token: z.string().min(8).max(256) });

const submitBodySchema = z
  .object({
    subjectEmail: z.string().email().max(320),
    reason: z.enum(['lgpd', 'gdpr', 'bipa', 'copyright', 'other']),
    legalBasis: z.string().min(1).max(2000),
    photoIds: z.array(z.string().uuid()).max(500).optional(),
    evidenceUrl: z.string().url().max(1000).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

const getClientIp = (req: FastifyRequest): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? req.ip;
  }
  return req.ip;
};

const mapTakedownError = (reply: FastifyReply, err: TakedownError): FastifyReply => {
  switch (err.code) {
    case 'not_found':
    case 'invalid_token':
      return reply.code(404).send({ error: 'not_found' });
    case 'already_verified':
      return reply.code(409).send({ error: 'already_verified' });
    case 'expired':
      return reply.code(410).send({ error: 'expired' });
    default:
      return reply.code(400).send({ error: err.code, message: err.message });
  }
};

export interface TakedownRoutesOptions {
  db?: DbClient;
  mailer?: MailerFn;
  baseUrl?: string;
}

const takedownRoutes = async (
  app: FastifyInstance,
  opts: TakedownRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;
  const baseUrl = opts.baseUrl ?? process.env.APP_BASE_URL ?? 'http://localhost:4000';

  // Per-route rate limit: 5 submissions per IP per hour.
  await app.register(rateLimit, {
    max: 5,
    timeWindow: '1 hour',
    keyGenerator: (req) => getClientIp(req),
    allowList: () => false,
  });

  app.post('/v1/takedowns', async (request, reply) => {
    const body = submitBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: body.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const ipHash = hashIp(getClientIp(request));
    try {
      const result = await createTakedownRequest(db, body.data, { ipHash, baseUrl }, opts.mailer);
      return reply.code(202).send({ trackingId: result.trackingId });
    } catch (err) {
      if (err instanceof TakedownError) return mapTakedownError(reply, err);
      request.log.error({ err }, 'takedown submission failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  app.get('/v1/takedowns/:id/verify', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const query = tokenQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const result = await verifyTakedown(db, params.data.id, query.data.token);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof TakedownError) return mapTakedownError(reply, err);
      request.log.error({ err }, 'takedown verify failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  app.get('/v1/takedowns/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const query = tokenQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const status = await getTakedownStatus(db, params.data.id, query.data.token);
    if (!status) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(status);
  });
};

export default takedownRoutes;

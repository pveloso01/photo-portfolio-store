// F3.6 — right-to-know endpoint.
//
// GET /v1/me/biometric-data — authed; owner = request.user. Rate-limited to
// 10/day per user.

import rateLimit from '@fastify/rate-limit';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { hashIp } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { getMyBiometricData } from '../services/biometric-data.js';

const getClientIp = (req: FastifyRequest): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? req.ip;
  }
  return req.ip;
};

export interface MeBiometricDataOptions {
  db?: DbClient;
}

const meBiometricDataRoutes = async (
  app: FastifyInstance,
  opts: MeBiometricDataOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // 10 requests per user per day; falls back to IP when the request is somehow
  // unauthenticated (the handler still 401s separately).
  await app.register(rateLimit, {
    max: 10,
    timeWindow: '24 hours',
    keyGenerator: (req) => req.user?.id ?? getClientIp(req),
    allowList: () => false,
  });

  app.get('/v1/me/biometric-data', async (request, reply) => {
    const user = request.user;
    if (!user?.id) return reply.code(401).send({ error: 'unauthorized' });
    const view = await getMyBiometricData(
      db,
      { userId: user.id, email: user.email },
      { ipHash: hashIp(getClientIp(request)) },
    );
    return reply.code(200).send(view);
  });
};

export default meBiometricDataRoutes;

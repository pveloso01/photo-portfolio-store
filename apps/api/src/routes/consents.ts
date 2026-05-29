// F1.33 — biometric consent routes.
//
// POST   /v1/consents/biometric          anonymous-allowed (rate limited)
// GET    /v1/consents/biometric/:id      owner-only (cookie proof OR auth)
// DELETE /v1/consents/biometric/:id      owner-only (cookie proof OR auth)
//
// "Owner proof" cookie: when a grant succeeds we set an HTTP-only cookie
// `pps_consent_<id>=hmac(<id>, server_secret)` so the anonymous grantor can
// revoke later without an account. The HMAC uses JWT_ACCESS_SECRET (already
// a >=32-char secret in env validation) to avoid introducing yet another
// key surface.

import { createHmac, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { DbClient } from '@pkg/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authEnv } from '../auth/env.js';
import { writeAudit } from '../lib/audit.js';
import { db as defaultDb } from '../lib/db.js';
import { hashIp } from '../lib/ip-hash.js';
import {
  ConsentValidationError,
  type GrantConsentInput,
  cascadeErasure,
  grantConsent,
} from '../services/consents.js';

const COOKIE_PREFIX = 'pps_consent_';

// ---------- Schemas ----------

const jurisdictionSchema = z.enum(['eu_gdpr', 'br_lgpd', 'us_bipa', 'us_ccpa', 'other']);

const acknowledgementsSchema = z.object({
  biometricProcessing: z.literal(true),
  retentionPeriod: z.literal(true),
  rightToErasure: z.literal(true),
  jurisdictionRules: z.literal(true),
});

export const grantConsentBodySchema = z.object({
  eventId: z.string().uuid(),
  jurisdiction: jurisdictionSchema.optional(),
  locale: z.string().min(2).max(16),
  policyVersion: z.string().min(1).max(64),
  email: z.string().email().max(320).optional(),
  acknowledgements: acknowledgementsSchema,
});

const consentParamSchema = z.object({ id: z.string().uuid() });

// ---------- Cookie proof ----------

const proofCookieName = (consentId: string): string => `${COOKIE_PREFIX}${consentId}`;

const computeProof = (consentId: string): string =>
  createHmac('sha256', authEnv.JWT_ACCESS_SECRET).update(consentId, 'utf8').digest('hex');

const verifyProof = (consentId: string, presented: string | undefined): boolean => {
  if (!presented) return false;
  const expected = computeProof(consentId);
  if (presented.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
};

const readProofCookie = (req: FastifyRequest, consentId: string): string | undefined => {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const key = proofCookieName(consentId);
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === key) return decodeURIComponent(rest.join('='));
  }
  return undefined;
};

const setProofCookie = (reply: FastifyReply, consentId: string, expiresAt: Date): void => {
  const value = computeProof(consentId);
  const parts = [
    `${proofCookieName(consentId)}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  reply.header('set-cookie', parts.join('; '));
};

// ---------- Helpers ----------

const getClientIp = (req: FastifyRequest): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? req.ip;
  }
  return req.ip;
};

const getUserAgent = (req: FastifyRequest): string | undefined => {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua : undefined;
};

// Map ConsentValidationError to HTTP. Anti-enumeration: 'event_not_found' is
// returned as 404 with a generic message that does not reveal whether the
// event is missing or face-search is disabled.
const mapConsentError = (reply: FastifyReply, err: ConsentValidationError): FastifyReply => {
  switch (err.code) {
    case 'invalid_request':
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    case 'event_not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'unsupported_policy_version':
      return reply.code(422).send({ error: 'unsupported_policy_version' });
    case 'not_found':
      return reply.code(404).send({ error: 'not_found' });
    case 'forbidden':
      return reply.code(403).send({ error: 'forbidden' });
    default:
      return reply.code(500).send({ error: 'server_error' });
  }
};

// ---------- Plugin ----------

export interface ConsentRoutesOptions {
  db?: DbClient;
}

const consentRoutes = async (
  app: FastifyInstance,
  opts: ConsentRoutesOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  // Per-plugin rate limit: 10 grants per IP per 10 min.
  await app.register(rateLimit, {
    max: 10,
    timeWindow: '10 minutes',
    keyGenerator: (req) => getClientIp(req),
    allowList: () => false,
  });

  // ---------- POST /v1/consents/biometric ----------
  app.post('/v1/consents/biometric', async (request, reply) => {
    const parsed = grantConsentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const ip = getClientIp(request);
    const ipHash = hashIp(ip);
    const userAgent = getUserAgent(request);

    try {
      const input: GrantConsentInput = parsed.data;
      const consent = await grantConsent(db, input, { ipHash, userAgent });
      setProofCookie(reply, consent.id, consent.expiresAt);
      return reply.code(201).send({
        consent: {
          id: consent.id,
          eventId: consent.eventId,
          scope: consent.scope,
          jurisdiction: consent.jurisdiction,
          grantedAt: consent.grantedAt.toISOString(),
          expiresAt: consent.expiresAt.toISOString(),
          retentionUntil: consent.retentionUntil ? consent.retentionUntil.toISOString() : null,
          searchesRemaining: consent.searchesRemaining,
        },
      });
    } catch (err) {
      if (err instanceof ConsentValidationError) return mapConsentError(reply, err);
      request.log.error({ err }, 'consent grant failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // ---------- GET /v1/consents/biometric/:id ----------
  app.get('/v1/consents/biometric/:id', async (request, reply) => {
    const params = consentParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const { id } = params.data;

    const proofOk = verifyProof(id, readProofCookie(request, id));
    if (!proofOk && !request.user?.id) return reply.code(404).send({ error: 'not_found' });

    const { schema } = await import('@pkg/db');
    const { eq, and } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(schema.compliance.tables.consents)
      .where(
        and(
          eq(schema.compliance.tables.consents.id, id),
          eq(schema.compliance.tables.consents.scope, 'biometric'),
        ),
      )
      .limit(1);
    const found = rows[0] as Record<string, unknown> | undefined;
    if (!found) return reply.code(404).send({ error: 'not_found' });

    // Authed caller must match subjectId if present. Anonymous caller is
    // authorised purely by the cookie proof check above.
    if (!proofOk && request.user?.id && found.subjectId && request.user.id !== found.subjectId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return reply.code(200).send({
      consent: {
        id: found.id,
        eventId: found.eventId,
        scope: found.scope,
        jurisdiction: found.jurisdiction,
        grantedAt: (found.grantedAt as Date)?.toISOString?.() ?? null,
        revokedAt: (found.revokedAt as Date | null)?.toISOString?.() ?? null,
        expiresAt: (found.expiresAt as Date | null)?.toISOString?.() ?? null,
        retentionUntil: (found.retentionUntil as Date | null)?.toISOString?.() ?? null,
        searchesUsed: Number(found.searchesUsed ?? 0),
      },
    });
  });

  // ---------- DELETE /v1/consents/biometric/:id ----------
  app.delete('/v1/consents/biometric/:id', async (request, reply) => {
    const params = consentParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const { id } = params.data;

    const proofOk = verifyProof(id, readProofCookie(request, id));
    const userId = request.user?.id;
    if (!proofOk && !userId) {
      await writeAudit(db, {
        action: 'biometric.consent.revoke.denied',
        actorKind: 'system',
        targetKind: 'consent',
        targetId: id,
        ipHash: hashIp(getClientIp(request)),
        userAgent: getUserAgent(request),
        payload: { reason: 'no_proof' },
      });
      return reply.code(404).send({ error: 'not_found' });
    }

    try {
      const ipHash = hashIp(getClientIp(request));
      const userAgent = getUserAgent(request);
      // F3.7 — full erasure cascade: revoke + Qdrant + face_vectors + search
      // sessions + search matches + confirmation email when we know the
      // subject's address (authed user). Same 204 contract as M1.
      const subjectEmail = request.user?.email;
      const result = await cascadeErasure(db, id, { ipHash, userAgent, subjectEmail });
      return reply.code(204).send({ result });
    } catch (err) {
      if (err instanceof ConsentValidationError) return mapConsentError(reply, err);
      request.log.error({ err }, 'consent revoke failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });
};

export default consentRoutes;

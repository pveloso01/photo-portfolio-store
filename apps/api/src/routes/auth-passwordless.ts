// Passwordless (magic-link) auth routes.
//
// Mounts under /v1/auth/passwordless. Exported as a Fastify plugin; wiring
// lives in server.ts (added by the operator, not this file).
//
// Endpoints:
//   POST /v1/auth/passwordless/request  → always 200 (no email enumeration)
//   POST /v1/auth/passwordless/verify   → exchanges a magic-link token for
//                                         access + refresh tokens.

import { randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import { schema } from '@pkg/db';
import { and, sql as drizzleSql, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { signAccess, signRefresh } from '../auth/jwt.js';
import {
  MAGIC_LINK_TTL_MIN,
  generateMagicLinkToken,
  hashMagicLinkToken,
} from '../auth/magic-link.js';
import { createSession } from '../auth/tokens.js';
import { hashIp, writeAudit } from '../lib/audit.js';
import { db } from '../lib/db.js';
import { sendMail } from '../lib/email.js';

const { users, magicLinkTokens } = schema.users;

const REFRESH_COOKIE = 'refresh_token';

const requestSchema = z.object({
  email: z.string().email().max(320),
});

const verifySchema = z.object({
  token: z.string().min(1).max(512),
});

const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

const generateRefreshToken = (): string => randomBytes(32).toString('hex');

const getClientIp = (req: FastifyRequest): string => {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() ?? req.ip;
  }
  return req.ip;
};

const setRefreshCookie = (reply: FastifyReply, token: string, expiresAt: Date): void => {
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  reply.header('set-cookie', parts.join('; '));
};

const buildMagicLinkEmail = (url: string): { subject: string; html: string; text: string } => {
  const subject = 'Your sign-in link';
  const text = [
    'Click the link below to sign in. The link expires in',
    `${MAGIC_LINK_TTL_MIN} minutes and can only be used once.`,
    '',
    url,
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');
  const html = `
    <p>Click the link below to sign in. The link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once.</p>
    <p><a href="${url}">${url}</a></p>
    <p>If you did not request this, you can safely ignore this email.</p>
  `.trim();
  return { subject, html, text };
};

const passwordlessRoutes = async (app: FastifyInstance): Promise<void> => {
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => getClientIp(req),
    allowList: () => false,
  });

  const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';

  // ---------- POST /v1/auth/passwordless/request ----------
  app.post(
    '/v1/auth/passwordless/request',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '10 minutes',
          keyGenerator: (req: FastifyRequest) => {
            const body = (req.body ?? {}) as { email?: unknown };
            const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
            return `pwl:req:${email}:${getClientIp(req)}`;
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = requestSchema.safeParse(req.body);
      // Always return 200 to prevent email enumeration — even on schema failure.
      const okResponse = {
        message: 'If that email exists, a link has been sent.',
      };
      if (!parsed.success) {
        return reply.code(200).send(okResponse);
      }
      const email = normalizeEmail(parsed.data.email);
      const ipHash = hashIp(getClientIp(req));
      const userAgent = req.headers['user-agent'] ?? undefined;

      const { plain, hash, expiresAt } = generateMagicLinkToken();

      try {
        await db.insert(magicLinkTokens).values({
          emailLower: email,
          tokenHash: hash,
          expiresAt,
          ipHash: ipHash ?? null,
          userAgent: userAgent ?? null,
        });

        const url = `${appBaseUrl}/auth/verify?token=${encodeURIComponent(plain)}`;
        const { subject, html, text } = buildMagicLinkEmail(url);
        // Send is best-effort; failures are logged inside sendMail.
        await sendMail({ to: email, subject, html, text }).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('[passwordless] sendMail failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });

        await writeAudit(db, {
          action: 'auth.passwordless.requested',
          actorKind: 'system',
          ipHash,
          userAgent,
          // NEVER include the plaintext token in audit payload.
          payload: { emailHash: hashMagicLinkToken(email) },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[passwordless] request failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Still return 200 so timing/error response does not enumerate.
      }

      return reply.code(200).send(okResponse);
    },
  );

  // ---------- POST /v1/auth/passwordless/verify ----------
  app.post(
    '/v1/auth/passwordless/verify',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => `pwl:verify:${getClientIp(req)}`,
        },
      },
    },
    async (req, reply) => {
      const parsed = verifySchema.safeParse(req.body);
      const ipHash = hashIp(getClientIp(req));
      const ip = getClientIp(req);
      const userAgent = req.headers['user-agent'] ?? undefined;

      if (!parsed.success) {
        await writeAudit(db, {
          action: 'auth.passwordless.failed',
          actorKind: 'system',
          ipHash,
          userAgent,
          payload: { reason: 'invalid_request' },
        });
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const tokenHash = hashMagicLinkToken(parsed.data.token);
      const now = new Date();

      const tokenRows = await db
        .select({
          id: magicLinkTokens.id,
          emailLower: magicLinkTokens.emailLower,
          expiresAt: magicLinkTokens.expiresAt,
          consumedAt: magicLinkTokens.consumedAt,
        })
        .from(magicLinkTokens)
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.consumedAt),
            gt(magicLinkTokens.expiresAt, now),
          ),
        )
        .limit(1);

      const tokenRow = tokenRows[0];
      if (!tokenRow) {
        await writeAudit(db, {
          action: 'auth.passwordless.failed',
          actorKind: 'system',
          ipHash,
          userAgent,
          payload: { reason: 'invalid_or_expired_or_consumed' },
        });
        return reply.code(401).send({ error: 'invalid_token' });
      }

      // Mark consumed BEFORE issuing tokens — atomic guard against replay.
      const consumed = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(and(eq(magicLinkTokens.id, tokenRow.id), isNull(magicLinkTokens.consumedAt)))
        .returning({ id: magicLinkTokens.id });

      if (consumed.length === 0) {
        // Race: another request consumed it first.
        await writeAudit(db, {
          action: 'auth.passwordless.failed',
          actorKind: 'system',
          ipHash,
          userAgent,
          payload: { reason: 'already_consumed' },
        });
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const email = tokenRow.emailLower;

      // Find-or-create user by email (lowercase).
      const existingRows = await db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          status: users.status,
        })
        .from(users)
        .where(drizzleSql`lower(${users.email}) = ${email}`)
        .limit(1);

      let user = existingRows[0];

      if (!user) {
        const inserted = await db
          .insert(users)
          .values({
            email,
            passwordHash: null,
            emailVerifiedAt: now,
          })
          .returning({
            id: users.id,
            email: users.email,
            role: users.role,
            status: users.status,
          });
        user = inserted[0];
        if (!user) {
          return reply.code(500).send({ error: 'user_create_failed' });
        }
      }

      if (user.status !== 'active') {
        await writeAudit(db, {
          action: 'auth.passwordless.failed',
          actorKind: 'system',
          actorUserId: user.id,
          ipHash,
          userAgent,
          payload: { reason: 'user_inactive' },
        });
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const refreshTokenPlain = generateRefreshToken();
      const session = await createSession(db, user.id, refreshTokenPlain, userAgent ?? null, ip);
      const accessToken = signAccess({ sub: user.id, role: user.role });
      const refreshTokenJwt = signRefresh({ sub: user.id, sid: session.id });

      setRefreshCookie(reply, refreshTokenPlain, session.expiresAt);

      await writeAudit(db, {
        action: 'auth.passwordless.verified',
        actorKind: 'user',
        actorUserId: user.id,
        targetKind: 'session',
        targetId: session.id,
        ipHash,
        userAgent,
      });

      return reply.code(200).send({
        accessToken,
        refreshToken: refreshTokenPlain,
        refreshTokenJwt,
        user: { id: user.id, email: user.email, role: user.role },
      });
    },
  );
};

export default passwordlessRoutes;

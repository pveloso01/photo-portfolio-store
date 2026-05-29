// F3.4 / F3.5 — takedown request lifecycle.
//
// Submission: anyone (anon-allowed). Server creates a `received` row, mints a
// raw verification token, stores sha256(token), and emails the link. SLA timer
// (received_at + 24h) is set by the DB trigger.
//
// Verification: GET with the raw token; we sha256 it, look up the unconsumed
// token row, mark consumed, and transition the request to `verifying` so it
// surfaces in the admin queue.
//
// Status: a token-gated read for the subject (the same raw token works as a
// read credential until consumed; once consumed we still let the subject poll
// by tracking_id for the lifetime of the request because the token is gone).
//
// audit_trail is append-only at the app layer.

import { createHash, randomBytes } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, sql } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';
import { sendMail as defaultSendMail } from '../lib/email.js';

const { takedownRequests, takedownVerificationTokens } = schema.compliance.tables;

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RAW_TOKEN_BYTES = 32;

export type TakedownReason = 'lgpd' | 'gdpr' | 'bipa' | 'copyright' | 'other';

export class TakedownError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'invalid_token'
      | 'already_verified'
      | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'TakedownError';
  }
}

export interface CreateTakedownInput {
  subjectEmail: string;
  reason: TakedownReason;
  legalBasis: string;
  photoIds?: string[];
  evidenceUrl?: string;
  notes?: string;
}

export interface CreateTakedownContext {
  ipHash?: string;
  baseUrl: string;
}

export interface CreateTakedownResult {
  trackingId: string;
}

export type MailerFn = typeof defaultSendMail;

const hashToken = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

const appendTrailEntry = (
  current: unknown,
  entry: { at: string; action: string; payload?: Record<string, unknown> },
): unknown[] => {
  const arr = Array.isArray(current) ? current : [];
  return [...arr, entry];
};

// ---------- createTakedownRequest ----------

export const createTakedownRequest = async (
  db: DbClient,
  input: CreateTakedownInput,
  ctx: CreateTakedownContext,
  mailer: MailerFn = defaultSendMail,
): Promise<CreateTakedownResult> => {
  const inserted = await db
    .insert(takedownRequests)
    .values({
      subjectEmail: input.subjectEmail.toLowerCase(),
      photoIds: input.photoIds ?? [],
      reason: input.reason,
      legalBasis: input.legalBasis,
      evidenceUrl: input.evidenceUrl ?? null,
      notes: input.notes ?? null,
      status: 'received',
      submitterIpHash: ctx.ipHash ?? null,
      // sla_due_at is required NOT NULL. The DB trigger sets it on real
      // Postgres; we set both explicitly so the shim and production behave the
      // same way and a future trigger removal stays safe.
      receivedAt: new Date(),
      slaDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      auditTrail: appendTrailEntry([], {
        at: new Date().toISOString(),
        action: 'received',
        payload: { reason: input.reason },
      }),
    })
    .returning({ id: takedownRequests.id });
  const row = inserted[0];
  if (!row) throw new TakedownError('invalid_request', 'insert returned no row');

  // Mint and store the verification token. Raw token returned ONLY via email;
  // its sha256 is what we persist.
  const rawToken = randomBytes(RAW_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
  await db.insert(takedownVerificationTokens).values({
    trackingId: row.id,
    tokenHash,
    expiresAt,
  });

  const baseUrl = ctx.baseUrl.replace(/\/$/, '');
  const verifyUrl = `${baseUrl}/v1/takedowns/${row.id}/verify?token=${rawToken}`;

  await mailer({
    to: input.subjectEmail,
    subject: 'Verify your takedown request',
    text: [
      'You (or someone using your email) submitted a takedown request.',
      `Tracking id: ${row.id}`,
      `Reason: ${input.reason}`,
      '',
      'Verify within 24 hours:',
      verifyUrl,
    ].join('\n'),
    html: `<p>You submitted a takedown request.</p>
<p>Tracking id: <code>${row.id}</code></p>
<p>Reason: ${input.reason}</p>
<p><a href="${verifyUrl}">Verify within 24 hours</a></p>`,
  }).catch(() => undefined);

  await writeAudit(db, {
    action: 'takedown.submitted',
    actorKind: 'system',
    targetKind: 'takedown_request',
    targetId: row.id,
    ipHash: ctx.ipHash,
    payload: { reason: input.reason, emailHash: hashToken(input.subjectEmail.toLowerCase()) },
  });

  return { trackingId: row.id };
};

// ---------- verifyTakedown ----------

export const verifyTakedown = async (
  db: DbClient,
  trackingId: string,
  rawToken: string,
): Promise<{ status: 'verifying' }> => {
  const tokenHash = hashToken(rawToken);
  const rows = await db
    .select()
    .from(takedownVerificationTokens)
    .where(
      and(
        eq(takedownVerificationTokens.trackingId, trackingId),
        eq(takedownVerificationTokens.tokenHash, tokenHash),
      ),
    )
    .limit(1);
  const token = rows[0];
  if (!token) throw new TakedownError('invalid_token', 'token not found');
  if (token.consumedAt) throw new TakedownError('already_verified', 'token already consumed');
  if (token.expiresAt.getTime() < Date.now()) throw new TakedownError('expired', 'token expired');

  await db
    .update(takedownVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(eq(takedownVerificationTokens.id, token.id));

  // Transition the request to `verifying` so the admin queue surfaces it.
  const reqRows = await db
    .select({ status: takedownRequests.status, auditTrail: takedownRequests.auditTrail })
    .from(takedownRequests)
    .where(eq(takedownRequests.id, trackingId))
    .limit(1);
  const req = reqRows[0];
  if (!req) throw new TakedownError('not_found', 'takedown request not found');
  if (req.status === 'received') {
    await db
      .update(takedownRequests)
      .set({
        status: 'verifying',
        verifiedAt: new Date(),
        auditTrail: appendTrailEntry(req.auditTrail, {
          at: new Date().toISOString(),
          action: 'verified',
        }),
      })
      .where(eq(takedownRequests.id, trackingId));
  }
  await writeAudit(db, {
    action: 'takedown.verified',
    actorKind: 'system',
    targetKind: 'takedown_request',
    targetId: trackingId,
  });
  return { status: 'verifying' };
};

// ---------- getTakedownStatus (token-gated subject view) ----------

export const getTakedownStatus = async (
  db: DbClient,
  trackingId: string,
  rawToken: string,
): Promise<{
  status: string;
  receivedAt: string;
  slaDueAt: string;
  fulfilledAt: string | null;
} | null> => {
  const tokenHash = hashToken(rawToken);
  const tokens = await db
    .select({ id: takedownVerificationTokens.id })
    .from(takedownVerificationTokens)
    .where(
      and(
        eq(takedownVerificationTokens.trackingId, trackingId),
        eq(takedownVerificationTokens.tokenHash, tokenHash),
      ),
    )
    .limit(1);
  if (!tokens[0]) return null;

  const rows = await db
    .select({
      status: takedownRequests.status,
      receivedAt: takedownRequests.receivedAt,
      slaDueAt: takedownRequests.slaDueAt,
      fulfilledAt: takedownRequests.fulfilledAt,
    })
    .from(takedownRequests)
    .where(eq(takedownRequests.id, trackingId))
    .limit(1);
  const req = rows[0];
  if (!req) return null;
  return {
    status: req.status,
    receivedAt: req.receivedAt.toISOString(),
    slaDueAt: req.slaDueAt.toISOString(),
    fulfilledAt: req.fulfilledAt ? req.fulfilledAt.toISOString() : null,
  };
};

// ---------- Admin: list overdue ----------

export const listOverdueTakedowns = async (
  db: DbClient,
  now: Date = new Date(),
): Promise<Array<{ id: string; slaDueAt: Date; status: string }>> => {
  const rows = await db
    .select({
      id: takedownRequests.id,
      slaDueAt: takedownRequests.slaDueAt,
      status: takedownRequests.status,
    })
    .from(takedownRequests)
    .where(
      and(
        sql`${takedownRequests.slaDueAt} < ${now}`,
        sql`${takedownRequests.status} not in ('fulfilled', 'rejected')`,
      ),
    );
  return rows.map((r) => ({ id: r.id, slaDueAt: r.slaDueAt, status: r.status }));
};

// F3.5 — takedown fulfillment workflow.
//
// fulfill(takedownId, { approvedPhotoIds }) hides each approved photo, purges
// face vectors from Qdrant + Postgres, deletes R2 objects, writes one audit
// row per artifact removed, appends a structured entry to audit_trail, and
// emails the subject a confirmation.
//
// Per-artifact isolation: if any sub-step throws for a photo we abort that
// photo (no DB flip, no audit) and surface it as `failed`. Re-running the
// fulfill action retries failed items idempotently (moderation.bulkModerate
// is idempotent; Qdrant DELETE by filter and S3 DeleteObject are too).
//
// SLA alert: listOverdueTakedowns + a cron in the worker (see workers/
// takedown-sla-alert.ts) fires when sla_due_at has passed and status is not
// in ('fulfilled', 'rejected').

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { eq } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';
import { sendMail as defaultSendMail } from '../lib/email.js';
import { type ModerationDeps, bulkModerate } from './moderation.js';
import { type MailerFn, TakedownError } from './takedowns.js';

const { takedownRequests } = schema.compliance.tables;

export interface FulfillInput {
  approvedPhotoIds: string[];
  notes?: string;
}

export interface FulfillResult {
  status: 'fulfilled';
  fulfilled: string[];
  failed: string[];
}

export interface FulfillContext {
  adminUserId: string;
}

const appendTrail = (
  current: unknown,
  entry: { at: string; action: string; payload?: Record<string, unknown> },
): unknown[] => {
  const arr = Array.isArray(current) ? current : [];
  return [...arr, entry];
};

export const fulfillTakedown = async (
  db: DbClient,
  takedownId: string,
  input: FulfillInput,
  ctx: FulfillContext,
  deps: ModerationDeps = {},
  mailer: MailerFn = defaultSendMail,
): Promise<FulfillResult> => {
  const rows = await db
    .select({
      id: takedownRequests.id,
      status: takedownRequests.status,
      subjectEmail: takedownRequests.subjectEmail,
      auditTrail: takedownRequests.auditTrail,
    })
    .from(takedownRequests)
    .where(eq(takedownRequests.id, takedownId))
    .limit(1);
  const req = rows[0];
  if (!req) throw new TakedownError('not_found', 'takedown request not found');
  if (req.status === 'fulfilled' || req.status === 'rejected') {
    throw new TakedownError('invalid_request', `cannot fulfill a ${req.status} takedown`);
  }
  if (input.approvedPhotoIds.length === 0) {
    throw new TakedownError('invalid_request', 'approvedPhotoIds must not be empty');
  }

  // Delegate the artifact purge to moderation.bulkModerate('delete'). That
  // service already does the per-photo R2 + Qdrant + DB sync with rollback on
  // purge failure.
  const bulk = await bulkModerate(
    db,
    'delete',
    input.approvedPhotoIds,
    { adminUserId: ctx.adminUserId },
    deps,
  );

  const fulfilledIds = input.approvedPhotoIds.filter((id) => !bulk.failed.includes(id));

  const now = new Date();
  const allDone = bulk.failed.length === 0;
  const newStatus = allDone ? 'fulfilled' : req.status;
  const fulfilledAt = allDone ? now : null;
  const trail = appendTrail(req.auditTrail, {
    at: now.toISOString(),
    action: allDone ? 'fulfilled' : 'partially_fulfilled',
    payload: {
      requested: input.approvedPhotoIds.length,
      fulfilled: fulfilledIds.length,
      failed: bulk.failed.length,
      notes: input.notes ?? null,
    },
  });
  await db
    .update(takedownRequests)
    .set({
      status: newStatus,
      fulfilledAt,
      fulfilledBy: allDone ? ctx.adminUserId : null,
      auditTrail: trail,
      notes: input.notes ?? null,
    })
    .where(eq(takedownRequests.id, takedownId));

  await writeAudit(db, {
    action: 'takedown.fulfilled',
    actorKind: 'admin',
    actorUserId: ctx.adminUserId,
    targetKind: 'takedown_request',
    targetId: takedownId,
    payload: { fulfilled: fulfilledIds.length, failed: bulk.failed.length },
  });

  // Email subject — best-effort.
  if (allDone) {
    await mailer({
      to: req.subjectEmail,
      subject: 'Your takedown request has been fulfilled',
      text: [
        `Tracking id: ${takedownId}`,
        `Photos removed: ${fulfilledIds.length}`,
        fulfilledIds.length > 0 ? `Ids: ${fulfilledIds.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      html: `<p>Tracking id: <code>${takedownId}</code></p><p>Photos removed: ${fulfilledIds.length}</p>`,
    }).catch(() => undefined);
  }

  return {
    status: 'fulfilled',
    fulfilled: fulfilledIds,
    failed: bulk.failed,
  };
};

export const rejectTakedown = async (
  db: DbClient,
  takedownId: string,
  input: { rejectionReason: string },
  ctx: FulfillContext,
  mailer: MailerFn = defaultSendMail,
): Promise<{ status: 'rejected' }> => {
  const rows = await db
    .select({
      id: takedownRequests.id,
      status: takedownRequests.status,
      subjectEmail: takedownRequests.subjectEmail,
      auditTrail: takedownRequests.auditTrail,
    })
    .from(takedownRequests)
    .where(eq(takedownRequests.id, takedownId))
    .limit(1);
  const req = rows[0];
  if (!req) throw new TakedownError('not_found', 'takedown request not found');
  if (req.status === 'fulfilled' || req.status === 'rejected') {
    throw new TakedownError('invalid_request', `cannot reject a ${req.status} takedown`);
  }
  const now = new Date();
  await db
    .update(takedownRequests)
    .set({
      status: 'rejected',
      rejectionReason: input.rejectionReason,
      fulfilledBy: ctx.adminUserId,
      auditTrail: appendTrail(req.auditTrail, {
        at: now.toISOString(),
        action: 'rejected',
        payload: { reason: input.rejectionReason },
      }),
    })
    .where(eq(takedownRequests.id, takedownId));

  await writeAudit(db, {
    action: 'takedown.rejected',
    actorKind: 'admin',
    actorUserId: ctx.adminUserId,
    targetKind: 'takedown_request',
    targetId: takedownId,
    payload: { reason: input.rejectionReason },
  });

  await mailer({
    to: req.subjectEmail,
    subject: 'Your takedown request was denied',
    text: `Tracking id: ${takedownId}\nReason: ${input.rejectionReason}`,
    html: `<p>Tracking id: <code>${takedownId}</code></p><p>${input.rejectionReason}</p>`,
  }).catch(() => undefined);

  return { status: 'rejected' };
};

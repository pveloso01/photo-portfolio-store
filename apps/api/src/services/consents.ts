// F1.33 — biometric consent service.
//
// All consent grants funnel through this module. The route layer (routes/
// consents.ts) is a thin Fastify wrapper around grantConsent / verifyConsent
// / incrementSearchUsage / revokeConsent.
//
// Locked decisions (see plans/stateful-percolating-simon.md):
//   - 24h TTL + 20-search quota per biometric consent.
//   - Strictest jurisdiction (eu_gdpr) by default; user-declared override
//     restricted to a documented enum.
//   - Soft-bind on (ip_hash, user_agent) — see lib/soft-bind.ts. 'mismatch'
//     audited as consent.suspicious_reuse and rejected.
//   - Email never stored raw — only sha256(lower(email)).
//   - Selfie bytes NEVER touched here. This module only handles consent
//     state — the face-search service handles the image.

import { createHash } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';
import { sendMail as defaultSendMail } from '../lib/email.js';
import { type PolicyJurisdiction, isVersionSupported } from '../lib/policy-versions.js';
import { type SoftBindResult, softBindMatch } from '../lib/soft-bind.js';

const { consents } = schema.compliance.tables;
const { events } = schema.events.tables;

// ---------- Types ----------

export type ConsentScope = 'biometric';

export interface ConsentAcknowledgements {
  biometricProcessing: true;
  retentionPeriod: true;
  rightToErasure: true;
  jurisdictionRules: true;
}

export interface GrantConsentInput {
  eventId: string;
  jurisdiction?: PolicyJurisdiction;
  locale: string;
  policyVersion: string;
  email?: string;
  acknowledgements: ConsentAcknowledgements;
}

export interface ConsentRequestContext {
  ipHash?: string;
  userAgent?: string;
}

export interface ConsentRecord {
  id: string;
  eventId: string;
  scope: ConsentScope;
  jurisdiction: PolicyJurisdiction;
  grantedAt: Date;
  expiresAt: Date;
  retentionUntil: Date | null;
  searchesRemaining: number;
}

export type VerifyFailureReason =
  | 'not_found'
  | 'wrong_event'
  | 'expired'
  | 'revoked'
  | 'quota_exhausted'
  | 'bind_mismatch';

export type VerifyConsentResult =
  | { ok: true; consent: ConsentRow }
  | { ok: false; reason: VerifyFailureReason; softBind?: SoftBindResult };

export interface ConsentRow {
  id: string;
  scope: string;
  eventId: string | null;
  subjectId: string | null;
  subjectEmailHash: string | null;
  jurisdiction: string;
  grantedAt: Date;
  revokedAt: Date | null;
  retentionUntil: Date | null;
  expiresAt: Date | null;
  ipHash: string | null;
  userAgent: string | null;
  searchesUsed: number;
}

// ---------- Errors ----------

export class ConsentValidationError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'event_not_found'
      | 'unsupported_policy_version'
      | 'not_found'
      | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'ConsentValidationError';
  }
}

export class QuotaExhaustedError extends Error {
  constructor() {
    super('consent search quota exhausted');
    this.name = 'QuotaExhaustedError';
  }
}

// ---------- Constants ----------

const CONSENT_TTL_HOURS = 24;
export const CONSENT_SEARCH_QUOTA = 20;

const ACK_KEYS: ReadonlyArray<keyof ConsentAcknowledgements> = [
  'biometricProcessing',
  'retentionPeriod',
  'rightToErasure',
  'jurisdictionRules',
];

// ---------- Helpers ----------

const hashEmail = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');

const addHours = (base: Date, hours: number): Date =>
  new Date(base.getTime() + hours * 60 * 60 * 1000);

const addDays = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

const allAcksTrue = (acks: ConsentAcknowledgements): boolean =>
  ACK_KEYS.every((k) => acks[k] === true);

interface EventLite {
  id: string;
  retentionDays: number;
  archivedAt: Date | null;
  eventDate: Date;
  status: 'draft' | 'published' | 'archived';
  allowFaceSearch: boolean;
}

const loadEvent = async (db: DbClient, eventId: string): Promise<EventLite | null> => {
  const rows = await db
    .select({
      id: events.id,
      retentionDays: events.retentionDays,
      archivedAt: events.archivedAt,
      eventDate: events.eventDate,
      status: events.status,
      allowFaceSearch: events.allowFaceSearch,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    retentionDays: row.retentionDays,
    archivedAt: row.archivedAt ?? null,
    eventDate: row.eventDate as Date,
    status: row.status as 'draft' | 'published' | 'archived',
    allowFaceSearch: row.allowFaceSearch,
  };
};

const computeRetentionUntil = (event: EventLite): Date => {
  const anchor = event.archivedAt ?? event.eventDate;
  return addDays(anchor, event.retentionDays);
};

const toConsentRow = (row: Record<string, unknown>): ConsentRow => ({
  id: row.id as string,
  scope: row.scope as string,
  eventId: (row.eventId as string | null) ?? null,
  subjectId: (row.subjectId as string | null) ?? null,
  subjectEmailHash: (row.subjectEmailHash as string | null) ?? null,
  jurisdiction: row.jurisdiction as string,
  grantedAt: row.grantedAt as Date,
  revokedAt: (row.revokedAt as Date | null) ?? null,
  retentionUntil: (row.retentionUntil as Date | null) ?? null,
  expiresAt: (row.expiresAt as Date | null) ?? null,
  ipHash: (row.ipHash as string | null) ?? null,
  userAgent: (row.userAgent as string | null) ?? null,
  searchesUsed: Number(row.searchesUsed ?? 0),
});

// ---------- grantConsent ----------

export const grantConsent = async (
  db: DbClient,
  input: GrantConsentInput,
  context: ConsentRequestContext,
): Promise<ConsentRecord> => {
  if (!allAcksTrue(input.acknowledgements)) {
    throw new ConsentValidationError(
      'invalid_request',
      'all acknowledgements must be explicitly true',
    );
  }
  if (!isVersionSupported(input.policyVersion, input.locale)) {
    throw new ConsentValidationError(
      'unsupported_policy_version',
      `policy version ${input.policyVersion}/${input.locale} not in allow-list`,
    );
  }

  const event = await loadEvent(db, input.eventId);
  // Anti-enumeration: same 404 for missing event and face-search disabled.
  if (!event || !event.allowFaceSearch) {
    throw new ConsentValidationError('event_not_found', 'event not available');
  }

  const jurisdiction: PolicyJurisdiction = input.jurisdiction ?? 'eu_gdpr';
  const subjectEmailHash = input.email ? hashEmail(input.email) : null;

  // Idempotency: if an active, non-expired biometric consent already exists
  // for (email_hash, event), return it rather than create a duplicate.
  if (subjectEmailHash) {
    const existing = await db
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.scope, 'biometric'),
          eq(consents.eventId, input.eventId),
          eq(consents.subjectEmailHash, subjectEmailHash),
          isNull(consents.revokedAt),
        ),
      )
      .limit(1);
    const existingRow = existing[0] ? toConsentRow(existing[0] as Record<string, unknown>) : null;
    if (existingRow?.expiresAt && existingRow.expiresAt.getTime() > Date.now()) {
      return {
        id: existingRow.id,
        eventId: existingRow.eventId ?? input.eventId,
        scope: 'biometric',
        jurisdiction: existingRow.jurisdiction as PolicyJurisdiction,
        grantedAt: existingRow.grantedAt,
        expiresAt: existingRow.expiresAt,
        retentionUntil: existingRow.retentionUntil,
        searchesRemaining: Math.max(0, CONSENT_SEARCH_QUOTA - existingRow.searchesUsed),
      };
    }
  }

  const grantedAt = new Date();
  const expiresAt = addHours(grantedAt, CONSENT_TTL_HOURS);
  const retentionUntil = computeRetentionUntil(event);

  const evidenceJsonb: Record<string, unknown> = {
    policyVersion: input.policyVersion,
    locale: input.locale,
    jurisdiction,
    acknowledgements: input.acknowledgements,
    ipHash: context.ipHash ?? null,
    userAgent: context.userAgent ?? null,
    grantedAt: grantedAt.toISOString(),
  };

  const inserted = await db
    .insert(consents)
    .values({
      scope: 'biometric',
      subjectId: null,
      subjectEmailHash,
      eventId: input.eventId,
      grantedAt,
      revokedAt: null,
      retentionUntil,
      jurisdiction,
      evidenceJsonb,
      consentVersion: input.policyVersion,
      ipHash: context.ipHash ?? null,
      userAgent: context.userAgent ?? null,
      searchesUsed: 0,
      expiresAt,
    })
    .returning();

  const row = inserted[0];
  if (!row) throw new Error('consents insert returned no row');
  const persisted = toConsentRow(row as Record<string, unknown>);

  await writeAudit(db, {
    action: 'biometric.consent.granted',
    actorKind: 'user',
    targetKind: 'consent',
    targetId: persisted.id,
    eventId: input.eventId,
    ipHash: context.ipHash,
    userAgent: context.userAgent,
    payload: {
      consentId: persisted.id,
      policyVersion: input.policyVersion,
      locale: input.locale,
      jurisdiction,
      emailProvided: !!subjectEmailHash,
    },
  });

  return {
    id: persisted.id,
    eventId: input.eventId,
    scope: 'biometric',
    jurisdiction,
    grantedAt: persisted.grantedAt,
    expiresAt,
    retentionUntil,
    searchesRemaining: CONSENT_SEARCH_QUOTA,
  };
};

// ---------- verifyConsent ----------

export const verifyConsent = async (
  db: DbClient,
  consentId: string,
  expectedEventId: string,
  bind: ConsentRequestContext,
): Promise<VerifyConsentResult> => {
  const rows = await db
    .select()
    .from(consents)
    .where(and(eq(consents.id, consentId), eq(consents.scope, 'biometric')))
    .limit(1);
  const found = rows[0];
  if (!found) return { ok: false, reason: 'not_found' };

  const row = toConsentRow(found as Record<string, unknown>);

  if (row.eventId !== expectedEventId) return { ok: false, reason: 'wrong_event' };
  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (!row.expiresAt || row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.searchesUsed >= CONSENT_SEARCH_QUOTA) {
    return { ok: false, reason: 'quota_exhausted' };
  }

  const bindResult = softBindMatch(
    { ipHash: row.ipHash, userAgent: row.userAgent },
    { ipHash: bind.ipHash ?? null, userAgent: bind.userAgent ?? null },
  );

  if (bindResult === 'mismatch') {
    await writeAudit(db, {
      action: 'consent.suspicious_reuse',
      actorKind: 'system',
      targetKind: 'consent',
      targetId: row.id,
      eventId: expectedEventId,
      ipHash: bind.ipHash,
      userAgent: bind.userAgent,
      payload: {
        consentId: row.id,
        result: 'mismatch',
      },
    });
    return { ok: false, reason: 'bind_mismatch', softBind: bindResult };
  }

  return { ok: true, consent: row };
};

// ---------- incrementSearchUsage ----------

/**
 * Atomically increment searches_used. Returns the new value. Throws
 * QuotaExhaustedError if the quota was already exhausted (which prevents the
 * row from being updated by the conditional WHERE clause).
 */
export const incrementSearchUsage = async (db: DbClient, consentId: string): Promise<number> => {
  const updated = await db
    .update(consents)
    .set({ searchesUsed: sql`${consents.searchesUsed} + 1` })
    .where(and(eq(consents.id, consentId), sql`${consents.searchesUsed} < ${CONSENT_SEARCH_QUOTA}`))
    .returning({ searchesUsed: consents.searchesUsed });

  const row = updated[0];
  if (!row) throw new QuotaExhaustedError();
  return Number(row.searchesUsed ?? 0);
};

// ---------- revokeConsent ----------

export interface RevokeContext {
  ipHash?: string;
  userAgent?: string;
}

export interface RevokeResult {
  consentId: string;
  vectorsPurged: number;
  collectionDropped: boolean;
}

export interface QdrantDeleterDeps {
  // Adapter so tests can stub Qdrant. In production, supply
  // (eventId) => qdrant.deleteCollection(collectionName(eventId)).
  dropCollection?: (eventId: string) => Promise<void>;
  // Returns true if another active consent still references the event.
  hasOtherActiveConsents?: (
    db: DbClient,
    eventId: string,
    exceptConsentId: string,
  ) => Promise<boolean>;
  // Counts face_vectors rows scheduled for purge. Counted before drop.
  countVectorsForEvent?: (db: DbClient, eventId: string) => Promise<number>;
  // Deletes face_vectors rows after the collection is dropped.
  deleteVectorsForEvent?: (db: DbClient, eventId: string) => Promise<void>;
}

const defaultHasOtherActiveConsents = async (
  db: DbClient,
  eventId: string,
  exceptConsentId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: consents.id })
    .from(consents)
    .where(
      and(
        eq(consents.scope, 'biometric'),
        eq(consents.eventId, eventId),
        isNull(consents.revokedAt),
        sql`${consents.id} <> ${exceptConsentId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
};

const defaultCountVectorsForEvent = async (db: DbClient, eventId: string): Promise<number> => {
  const { faceVectors } = schema.search.tables;
  const rows = (await db
    .select({ c: sql<number>`count(*)::int` })
    .from(faceVectors)
    .where(eq(faceVectors.eventId, eventId))) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
};

const defaultDeleteVectorsForEvent = async (db: DbClient, eventId: string): Promise<void> => {
  const { faceVectors } = schema.search.tables;
  await db.delete(faceVectors).where(eq(faceVectors.eventId, eventId));
};

export const revokeConsent = async (
  db: DbClient,
  consentId: string,
  context: RevokeContext = {},
  deps: QdrantDeleterDeps = {},
): Promise<RevokeResult> => {
  const rows = await db
    .select()
    .from(consents)
    .where(and(eq(consents.id, consentId), eq(consents.scope, 'biometric')))
    .limit(1);
  const found = rows[0];
  if (!found) throw new ConsentValidationError('not_found', 'consent not found');

  const row = toConsentRow(found as Record<string, unknown>);
  if (row.revokedAt) {
    // Idempotent revoke — same result, no double-purge.
    return { consentId: row.id, vectorsPurged: 0, collectionDropped: false };
  }

  const now = new Date();
  await db
    .update(consents)
    .set({ revokedAt: now, retentionUntil: now })
    .where(eq(consents.id, consentId));

  let vectorsPurged = 0;
  let collectionDropped = false;
  if (row.eventId) {
    const hasOtherFn = deps.hasOtherActiveConsents ?? defaultHasOtherActiveConsents;
    const otherActive = await hasOtherFn(db, row.eventId, consentId);
    if (!otherActive) {
      const countFn = deps.countVectorsForEvent ?? defaultCountVectorsForEvent;
      vectorsPurged = await countFn(db, row.eventId);
      if (deps.dropCollection) {
        try {
          await deps.dropCollection(row.eventId);
          collectionDropped = true;
        } catch (err) {
          // Drop failure should not block consent revocation. Logged via audit.
          await writeAudit(db, {
            action: 'consent.qdrant_drop_failed',
            actorKind: 'system',
            targetKind: 'consent',
            targetId: row.id,
            eventId: row.eventId,
            payload: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
      const deleteFn = deps.deleteVectorsForEvent ?? defaultDeleteVectorsForEvent;
      await deleteFn(db, row.eventId);
    }
  }

  await writeAudit(db, {
    action: 'biometric.consent.revoked',
    actorKind: 'user',
    targetKind: 'consent',
    targetId: row.id,
    eventId: row.eventId ?? undefined,
    ipHash: context.ipHash,
    userAgent: context.userAgent,
    payload: {
      consentId: row.id,
      vectorsPurged,
      collectionDropped,
    },
  });

  return { consentId: row.id, vectorsPurged, collectionDropped };
};

// ---------- F3.7 right-to-erasure cascade ----------
//
// Wraps revokeConsent and additionally deletes search_sessions + search_matches
// belonging to the consent, then emails the subject a confirmation listing
// every artifact removed. search_matches cascade-delete via the FK on
// search_sessions, so we only need to delete the sessions.
//
// The route layer keeps the 204 No Content response (the M1 contract) — the
// work runs synchronously and is complete by the time we reply, so an async
// "202 + tracking id" envelope would be misleading. The cascade scope is
// documented in docs/compliance/walkthrough.md.

export interface CascadeErasureContext extends RevokeContext {
  subjectEmail?: string;
}

export interface CascadeErasureResult extends RevokeResult {
  sessionsDeleted: number;
  matchesDeleted: number;
  emailSent: boolean;
}

export type CascadeMailerFn = typeof defaultSendMail;

export const cascadeErasure = async (
  db: DbClient,
  consentId: string,
  context: CascadeErasureContext = {},
  deps: QdrantDeleterDeps = {},
  mailer: CascadeMailerFn = defaultSendMail,
): Promise<CascadeErasureResult> => {
  // Run the M1 revoke (consent flip + qdrant + face_vectors purge).
  const base = await revokeConsent(db, consentId, context, deps);

  // Delete this consent's search sessions; matches cascade-delete via FK.
  const { searchSessions, searchMatches } = schema.search.tables;
  let matchesDeleted = 0;
  let sessionsDeleted = 0;
  try {
    const sessions = await db
      .select({ id: searchSessions.id })
      .from(searchSessions)
      .where(eq(searchSessions.consentId, consentId));
    sessionsDeleted = sessions.length;
    if (sessions.length > 0) {
      // Some shims (and prod) honor the cascade; do an explicit match delete
      // first so callers without FK enforcement (test shim) still observe the
      // documented contract.
      const ids = sessions.map((s) => s.id);
      await db.delete(searchMatches).where(inArray(searchMatches.sessionId, ids));
      matchesDeleted = ids.length; // count of sessions whose matches were dropped
      await db.delete(searchSessions).where(eq(searchSessions.consentId, consentId));
    }
  } catch (err) {
    await writeAudit(db, {
      action: 'biometric.erasure.sessions_purge_failed',
      actorKind: 'system',
      targetKind: 'consent',
      targetId: consentId,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  let emailSent = false;
  if (context.subjectEmail) {
    try {
      await mailer({
        to: context.subjectEmail,
        subject: 'Your biometric data has been erased',
        text: [
          `Consent id: ${consentId}`,
          `Face vectors purged: ${base.vectorsPurged}`,
          `Qdrant collection dropped: ${base.collectionDropped ? 'yes' : 'no'}`,
          `Search sessions deleted: ${sessionsDeleted}`,
          'You may submit another consent grant at any time to use face search again.',
        ].join('\n'),
        html: `<p>Consent id: <code>${consentId}</code></p>
<ul>
  <li>Face vectors purged: ${base.vectorsPurged}</li>
  <li>Qdrant collection dropped: ${base.collectionDropped ? 'yes' : 'no'}</li>
  <li>Search sessions deleted: ${sessionsDeleted}</li>
</ul>`,
      });
      emailSent = true;
    } catch {
      // best-effort; never block erasure on mailer failure.
    }
  }

  await writeAudit(db, {
    action: 'biometric.erasure.cascade',
    actorKind: 'user',
    targetKind: 'consent',
    targetId: consentId,
    ipHash: context.ipHash,
    payload: {
      vectorsPurged: base.vectorsPurged,
      collectionDropped: base.collectionDropped,
      sessionsDeleted,
      matchesDeleted,
      emailSent,
    },
  });

  return { ...base, sessionsDeleted, matchesDeleted, emailSent };
};

// ---------- Re-exports ----------

export { isVersionSupported };

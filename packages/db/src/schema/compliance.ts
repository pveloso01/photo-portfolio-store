// Compliance context — consents (LGPD / GDPR / BIPA) and audit_log.
// All tables in the Postgres `app` schema.
//
// Compliance schema deliberately has no foreign keys to other contexts:
// audit_log entries must survive the deletion of the entities they reference.
// Cross-references are stored as plain uuid columns; application code resolves
// them when displaying audit history.
//
// audit_log is append-only by convention. A CI policy (later issue) rejects
// any DELETE or UPDATE migration targeting this table.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

// ---------- Enums ----------

export const consentScope = app.enum('consent_scope', [
  'biometric',
  'marketing',
  'terms_of_service',
  'privacy_policy',
]);

export const consentJurisdiction = app.enum('consent_jurisdiction', [
  'eu_gdpr',
  'br_lgpd',
  'us_bipa',
  'us_ccpa',
  'other',
]);

export const auditActorKind = app.enum('audit_actor_kind', [
  'user',
  'system',
  'cron',
  'admin',
  'webhook',
]);

// ---------- consents ----------
// One row per privacy/biometric consent grant. Cross-context columns
// (subjectId -> users.id, eventId -> events.id) are plain uuids without
// references() so deletes in other contexts cannot cascade-purge consent
// history. Application code resolves these when needed.

export const consents = app.table(
  'consents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    scope: consentScope('scope').notNull(),
    // refs users.id (no FK — preserves consent history across user deletion)
    subjectId: uuid('subject_id'),
    // sha256 of lower(email) for anonymous subjects; raw email never stored.
    subjectEmailHash: text('subject_email_hash'),
    // refs events.id (no FK) — biometric consents are per-event.
    eventId: uuid('event_id'),
    grantedAt: timestamp('granted_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    // When the data covered by this consent must be purged. Null = until
    // revoked. Driven by F1.35 retention cron.
    retentionUntil: timestamp('retention_until', {
      withTimezone: true,
      mode: 'date',
    }),
    jurisdiction: consentJurisdiction('jurisdiction').notNull(),
    // Full consent payload: shown text, ip hash, user-agent, locale, version.
    evidenceJsonb: jsonb('evidence_jsonb').notNull(),
    // Policy version the subject agreed to, e.g. '2026-05-18'.
    consentVersion: text('consent_version').notNull(),
    // F1.33 — soft-bind metadata for stolen-consent_id mitigation.
    // sha256(IP); raw IP never stored.
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    // F1.33 — per-consent search quota (max 20 before re-consent required).
    searchesUsed: integer('searches_used').notNull().default(0),
    // F1.33 — TTL for biometric consents (grantedAt + 24h). Null = no expiry
    // (terms_of_service / privacy_policy / marketing scopes).
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One active consent per (subject, scope, event) tuple.
    activeConsentIdx: uniqueIndex('consents_active_subject_scope_event_idx')
      .on(table.subjectId, table.scope, table.eventId)
      .where(sql`${table.revokedAt} is null`),
    // Lookup by hashed email for anonymous subjects.
    emailHashScopeIdx: index('consents_email_hash_scope_idx')
      .on(table.subjectEmailHash, table.scope)
      .where(sql`${table.subjectEmailHash} is not null`),
    // Drives the F1.35 retention purge cron.
    retentionUntilIdx: index('consents_retention_until_idx')
      .on(table.retentionUntil)
      .where(sql`${table.retentionUntil} is not null`),
    // "All biometric consents for this event".
    eventScopeIdx: index('consents_event_scope_idx')
      .on(table.eventId, table.scope)
      .where(sql`${table.eventId} is not null`),
  }),
);

// ---------- audit_log ----------
// Append-only event log. High-volume table — uses bigint identity PK rather
// than uuid to keep index size manageable. Append-only enforcement (DB
// trigger + CI policy) lands in a later issue.

export const auditLog = app.table(
  'audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    // refs users.id (no FK) — null for system actions.
    actorUserId: uuid('actor_user_id'),
    actorKind: auditActorKind('actor_kind').notNull(),
    // Dotted namespace: 'consent.granted', 'biometric.search',
    // 'photo.takedown', 'rbac.denied', 'order.refunded', etc.
    action: text('action').notNull(),
    // e.g. 'event', 'photo', 'face_vector', 'order'.
    targetKind: text('target_kind'),
    // uuid or other id as string for flexibility across target types.
    targetId: text('target_id'),
    // refs events.id (no FK) — denormalized for event-scoped audit queries.
    eventId: uuid('event_id'),
    // sha256 of IP; raw IP never stored.
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    payloadJsonb: jsonb('payload_jsonb'),
    // sha256 of canonical payload — for tamper detection.
    payloadHash: text('payload_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // Primary admin query: recent activity for a given action.
    actionCreatedAtIdx: index('audit_log_action_created_at_idx').on(
      table.action,
      sql`${table.createdAt} desc`,
    ),
    // Event-scoped timeline.
    eventCreatedAtIdx: index('audit_log_event_created_at_idx')
      .on(table.eventId, sql`${table.createdAt} desc`)
      .where(sql`${table.eventId} is not null`),
    // Actor-scoped timeline.
    actorCreatedAtIdx: index('audit_log_actor_created_at_idx')
      .on(table.actorUserId, sql`${table.createdAt} desc`)
      .where(sql`${table.actorUserId} is not null`),
    // "Everything that happened to this photo / event / order".
    targetIdx: index('audit_log_target_idx').on(table.targetKind, table.targetId),
  }),
);

// ---------- consent_policy_versions ----------
// F1.33 — allow-list of biometric-consent policy texts. Server rejects any
// grant carrying an unknown (version, locale) tuple. Seeded at boot from
// apps/api src/lib/policy-versions.ts.

export const consentPolicyVersions = app.table(
  'consent_policy_versions',
  {
    version: text('version').notNull(),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.version, table.locale] }),
  }),
);

// ---------- audit_exports ----------
// F3.11 — async audit-log CSV export jobs. file_key points at the R2 object
// once the export is ready. requestedBy refs users.id (cross-context, no FK).

export const auditExportStatus = app.enum('audit_export_status', [
  'pending',
  'running',
  'ready',
  'failed',
]);

export const auditExports = app.table(
  'audit_exports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    requestedBy: uuid('requested_by').notNull(),
    filters: jsonb('filters').notNull().default(sql`'{}'::jsonb`),
    status: auditExportStatus('status').notNull().default('pending'),
    rowCount: integer('row_count'),
    fileKey: text('file_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    requestedByIdx: index('audit_exports_requested_by_idx').on(table.requestedBy, table.createdAt),
  }),
);

// ---------- Grouped export ----------

export const tables = {
  consents,
  auditLog,
  consentPolicyVersions,
  auditExports,
};

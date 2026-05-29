// F3.6 — right-to-know / data-subject access for biometric data.
//
// Ephemeral face model: we do NOT persist user-side selfies or
// user-level face embeddings. The only biometric data we hold for a subject
// is their consent records and the records of searches THEY initiated under
// those consents (search_sessions + search_matches).
//
// LGPD Art. 18 (II/IV) and GDPR Art. 15 require us to disclose:
//   - what categories of personal data we hold
//   - the legal basis for each
//   - the retention period
//   - the data subject's rights
// We satisfy that with a `legalNotice` block + the disclosure document below.

import { createHash } from 'node:crypto';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { eq, inArray, or } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';

const { consents } = schema.compliance.tables;
const { searchSessions, searchMatches } = schema.search.tables;

export interface BiometricDataView {
  legalNotice: {
    citations: string[];
    summary: string;
  };
  consents: Array<{
    id: string;
    scope: string;
    jurisdiction: string;
    region: string | null;
    grantedAt: string;
    revokedAt: string | null;
    expiresAt: string | null;
    retentionUntil: string | null;
    retentionWindowEndsAt: string | null;
    eventId: string | null;
  }>;
  enrolledSelfies: never[];
  faceEmbeddings: {
    count: number;
    note: string;
  };
  searches: Array<{
    sessionId: string;
    eventId: string;
    consentId: string;
    searchKind: string;
    matchesCount: number;
    createdAt: string;
  }>;
  matches: Array<{
    sessionId: string;
    photoId: string;
    score: string;
    source: string;
    rank: number;
  }>;
}

const LEGAL_NOTICE = {
  citations: [
    'LGPD Art. 18 (II) and (IV) — Brazilian data protection right of access',
    'GDPR Art. 15 — European right of access by the data subject',
    'BIPA Section 15(a) — Illinois Biometric Information Privacy Act',
  ],
  summary:
    'This response lists every category of biometric and biometric-derived data held by the platform for you. Embeddings themselves are derived data — they are computed at search time from photos you appear in and are not persisted under your account.',
};

const emailHash = (email: string): string =>
  createHash('sha256').update(email.toLowerCase(), 'utf8').digest('hex');

export const getMyBiometricData = async (
  db: DbClient,
  subject: { userId: string; email?: string },
  ctx: { ipHash?: string },
): Promise<BiometricDataView> => {
  // Match by subject_id OR by hashed email (anonymous-grant case where the
  // subject later authenticated with the same address).
  const idFilters = [eq(consents.subjectId, subject.userId)];
  if (subject.email) {
    idFilters.push(eq(consents.subjectEmailHash, emailHash(subject.email)));
  }
  const consentRows = await db
    .select({
      id: consents.id,
      scope: consents.scope,
      jurisdiction: consents.jurisdiction,
      region: consents.region,
      grantedAt: consents.grantedAt,
      revokedAt: consents.revokedAt,
      expiresAt: consents.expiresAt,
      retentionUntil: consents.retentionUntil,
      retentionWindowEndsAt: consents.retentionWindowEndsAt,
      eventId: consents.eventId,
    })
    .from(consents)
    .where(or(...idFilters));

  const consentIds = consentRows.map((c) => c.id);
  const sessionRows =
    consentIds.length > 0
      ? await db
          .select({
            id: searchSessions.id,
            eventId: searchSessions.eventId,
            consentId: searchSessions.consentId,
            searchKind: searchSessions.searchKind,
            matchesCount: searchSessions.matchesCount,
            createdAt: searchSessions.createdAt,
          })
          .from(searchSessions)
          .where(inArray(searchSessions.consentId, consentIds))
      : [];

  const sessionIds = sessionRows.map((s) => s.id);
  const matchRows =
    sessionIds.length > 0
      ? await db
          .select({
            sessionId: searchMatches.sessionId,
            photoId: searchMatches.photoId,
            score: searchMatches.score,
            source: searchMatches.source,
            rank: searchMatches.rank,
          })
          .from(searchMatches)
          .where(inArray(searchMatches.sessionId, sessionIds))
      : [];

  await writeAudit(db, {
    action: 'biometric.disclosed',
    actorKind: 'user',
    actorUserId: subject.userId,
    targetKind: 'user',
    targetId: subject.userId,
    ipHash: ctx.ipHash,
    payload: {
      consentCount: consentRows.length,
      sessionCount: sessionRows.length,
      matchCount: matchRows.length,
    },
  });

  return {
    legalNotice: LEGAL_NOTICE,
    consents: consentRows.map((c) => ({
      id: c.id,
      scope: c.scope,
      jurisdiction: c.jurisdiction,
      region: c.region,
      grantedAt: c.grantedAt.toISOString(),
      revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      retentionUntil: c.retentionUntil ? c.retentionUntil.toISOString() : null,
      retentionWindowEndsAt: c.retentionWindowEndsAt ? c.retentionWindowEndsAt.toISOString() : null,
      eventId: c.eventId,
    })),
    // Empty under the ephemeral face model — selfie bytes are never persisted.
    enrolledSelfies: [],
    faceEmbeddings: {
      count: 0,
      note: 'No user-level face embeddings are stored. Embeddings are computed transiently from your selfie at search time and discarded.',
    },
    searches: sessionRows.map((s) => ({
      sessionId: s.id,
      eventId: s.eventId,
      consentId: s.consentId,
      searchKind: s.searchKind,
      matchesCount: s.matchesCount,
      createdAt: s.createdAt.toISOString(),
    })),
    matches: matchRows.map((m) => ({
      sessionId: m.sessionId,
      photoId: m.photoId,
      score: String(m.score),
      source: m.source,
      rank: m.rank,
    })),
  };
};

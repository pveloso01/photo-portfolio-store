// Search service — F1.23 bib + name lookup.
//
// Two entry points:
//   - searchByBib({ eventId, bibNumber, ... }) → matches via app.bib_tags
//   - searchByName({ eventId, name, ... })    → fuzzy roster lookup,
//                                                 then delegates to bib match
//
// Every call writes one app.search_sessions row + N app.search_matches rows
// so F5.11 ("did we miss any?") feedback can stitch results back to a
// session. Latency is measured wall-clock (start → end of the function).
//
// Postgres extensions:
//   - pg_trgm + fuzzystrmatch are checked at startup via assertSearchExtensions().
//     If missing we log a warning and the name path falls back to plain ILIKE.

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, asc, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';

import { type CursorPayload, decodeCursor, encodeCursor } from '../lib/cursor.js';

const { bibTags, searchSessions, searchMatches } = schema.search.tables;
const { photos } = schema.photos.tables;
const { eventRosterEntries } = schema.events.tables;

// ---------- Types ----------

export interface SearchByBibInput {
  eventId: string;
  bibNumber: string;
  limit?: number;
  cursor?: string;
  consentId?: string;
  clientIpHash?: string;
  userAgent?: string;
}

export interface SearchByNameInput {
  eventId: string;
  name: string;
  limit?: number;
  cursor?: string;
  consentId?: string;
  clientIpHash?: string;
  userAgent?: string;
}

export interface SearchMatchRow {
  photoId: string;
  score: number;
  rank: number;
}

export interface SearchResult {
  sessionId: string;
  matches: SearchMatchRow[];
  total: number;
  nextCursor: string | null;
  latencyMs: number;
}

// ---------- Constants ----------

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 24;

const clampLimit = (raw: number | undefined): number => {
  if (!raw || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
};

// ---------- Extension detection ----------

// Memoized at module scope — re-checked on each startup but not per-request.
let extensionsAvailable: { pgTrgm: boolean; fuzzystrmatch: boolean } | null = null;

export const assertSearchExtensions = async (
  db: DbClient,
): Promise<{ pgTrgm: boolean; fuzzystrmatch: boolean }> => {
  if (extensionsAvailable) return extensionsAvailable;
  try {
    const rows = (await db.execute(
      sql`select extname from pg_extension where extname in ('pg_trgm', 'fuzzystrmatch')`,
    )) as unknown as Array<{ extname: string }> | { rows: Array<{ extname: string }> };
    // drizzle-orm/postgres-js returns the array directly; some adapters wrap in { rows }.
    const list = Array.isArray(rows) ? rows : rows.rows;
    const names = new Set(list.map((r) => r.extname));
    extensionsAvailable = {
      pgTrgm: names.has('pg_trgm'),
      fuzzystrmatch: names.has('fuzzystrmatch'),
    };
    if (!extensionsAvailable.pgTrgm || !extensionsAvailable.fuzzystrmatch) {
      // eslint-disable-next-line no-console
      console.warn(
        '[search] pg_trgm/fuzzystrmatch not installed — name search will fall back to ILIKE.',
      );
    }
    return extensionsAvailable;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[search] extension probe failed; assuming none installed', err);
    extensionsAvailable = { pgTrgm: false, fuzzystrmatch: false };
    return extensionsAvailable;
  }
};

// Test-only hook: forcibly reset memoization (used by tests across describe blocks).
export const __resetExtensionCacheForTests = (): void => {
  extensionsAvailable = null;
};

// ---------- Helpers ----------

// Build a placeholder consent id for non-biometric searches. Bib/name don't
// require biometric consent (F1.33 only governs face), but search_sessions
// has consent_id NOT NULL. We use the event id as a stable sentinel; no FK
// is enforced cross-context.
const resolveConsentId = (input: { eventId: string; consentId?: string }): string =>
  input.consentId ?? input.eventId;

// Cursor for bib results uses (confidence desc, photoId desc). Stash
// confidence as ISO-string-friendly via createdAt slot of CursorPayload.
const encodeBibCursor = (score: number, photoId: string): string =>
  encodeCursor({
    id: photoId,
    // Reuse the createdAt slot to carry the score; a Date with epoch=score*1e6
    // is invertible and respects the existing cursor envelope.
    createdAt: new Date(score * 1_000_000),
  });

const decodeBibCursor = (raw: string | undefined): { score: number; photoId: string } | null => {
  const cursor: CursorPayload | null = decodeCursor(raw);
  if (!cursor) return null;
  return { score: cursor.createdAt.getTime() / 1_000_000, photoId: cursor.id };
};

// ---------- Internal: write session + matches ----------

const writeSearchSession = async (
  db: DbClient,
  args: {
    eventId: string;
    consentId: string;
    kind: 'bib' | 'name';
    queryText: string;
    matchesCount: number;
    latencyMs: number;
    clientIpHash?: string;
    userAgent?: string;
  },
): Promise<string> => {
  const inserted = await db
    .insert(searchSessions)
    .values({
      eventId: args.eventId,
      consentId: args.consentId,
      searchKind: args.kind,
      queryText: args.queryText,
      matchesCount: args.matchesCount,
      latencyMs: args.latencyMs,
      clientIpHash: args.clientIpHash ?? null,
      userAgent: args.userAgent ?? null,
    })
    .returning({ id: searchSessions.id });
  const row = inserted[0];
  if (!row) throw new Error('search_sessions insert returned no row');
  return row.id;
};

const writeSearchMatches = async (
  db: DbClient,
  sessionId: string,
  matches: SearchMatchRow[],
  source: 'bib' | 'name',
): Promise<void> => {
  if (matches.length === 0) return;
  await db.insert(searchMatches).values(
    matches.map((m) => ({
      sessionId,
      photoId: m.photoId,
      score: m.score.toFixed(4),
      source,
      rank: m.rank,
    })),
  );
};

// ---------- Core: bib lookup against bib_tags ----------

// Returns matching photo rows in (confidence desc, photoId desc) order,
// keyset-paginated. Filters to status='ready' AND hidden=false. Does NOT
// write the session — caller composes the session metadata.
const queryBibMatches = async (
  db: DbClient,
  args: {
    eventId: string;
    bibNumber: string;
    limit: number;
    cursor: { score: number; photoId: string } | null;
  },
): Promise<SearchMatchRow[]> => {
  const filters = [
    eq(bibTags.eventId, args.eventId),
    sql`lower(${bibTags.bibNumber}) = lower(${args.bibNumber})`,
    eq(photos.status, 'ready'),
    eq(photos.hidden, false),
  ];

  if (args.cursor) {
    const scoreStr = args.cursor.score.toFixed(4);
    const cursorCondition = or(
      lt(bibTags.confidence, scoreStr),
      and(eq(bibTags.confidence, scoreStr), lt(bibTags.photoId, args.cursor.photoId)),
    );
    if (cursorCondition) filters.push(cursorCondition);
  }

  const rows = await db
    .select({
      photoId: bibTags.photoId,
      confidence: bibTags.confidence,
    })
    .from(bibTags)
    .innerJoin(photos, eq(photos.id, bibTags.photoId))
    .where(and(...filters))
    .orderBy(desc(bibTags.confidence), desc(bibTags.photoId))
    .limit(args.limit + 1);

  return rows.map((row, idx) => ({
    photoId: row.photoId,
    score: Number(row.confidence),
    rank: idx + 1,
  }));
};

// ---------- searchByBib ----------

export const searchByBib = async (db: DbClient, input: SearchByBibInput): Promise<SearchResult> => {
  const start = Date.now();
  const limit = clampLimit(input.limit);
  const cursor = decodeBibCursor(input.cursor);

  const found = await queryBibMatches(db, {
    eventId: input.eventId,
    bibNumber: input.bibNumber,
    limit,
    cursor,
  });

  const hasMore = found.length > limit;
  const trimmed = hasMore ? found.slice(0, limit) : found;
  const last = trimmed[trimmed.length - 1];
  const nextCursor = hasMore && last ? encodeBibCursor(last.score, last.photoId) : null;

  const latencyMs = Date.now() - start;
  const consentId = resolveConsentId(input);

  const sessionId = await writeSearchSession(db, {
    eventId: input.eventId,
    consentId,
    kind: 'bib',
    queryText: input.bibNumber,
    matchesCount: trimmed.length,
    latencyMs,
    clientIpHash: input.clientIpHash,
    userAgent: input.userAgent,
  });

  await writeSearchMatches(db, sessionId, trimmed, 'bib');

  return {
    sessionId,
    matches: trimmed,
    total: trimmed.length,
    nextCursor,
    latencyMs,
  };
};

// ---------- searchByName ----------

// Find candidate roster bibs by fuzzy name match.
// Returns deduped bib strings ranked by similarity desc.
const findRosterBibs = async (db: DbClient, eventId: string, name: string): Promise<string[]> => {
  const ext = await assertSearchExtensions(db);

  if (ext.pgTrgm) {
    // pg_trgm similarity — order by similarity desc, top 50.
    const rows = (await db.execute(sql`
      select bib, similarity(lower(coalesce(name, '')), lower(${name})) as sim
      from app.event_roster_entries
      where event_id = ${eventId}::uuid
        and name is not null
        and similarity(lower(name), lower(${name})) > 0.2
      order by sim desc
      limit 50
    `)) as unknown as
      | Array<{ bib: string; sim: number }>
      | { rows: Array<{ bib: string; sim: number }> };
    const list = Array.isArray(rows) ? rows : rows.rows;
    return Array.from(new Set(list.map((r) => r.bib)));
  }

  // Fallback: ILIKE substring.
  const rows = await db
    .select({ bib: eventRosterEntries.bib })
    .from(eventRosterEntries)
    .where(
      and(eq(eventRosterEntries.eventId, eventId), ilike(eventRosterEntries.name, `%${name}%`)),
    )
    .orderBy(asc(eventRosterEntries.bib))
    .limit(50);
  return Array.from(new Set(rows.map((r) => r.bib)));
};

export const searchByName = async (
  db: DbClient,
  input: SearchByNameInput,
): Promise<SearchResult> => {
  const start = Date.now();
  const limit = clampLimit(input.limit);
  const cursor = decodeBibCursor(input.cursor);
  const consentId = resolveConsentId(input);

  const bibs = await findRosterBibs(db, input.eventId, input.name);

  // For each roster bib, pull matching photos. We merge all results then
  // re-sort by confidence desc. Limit each per-bib query to keep latency
  // bounded; total result set is capped at `limit + 1`.
  const aggregated: SearchMatchRow[] = [];
  for (const bib of bibs) {
    const bibMatches = await queryBibMatches(db, {
      eventId: input.eventId,
      bibNumber: bib,
      limit: limit + 1,
      cursor,
    });
    aggregated.push(...bibMatches);
  }

  // Dedup by photoId, keep highest score.
  const dedup = new Map<string, number>();
  for (const m of aggregated) {
    const prev = dedup.get(m.photoId);
    if (prev === undefined || m.score > prev) {
      dedup.set(m.photoId, m.score);
    }
  }
  const merged = Array.from(dedup.entries())
    .map(([photoId, score]) => ({ photoId, score, rank: 0 }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.photoId < b.photoId ? 1 : -1;
    });

  const hasMore = merged.length > limit;
  const trimmed = hasMore ? merged.slice(0, limit) : merged;
  trimmed.forEach((m, i) => {
    m.rank = i + 1;
  });

  const last = trimmed[trimmed.length - 1];
  const nextCursor = hasMore && last ? encodeBibCursor(last.score, last.photoId) : null;

  const latencyMs = Date.now() - start;

  const sessionId = await writeSearchSession(db, {
    eventId: input.eventId,
    consentId,
    kind: 'name',
    queryText: input.name,
    matchesCount: trimmed.length,
    latencyMs,
    clientIpHash: input.clientIpHash,
    userAgent: input.userAgent,
  });

  await writeSearchMatches(db, sessionId, trimmed, 'name');

  return {
    sessionId,
    matches: trimmed,
    total: trimmed.length,
    nextCursor,
    latencyMs,
  };
};

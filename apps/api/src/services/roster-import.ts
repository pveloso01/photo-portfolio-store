// F4.5 — roster import service.
//
// Two-phase, idempotent:
//   preview(eventId, filename, csv) -> parses + validates, persists a
//     `previewed` roster_imports row holding the valid rows + issues, returns a
//     summary (first 20 rows + counts + issues).
//   commit(eventId, importId)       -> inserts the previewed valid rows into
//     participants (onConflictDoNothing on (event_id, bib)), marks the import
//     `imported`, returns the final report. Re-running skips existing bibs.

import { type DbClient, schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';

import {
  type ParsedParticipant,
  type RosterIssue,
  type RosterParseResult,
  parseRosterCsv,
} from '../lib/roster-csv.js';

const { participants, rosterImports } = schema.participants;

const PREVIEW_SAMPLE_SIZE = 20;

export class RosterImportError extends Error {
  constructor(
    public readonly code: 'not_found' | 'already_imported',
    message: string,
  ) {
    super(message);
    this.name = 'RosterImportError';
  }
}

export interface RosterPreview {
  importId: string;
  columns: string[];
  totalRows: number;
  validRows: number;
  skippedRows: number;
  sample: ParsedParticipant[];
  issues: RosterIssue[];
}

interface StoredReport {
  columns: string[];
  validRows: ParsedParticipant[];
  issues: RosterIssue[];
}

export const previewRoster = async (
  db: DbClient,
  eventId: string,
  filename: string,
  csv: string,
): Promise<RosterPreview> => {
  const parsed: RosterParseResult = parseRosterCsv(csv);
  const report: StoredReport = {
    columns: parsed.columns,
    validRows: parsed.validRows,
    issues: parsed.issues,
  };

  const inserted = await db
    .insert(rosterImports)
    .values({
      eventId,
      filename,
      totalRows: parsed.totalRows,
      importedRows: 0,
      skippedRows: parsed.issues.length,
      status: 'previewed',
      reportJson: report,
    })
    .returning({ id: rosterImports.id });
  const row = inserted[0];
  if (!row) throw new Error('roster_imports insert returned no row');

  return {
    importId: row.id,
    columns: parsed.columns,
    totalRows: parsed.totalRows,
    validRows: parsed.validRows.length,
    skippedRows: parsed.issues.length,
    sample: parsed.validRows.slice(0, PREVIEW_SAMPLE_SIZE),
    issues: parsed.issues,
  };
};

export interface RosterImportReport {
  importId: string;
  status: 'imported';
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  issues: RosterIssue[];
}

export const commitRoster = async (
  db: DbClient,
  eventId: string,
  importId: string,
): Promise<RosterImportReport> => {
  const rows = await db
    .select({
      id: rosterImports.id,
      eventId: rosterImports.eventId,
      status: rosterImports.status,
      totalRows: rosterImports.totalRows,
      reportJson: rosterImports.reportJson,
    })
    .from(rosterImports)
    .where(and(eq(rosterImports.id, importId), eq(rosterImports.eventId, eventId)))
    .limit(1);
  const imp = rows[0];
  if (!imp) throw new RosterImportError('not_found', 'roster import not found');
  if (imp.status === 'imported') {
    throw new RosterImportError('already_imported', 'roster import already committed');
  }

  const report = (imp.reportJson as StoredReport | null) ?? {
    columns: [],
    validRows: [],
    issues: [],
  };
  let importedRows = 0;
  for (const p of report.validRows) {
    const result = await db
      .insert(participants)
      .values({
        eventId,
        bib: p.bib,
        name: p.name,
        email: p.email,
        phone: p.phone,
        team: p.team,
      })
      .onConflictDoNothing({ target: [participants.eventId, participants.bib] })
      .returning({ id: participants.id });
    if (result.length > 0) importedRows += 1;
  }

  const skippedRows = imp.totalRows - importedRows;
  await db
    .update(rosterImports)
    .set({ status: 'imported', importedRows, skippedRows })
    .where(eq(rosterImports.id, importId));

  return {
    importId,
    status: 'imported',
    totalRows: imp.totalRows,
    importedRows,
    skippedRows,
    issues: report.issues,
  };
};

export interface RosterImportRecord {
  importId: string;
  filename: string;
  status: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  issues: RosterIssue[];
  createdAt: string;
}

export const getRosterImport = async (
  db: DbClient,
  eventId: string,
  importId: string,
): Promise<RosterImportRecord | null> => {
  const rows = await db
    .select({
      id: rosterImports.id,
      filename: rosterImports.filename,
      status: rosterImports.status,
      totalRows: rosterImports.totalRows,
      importedRows: rosterImports.importedRows,
      skippedRows: rosterImports.skippedRows,
      reportJson: rosterImports.reportJson,
      createdAt: rosterImports.createdAt,
    })
    .from(rosterImports)
    .where(and(eq(rosterImports.id, importId), eq(rosterImports.eventId, eventId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const report = (row.reportJson as StoredReport | null) ?? null;
  return {
    importId: row.id,
    filename: row.filename,
    status: row.status,
    totalRows: row.totalRows,
    importedRows: row.importedRows,
    skippedRows: row.skippedRows,
    issues: report?.issues ?? [],
    createdAt: row.createdAt.toISOString(),
  };
};

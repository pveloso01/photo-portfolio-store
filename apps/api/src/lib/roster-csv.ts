// F4.5 — roster CSV parsing (pure; no DB).
//
// Handles UTF-8 with BOM, CRLF/LF line endings, quoted fields containing commas
// and escaped double-quotes (RFC 4180), and blank rows. Maps columns by header
// name (case-insensitive): bib, name, email are required columns; phone, team
// optional. Per-row validation flags invalid email and in-file duplicate bib;
// invalid rows are reported, never throw.

export const REQUIRED_COLUMNS = ['bib', 'name', 'email'] as const;
export const OPTIONAL_COLUMNS = ['phone', 'team'] as const;
export const MAX_ROWS = 100_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedParticipant {
  rowNumber: number;
  bib: string;
  name: string;
  email: string | null;
  phone: string | null;
  team: string | null;
}

export interface RosterIssue {
  rowNumber: number;
  reason: 'invalid_email' | 'duplicate_bib' | 'missing_bib' | 'missing_name';
  detail: string;
}

export interface RosterParseResult {
  columns: string[];
  totalRows: number; // data rows seen (excludes header + blank lines)
  validRows: ParsedParticipant[];
  issues: RosterIssue[];
}

export class RosterParseError extends Error {
  constructor(
    public readonly code: 'empty' | 'missing_columns' | 'too_many_rows',
    message: string,
  ) {
    super(message);
    this.name = 'RosterParseError';
  }
}

// Tokenize one CSV record honoring quotes. Returns the field list.
const splitRecord = (line: string): string[] => {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
};

// Split raw text into records, joining lines that are inside an open quote.
const toRecords = (text: string): string[] => {
  // Strip BOM, normalize CRLF/CR to LF.
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const records: string[] = [];
  let buf = '';
  let quoteCount = 0;
  for (const line of normalized.split('\n')) {
    buf = buf === '' ? line : `${buf}\n${line}`;
    quoteCount += (line.match(/"/g) ?? []).length;
    // An even number of quotes means the record is complete.
    if (quoteCount % 2 === 0) {
      records.push(buf);
      buf = '';
      quoteCount = 0;
    }
  }
  if (buf !== '') records.push(buf);
  return records;
};

const blank = (s: string): boolean => s.trim() === '';

export const parseRosterCsv = (text: string): RosterParseResult => {
  const records = toRecords(text).filter((r) => !blank(r));
  if (records.length === 0) {
    throw new RosterParseError('empty', 'CSV is empty');
  }

  const header = splitRecord(records[0] as string).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new RosterParseError(
      'missing_columns',
      `missing required columns: ${missing.join(', ')}`,
    );
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_ROWS) {
    throw new RosterParseError('too_many_rows', `roster exceeds ${MAX_ROWS} rows`);
  }

  const col = (fields: string[], name: string): string => {
    const idx = header.indexOf(name);
    return idx >= 0 ? (fields[idx] ?? '').trim() : '';
  };

  const validRows: ParsedParticipant[] = [];
  const issues: RosterIssue[] = [];
  const seenBibs = new Set<string>();

  dataRecords.forEach((record, i) => {
    const rowNumber = i + 2; // 1-based, +1 for header
    const fields = splitRecord(record);
    const bib = col(fields, 'bib');
    const name = col(fields, 'name');
    const rawEmail = col(fields, 'email');
    const email = rawEmail === '' ? null : rawEmail.toLowerCase();
    const phone = col(fields, 'phone') || null;
    const team = col(fields, 'team') || null;

    if (bib === '') {
      issues.push({ rowNumber, reason: 'missing_bib', detail: 'bib is required' });
      return;
    }
    if (name === '') {
      issues.push({ rowNumber, reason: 'missing_name', detail: 'name is required' });
      return;
    }
    if (email !== null && !EMAIL_RE.test(email)) {
      issues.push({ rowNumber, reason: 'invalid_email', detail: `invalid email: ${rawEmail}` });
      return;
    }
    if (seenBibs.has(bib)) {
      issues.push({ rowNumber, reason: 'duplicate_bib', detail: `duplicate bib in file: ${bib}` });
      return;
    }
    seenBibs.add(bib);
    validRows.push({ rowNumber, bib, name, email, phone, team });
  });

  return { columns: header, totalRows: dataRecords.length, validRows, issues };
};

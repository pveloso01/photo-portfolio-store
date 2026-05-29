// F4.5 — roster CSV parser unit tests (pure, no DB).

import { describe, expect, it } from 'vitest';

import { RosterParseError, parseRosterCsv } from '../src/lib/roster-csv.js';

describe('parseRosterCsv', () => {
  it('parses a simple roster', () => {
    const r = parseRosterCsv('bib,name,email\n101,Ada Lovelace,ada@example.com');
    expect(r.totalRows).toBe(1);
    expect(r.validRows).toHaveLength(1);
    expect(r.validRows[0]).toMatchObject({
      bib: '101',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(r.issues).toHaveLength(0);
  });

  it('strips a UTF-8 BOM and handles CRLF line endings', () => {
    const r = parseRosterCsv('﻿bib,name,email\r\n7,Bob,bob@x.io\r\n');
    expect(r.validRows).toHaveLength(1);
    expect(r.validRows[0]?.bib).toBe('7');
  });

  it('preserves leading zeros and alphanumeric bibs (bib is a string)', () => {
    const r = parseRosterCsv('bib,name,email\n007,Jane,j@x.io\nA12,Kai,k@x.io');
    expect(r.validRows.map((p) => p.bib)).toEqual(['007', 'A12']);
  });

  it('handles quoted fields containing commas and escaped quotes', () => {
    const r = parseRosterCsv('bib,name,email\n1,"Doe, John ""JD""",jd@x.io');
    expect(r.validRows[0]?.name).toBe('Doe, John "JD"');
  });

  it('normalizes email to lowercase and trims whitespace', () => {
    const r = parseRosterCsv('bib,name,email\n1, Sam , SAM@Example.COM ');
    expect(r.validRows[0]?.name).toBe('Sam');
    expect(r.validRows[0]?.email).toBe('sam@example.com');
  });

  it('maps columns by header regardless of order and supports optional phone/team', () => {
    const r = parseRosterCsv('name,team,bib,email,phone\nLee,Hawks,9,lee@x.io,555-1234');
    expect(r.validRows[0]).toMatchObject({ bib: '9', team: 'Hawks', phone: '555-1234' });
  });

  it('skips blank rows without erroring', () => {
    const r = parseRosterCsv('bib,name,email\n1,A,a@x.io\n\n   \n2,B,b@x.io');
    expect(r.validRows).toHaveLength(2);
  });

  it('flags an invalid email and continues with the rest', () => {
    const r = parseRosterCsv('bib,name,email\n1,A,not-an-email\n2,B,b@x.io');
    expect(r.validRows).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ reason: 'invalid_email', rowNumber: 2 });
  });

  it('flags an in-file duplicate bib', () => {
    const r = parseRosterCsv('bib,name,email\n5,A,a@x.io\n5,B,b@x.io');
    expect(r.validRows).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ reason: 'duplicate_bib' });
  });

  it('allows a missing email (optional contact)', () => {
    const r = parseRosterCsv('bib,name,email\n1,A,');
    expect(r.validRows[0]?.email).toBeNull();
    expect(r.issues).toHaveLength(0);
  });

  it('flags rows missing a required bib or name', () => {
    const r = parseRosterCsv('bib,name,email\n,A,a@x.io\n2,,b@x.io');
    expect(r.issues.map((i) => i.reason)).toEqual(['missing_bib', 'missing_name']);
  });

  it('throws on empty input', () => {
    expect(() => parseRosterCsv('')).toThrow(RosterParseError);
  });

  it('throws when required columns are missing', () => {
    expect(() => parseRosterCsv('bib,name\n1,A')).toThrowError(/missing required columns: email/);
  });
});

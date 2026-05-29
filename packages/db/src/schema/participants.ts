// Participants context — event roster entrants (F4.5) + roster import audit.
// All tables in the Postgres `app` schema.
//
// A participant is a person registered for an event (bib + name + contact),
// sourced from a CSV roster import (F4.5) or a timing provider (F4.6+). Bib is
// stored as text to preserve leading zeros and alphanumeric bibs. Email is
// stored normalized (lowercase, trimmed) by the import layer.

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const app = pgSchema('app');

export const rosterImportStatus = app.enum('roster_import_status', [
  'previewed',
  'imported',
  'failed',
]);

export const participants = app.table(
  'participants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    // refs events.id — cross-context, no FK.
    eventId: uuid('event_id').notNull(),
    bib: text('bib').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    team: text('team'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    // One participant per (event, bib).
    eventBibIdx: uniqueIndex('participants_event_bib_idx').on(table.eventId, table.bib),
    // Lookup by email within an event (notification targeting, F4.12).
    eventEmailIdx: index('participants_event_email_idx').on(table.eventId, table.email),
  }),
);

export const rosterImports = app.table(
  'roster_imports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    eventId: uuid('event_id').notNull(),
    filename: text('filename').notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    skippedRows: integer('skipped_rows').notNull().default(0),
    status: rosterImportStatus('status').notNull().default('previewed'),
    // Parsed preview: { columns, issues, validRows } at preview time; updated
    // with the final report at commit time.
    reportJson: jsonb('report_json'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    eventIdx: index('roster_imports_event_idx').on(table.eventId, table.createdAt),
  }),
);

export const tables = {
  participants,
  rosterImports,
};

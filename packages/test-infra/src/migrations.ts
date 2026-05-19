// Apply the repo's drizzle migrations against a live Postgres URL. The
// migrations folder is resolved relative to the @pkg/db package so callers
// don't need to know where it lives.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// __dirname equivalent inside ESM. The compiled file sits at
// packages/test-infra/dist/migrations.js; migrations live at
// packages/db/migrations relative to the monorepo root.
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(here, '..', '..', 'db', 'migrations');

export const applyMigrations = async (databaseUrl: string): Promise<void> => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
};

export const migrationsFolder = MIGRATIONS_FOLDER;

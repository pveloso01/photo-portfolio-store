// Convention: every up migration MUST have a paired down file at
// ./migrations/down/<same-name>.sql. Enforced by CI in F0.4 follow-up.
//
// Drizzle does not ship a native rollback. This script applies the latest
// down SQL file and removes the corresponding row from
// drizzle.__drizzle_migrations so the next `db:migrate` is a clean forward.
import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const downDir = resolve('./migrations/down');

const applied = await sql<{ hash: string; created_at: string }[]>`
  select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
`;

const head = applied[0];
if (!head) {
  console.log('no migrations to roll back');
  await sql.end();
  process.exit(0);
}

const files = (await readdir(downDir)).sort();
const last = files.at(-1);
if (!last) {
  console.error('no down migration files');
  await sql.end();
  process.exit(1);
}

const ddl = await readFile(resolve(downDir, last), 'utf8');
await sql.unsafe(ddl);
await sql`delete from drizzle.__drizzle_migrations where hash = ${head.hash}`;
await sql.end();
console.log(`rolled back: ${last}`);

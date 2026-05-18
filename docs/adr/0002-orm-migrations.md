# 2. ORM and migrations

Date: 2026-05-18

## Status

Accepted

## Context

The project needs a database access layer and a migration tool. Requirements:

- TypeScript-first with strong inference at query boundaries
- SQL-transparent so hot paths can drop to raw SQL without leaving the type system
- Fast cold-start (serverless and CI friendly), no runtime client generation
- No shadow-database requirement for generating migrations
- Direct compatibility with future per-event Qdrant and pgvector usage
- Forward and rollback migrations checked in as files, never applied implicitly at runtime

## Decision

Use **Drizzle ORM** with **`drizzle-kit`** for migration generation. The Postgres driver is **`postgres`** (postgres-js). Raw SQL is allowed via Drizzle's `` sql`...` `` template tag for hot paths and for any query that the type-safe builder makes awkward.

Schema lives in `packages/db/src/schema/`. Generated SQL migrations land in `packages/db/migrations/` and are committed. A paired `packages/db/migrations/down/<same-name>.sql` is required for every forward migration.

### Alternatives considered

- **Prisma** — rejected: slower cold-start, runtime client generation step, requires a shadow database for migrations, hides SQL behind its own DSL
- **Kysely** — rejected: excellent query builder but ships no migration tooling, would require pairing with a second tool
- **TypeORM** — rejected: decorator-heavy, weaker type-safety at query boundaries, active-record patterns we don't want
- **Raw SQL + node-postgres** — rejected: forfeits type inference at the boundary, every query would need hand-written types
- **knex.js** — rejected: TypeScript types are thin beyond the basics, query results are loosely typed

## Consequences

- Developers write schema in TypeScript; `drizzle-kit generate` produces SQL that is reviewed and committed
- Migrations are never auto-applied at runtime — `pnpm --filter @pkg/db db:migrate` is an explicit step in deploy
- Every forward migration must ship with a paired down file; CI will enforce this in a follow-up to F0.4
- pgvector and other Postgres extensions remain reachable via raw SQL in migrations
- Switching ORMs later costs a new ADR plus a schema rewrite — accepted tradeoff

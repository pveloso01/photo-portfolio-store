# @pkg/db

Database access layer. Drizzle ORM + `drizzle-kit` over postgres-js. See
[`docs/adr/0002-orm-migrations.md`](../../docs/adr/0002-orm-migrations.md) for
the rationale.

## Layout

```
packages/db/
  drizzle.config.ts        # drizzle-kit configuration
  migrations/              # generated forward SQL (committed)
    down/                  # paired rollback SQL (one per forward, same name)
  src/
    client.ts              # createDbClient + DbClient type
    migrate.ts             # forward migration runner
    rollback.ts            # rollback runner (applies latest down/*.sql)
    schema/index.ts        # drizzle-kit entry point for schemas
    index.ts               # package public surface
```

## Workflow

1. Edit `src/schema/` to add or change tables.
2. Generate the migration:
   ```bash
   pnpm --filter @pkg/db db:generate
   ```
3. Hand-write the paired rollback at `migrations/down/<same-name>.sql`.
   Every forward migration MUST ship with a paired down file. CI will enforce
   this in a follow-up to F0.4.
4. Apply locally:
   ```bash
   pnpm --filter @pkg/db db:migrate
   ```
5. Roll back one step:
   ```bash
   pnpm --filter @pkg/db db:rollback
   ```
6. Inspect with Drizzle Studio:
   ```bash
   pnpm --filter @pkg/db db:studio
   ```

`DATABASE_URL` must be set in the environment (`.env.local` is loaded by the
migration scripts via `dotenv/config`).

## Usage

```ts
import { createDbClient, type DbClient } from '@pkg/db';

const db: DbClient = createDbClient(process.env.DATABASE_URL!);
```

Migrations are never applied implicitly at runtime — `db:migrate` is an
explicit deploy step.

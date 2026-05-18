# @pkg/api-types

TypeScript types for the photo-portfolio-store HTTP API.

## Source of truth

The OpenAPI spec at the repository root (`/openapi.yaml`) is the single source of truth. All types in `src/generated.ts` are produced from it by [openapi-typescript](https://github.com/openapi-ts/openapi-typescript).

## Regenerate types

After editing `/openapi.yaml`, regenerate the committed types:

```bash
pnpm --filter @pkg/api-types codegen
```

Commit both the spec and the regenerated `src/generated.ts` together.

## CI drift check

CI runs a cross-platform drift check that regenerates types into a temp directory and compares them to the committed file:

```bash
pnpm --filter @pkg/api-types codegen:check
```

The check fails when the committed `src/generated.ts` does not match what the current spec would produce.

## Consumers

- `@app/api` — request and response types for the HTTP server.
- Future client SDKs (web app, admin app, native clients).

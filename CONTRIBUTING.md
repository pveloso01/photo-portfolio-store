# Contributing

## Welcome

Thanks for contributing to `photo-portfolio-store`. This repository powers a photo portfolio and storefront with face-search and licensing capabilities. We optimize for small, well-reviewed changes that move through CI cleanly. Read this guide before opening your first PR — it codifies the workflow, quality bar, and review etiquette every change is held to.

## Quick start

> Note: some of these commands depend on tooling that lands during foundation tasks F0.2 (monorepo) and F0.3 (local dev stack). Until those merge, only steps 1 and 2 apply.

1. Clone the repo: `git clone https://github.com/pveloso01/photo-portfolio-store.git`
2. Install Doppler and authenticate (see ADR-0003): `doppler login && doppler setup`
3. Install dependencies: `pnpm install`
4. Start local infrastructure: `docker compose -f docker-compose.dev.yml up -d`
5. Run the dev servers: `pnpm dev`

## Workflow

- Branch off `main`.
- Make small, focused commits using the Conventional Commits format.
- Open a pull request as soon as you have something to discuss — draft PRs are fine.
- Request review from the relevant CODEOWNERS.
- Address feedback by pushing new commits (do not force-push during review).
- When approved and green, squash-merge into `main`.
- Direct pushes to `main` are blocked. All changes land via PR.

## Branch naming

Use `<type>/<short-description>` where `type` is one of: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`.

Example: `feat/face-search-endpoint`.

Keep the description kebab-cased and under ~50 characters.

## Conventional commits

We follow the [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) specification. The commit subject drives changelog generation and release tooling.

Examples from this repo:

- `feat(api): add POST /v1/faces/search endpoint`
- `fix(worker): retry thumbnail job on transient S3 errors`
- `chore(deps): bump prisma to 5.18.0`
- `docs(adr): record ADR-0005 on inference deployment topology`
- `refactor(db): extract photo repository into its own module`

Breaking changes use a `!` and a `BREAKING CHANGE:` footer:

- `feat(api)!: change face-search response envelope`

## Pull request expectations

Every PR must:

- Use a Conventional Commits title (this becomes the squash-merge commit subject).
- Reference the issue it resolves in the body, e.g. `Closes #42`.
- Describe what changed and why.
- Include a test plan (commands run, scenarios covered, screenshots for UI changes).
- Confirm the universal quality gates below.

## Universal quality gates

Every change must satisfy these ten gates from `docs/roadmap.md` before merge:

1. Tests and coverage — new logic has tests; coverage does not regress below the project threshold.
2. Lint and format — `pnpm lint` and `pnpm format:check` pass.
3. Type safety — `pnpm typecheck` passes with no new `any` escapes.
4. OpenAPI — public API changes update the OpenAPI spec and regenerate `@app/api-types`.
5. Migrations — schema changes ship with reviewed, reversible migrations.
6. Security — no new hardcoded secrets, no unpinned untrusted dependencies, security scan clean.
7. Observability — new code paths emit structured logs, metrics, and traces as appropriate.
8. Compliance — PII handling, retention, and licensing rules are upheld; data-flow changes are documented.
9. Docs — README, ADRs, runbooks, and inline docs are updated for the change.
10. Performance — performance-sensitive paths have measured impact (load test, benchmark, or profile).

## Review etiquette

- At least one approving review from a CODEOWNER is required.
- Resolve all open conversations before merging.
- Reviewers use GitHub suggestion blocks for small fixes the author can accept directly.
- Be specific and kind. Critique the code, not the person.
- Authors respond to every comment, even with a brief acknowledgement.

## Risk labels

Two labels require a second reviewer with relevant expertise in addition to the default CODEOWNER:

- `risk:security` — auth, authz, crypto, secrets, input handling, dependency updates with CVE exposure.
- `risk:compliance` — PII, licensing, retention, audit trails, regulated data flows.

Apply the label as soon as the risk is identified, not at the end of review.

## Issue hygiene

- Issues move through `status:ready` to `status:in-progress` when claimed.
- After opening a PR, set `status:needs-review`.
- Issues close automatically when the linked PR merges (`Closes #N`).
- Do not claim an issue you cannot actively work on within the next few days — release it back to `status:ready` instead.

## Local development tips

- Run a single workspace: `pnpm --filter @app/api dev`.
- Run a single test file: `pnpm --filter @app/api test path/to/file.test.ts`.
- Run one test by name: `pnpm --filter @app/api test -t "rejects unauthenticated requests"`.
- Inspect a BullMQ queue: `pnpm --filter @app/worker queue:inspect <queue-name>`.
- Tail dev logs across the stack: `pnpm logs`.

## Running integration tests

The integration suite boots ephemeral Postgres and MinIO containers via
testcontainers and runs the API + worker code against them. It lives in
`*.integration.test.ts` files and is excluded from the default `pnpm test`
run.

Prerequisites:

- Docker daemon running and reachable. On Windows + WSL2 ensure Docker
  Desktop is started before invoking the command.
- The first run pulls `postgres:16-alpine` and `minio/minio:latest`
  (~150MB combined) — subsequent runs reuse the cached images.

**Windows + Git Bash known issue:** testcontainers-node cannot reach
the Docker Desktop named pipe (`//./pipe/dockerDesktopLinuxEngine`)
from Git Bash. Two workarounds:

1. **Use the docker-compose stack** (recommended for local dev):
   ```bash
   docker compose -f docker-compose.dev.yml up -d postgres minio
   INTEGRATION_REUSE_EXTERNAL=1 \
     DATABASE_URL=postgres://photo:photo@localhost:5432/photo \
     pnpm test:integration
   ```
2. **Run from WSL2** — install Node + pnpm inside WSL and run
   `pnpm test:integration` there; the Docker socket is exposed via
   `unix:///var/run/docker.sock` and works natively.

CI (Linux runners) has no such issue and uses the default
testcontainers path.

Commands:

```bash
# Full integration suite (api + worker). ~3 min cold, ~30s warm.
pnpm test:integration

# Optional escape hatch: reuse the docker-compose dev stack instead of
# spinning new testcontainers. Faster inner loop for local development.
INTEGRATION_REUSE_EXTERNAL=1 \
  DATABASE_URL=postgres://photo:photo@localhost:5432/photo \
  pnpm test:integration
```

The unit suite (`pnpm test`) stays mock-based and runs in seconds — keep
fast feedback loops by adding new unit tests there. Reach for the
integration suite when an assertion depends on real SQL semantics (FK
violations, unique constraints, projection across joins) or real
filesystem / S3 observability.

## Getting help

- Master tracker: issue #1.
- Roadmap: `docs/roadmap.md`.
- Architecture decisions: `docs/adr/`.
- Team chat: TODO (link will be added once the channel is established).

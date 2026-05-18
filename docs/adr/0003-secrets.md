# 3. Secrets management

Date: 2026-05-18

## Status

Accepted

## Context

The photo-portfolio-store project spans multiple runtime surfaces (web app, API, background workers, ML inference service) and multiple environments (local dev, CI, staging, production). Each surface needs access to credentials: database URLs, JWT signing keys, S3/R2 access keys, Stripe keys, Resend API keys, OTLP endpoints, and so on.

Without a single source of truth, secret state fragments across `.env` files on developer laptops, GitHub Actions repository secrets, and per-service hosting provider env-var UIs (Vercel, Fly, Railway, etc.). Rotation becomes a manual scavenger hunt; onboarding a new contributor becomes ad-hoc; and accidental commits of `.env` files become a recurring incident.

We need a secrets backend that:

- Is the canonical source of truth across dev, CI, and prod.
- Supports per-environment scoping with read-only service tokens.
- Has a CLI ergonomic enough that developers actually use it instead of bypassing it with local `.env` files.
- Does not couple us to a single cloud provider (we use Cloudflare R2 for object storage and may run compute across providers).
- Is operationally cheap for a pre-PMF team — no Raft cluster to babysit.

## Decision

Use **Doppler** as the secrets manager across dev, CI, and production.

- **Local development:** Developers run services via `doppler run -- <cmd>`, which injects secrets into the process environment at start. A `.env.local` (gitignored) is permitted as an offline fallback only.
- **CI:** GitHub Actions pulls secrets from Doppler via the `doppler-cli` action using a CI-scoped service token stored as a single GitHub Actions repository secret (`DOPPLER_TOKEN_CI`). All other secrets flow from Doppler.
- **Production runtime:** Each service is provisioned with a read-only Doppler service token scoped to its environment (`prod`, `staging`). Services fetch and cache secrets on boot.

The canonical list of environment variables lives in `.env.example` at the repo root. Doppler projects mirror this shape, and `.env.example` is the contract any alternative backend must satisfy if we ever migrate.

### Alternatives considered

- **SOPS + git-encrypted secrets** — viable, but adds rotation friction and key-distribution overhead small teams underestimate.
- **AWS Secrets Manager / Parameter Store** — works only inside AWS; we're R2-on-Cloudflare, so cross-cloud cost and latency added.
- **HashiCorp Vault** — best-in-class, but operational overhead (Raft cluster, unsealing) is overkill before product-market fit.
- **Plain GitHub Actions secrets + Vercel env vars** — splits secret state across two surfaces; rotation becomes manual.
- **1Password CLI** — solid for individual contributors; weaker for service-to-service rotation in CI.

## Consequences

- Single source of truth means one rotation flow for every credential.
- Vendor coupling to Doppler is real — we mitigate by keeping `.env.example` exhaustive and authoritative, so any backend (Vault, SOPS, AWS SM) can be hot-swapped by re-implementing the same variable surface.
- The pre-commit `gitleaks` hook (see F0.5) catches accidental commits of `.env`, `.env.local`, `*.pem`, `*.key`, and other secret-bearing files before they reach `origin`.
- Service tokens are scoped read-only per environment; the Doppler root token never leaves the Doppler UI and is held only by repository owners.
- Developers must install the Doppler CLI as part of onboarding — this is a one-time cost amortized across the project lifetime.

## Operational runbook

### Onboarding a new contributor

1. Install the Doppler CLI: <https://docs.doppler.com/docs/install-cli>.
2. Run `doppler login` and authenticate via browser.
3. From the repo root, run `doppler setup` once and select the `photo-portfolio-store` project and the `dev` config.
4. Run services via `doppler run -- pnpm dev` (or the equivalent per-service command) instead of bare `pnpm dev`.
5. If you need a `.env.local` for offline work, copy `.env.example` and populate values from your password manager.

### Rotation flow

1. Rotate the credential at its source (database password reset, Stripe key regenerate, etc.).
2. Update the value in the Doppler UI for the affected config(s).
3. Re-deploy or restart the affected services — they pull secrets on boot.
4. Revoke the prior credential at its source once the new value is verified in production.

### Break-glass

If Doppler is unavailable during an incident:

1. Recover the relevant secrets from the team password manager.
2. Populate a `.env.local` on the affected host or developer machine.
3. Restart the service with the `.env.local` loaded directly (bypass `doppler run`).
4. Once Doppler is restored, rotate the leaked-by-break-glass credentials and re-deploy through the normal flow.

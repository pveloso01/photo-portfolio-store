# Roadmap

Mirror of the master tracking issue. The GitHub issue (#1) is the source of truth — this file is for offline / repo-local reading.

## Phases

| ID | Phase | Goal | Exit criteria |
|---|---|---|---|
| M0 | Foundation | Repo skeleton, tooling, conventions | CI green; `docker compose up` boots all services; ADRs merged |
| M1 | MVP Backend | End-to-end selfie-search demo with single-photo purchase | Photographer uploads, attendee selfie-searches, buys digital download; biometric consent gated and auditable |
| M2 | Commerce Depth | Real economics | Bundles, foto-flat, refunds, Stripe Connect splits live; ledger reconciles to zero |
| M3 | Operator Features | Run real events safely | Admin moderation, takedown SLA, retention cron, audit export; LGPD/GDPR/BIPA defensible |
| M4 | Integrations | Real-world ingestion + fulfillment | FTP + in-camera FTP working; one race-timing connector + one print lab live; outbound webhooks |
| M5 | Differentiators | Competitive wedge | Real-time delivery, text search, quality auto-reject, smart bundles, LATAM payments |

## Cross-cutting principles

- **Compliance-first.** LGPD / GDPR / BIPA are first-class concerns. Biometric data has retention windows, consent records, and audit trails from day one.
- **Stripe Connect from MVP.** Photographer payouts and multi-party splits are baked in, not bolted on.
- **Per-event isolation.** Face vectors and FTP credentials are scoped per event for clean takedown and security.
- **OpenAPI as contract.** API spec is updated before code; client SDKs are generated.
- **80% test coverage minimum.** Enforced in CI on changed lines.
- **Lightning fast.** Performance is a feature, not an afterthought. Budgets:
  - API: p95 < 200ms for read endpoints, < 500ms for search
  - Ingest derivative: p95 < 30s per photo
  - Selfie search: p95 < 5s end-to-end
  - Frontend (when built): LCP < 2.5s, INP < 200ms, CLS < 0.1

## Universal quality gates (every PR)

1. Tests — unit + integration; >=80% coverage on changed lines
2. Lint + format
3. Type safety — `tsc --noEmit` / `pyright` clean
4. OpenAPI spec updated + validated; client SDK regenerated
5. Migrations — forward + rollback tested
6. Security — secret scan + dependency audit clean
7. Observability — new endpoints emit traces + metrics
8. Compliance — face/PII/biometric changes require `risk:compliance` label + audit log entry
9. Docs — README/ADR/runbook updated when behavior changes
10. Performance budget honored

## Sub-issue inventory

| Phase | Sub-issues |
|---|---|
| M0 — Foundation | 12 |
| M1 — MVP Backend | 38 |
| M2 — Commerce Depth | 13 |
| M3 — Operator Features | 13 |
| M4 — Integrations | 12 |
| M5 — Differentiators | 11 |
| **Total** | **99** |

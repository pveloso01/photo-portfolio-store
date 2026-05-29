# Compliance walkthrough — data-subject rights (M3 Wave 2)

This document maps each statutory data-subject right the platform must honour
(LGPD, GDPR, BIPA) to the concrete code path that satisfies it and the
`audit_log.action` value that path emits. It is the M3 exit-criterion artifact
for the compliance core (F3.3–F3.8).

Scope note — **ephemeral face model**: the platform never persists user-side
selfie bytes or user-level face embeddings. The biometric data we hold for a
subject is (1) their consent records (`consents`), (2) the per-event face
vectors derived from photos they appear in (`face_vectors` in Postgres +
per-event Qdrant collection `faces_event_<uuid>`), and (3) the records of
searches they initiated (`search_sessions` / `search_matches`). Selfie/R2
erasure steps are documented no-ops because nothing is stored there.

## Right-to-claim → code path → audit action

| Statute / claim | Right | Code path | `audit_log.action` |
|---|---|---|---|
| **LGPD Art. 18 II & IV** (confirmation + access to data) | Right to know | `GET /v1/me/biometric-data` → `services/biometric-data.ts:getMyBiometricData` | `biometric.disclosed` |
| **GDPR Art. 15** (right of access by the data subject) | Right to know | same as above | `biometric.disclosed` |
| **BIPA 15(a)** (public written retention + destruction policy) | Disclosure of policy | `GET /v1/consents/biometric/disclosure` → `routes/consent-disclosure.ts` (reads `consent_policy_versions`) | _(read-only; no audit row)_ |
| **BIPA 15(b)** (informed written consent before collection) | Informed consent | `POST /v1/consents/biometric` → `services/consents.ts:grantConsent`; disclosure text served by the F3.8 endpoint above; `lib/bipa.ts:detectBipaRegion` escalates IL/TX/WA into the statutory written-consent flow | `biometric.consent.granted` |
| **LGPD Art. 18 VI / GDPR Art. 17** (erasure / right to be forgotten) | Right to erasure | `DELETE /v1/consents/biometric/:id` → `services/consents.ts:cascadeErasure` (wraps M1 `revokeConsent`: flips consent → revoked, drops the per-event Qdrant collection when no other active consent references it, purges `face_vectors`, deletes `search_sessions` + `search_matches`, emails confirmation) | `biometric.erasure.cascade` (+ underlying `biometric.consent.revoked`) |
| **BIPA 15(a) retention ceiling** (destroy at the statutory boundary) | Automatic destruction | `apps/worker/jobs/bipa-retention.ts:runBipaRetentionDestruction` — daily 04:00 UTC cron; finds consents whose `retention_window_ends_at < now()`, drops vectors/collection, revokes | _(worker writes via pino, not `audit_log` — see below)_ |
| **Takedown / objection workflow** (third-party + subject removal requests) | Removal request | `POST /v1/takedowns` → `services/takedowns.ts:createTakedownRequest` | `takedown.submitted` |
| Takedown email verification | — | `GET /v1/takedowns/:id/verify?token=` → `verifyTakedown` | `takedown.verified` |
| Takedown fulfillment (admin) | — | `POST /v1/admin/takedowns/:id/fulfill` → `services/takedown-fulfillment.ts:fulfillTakedown` (delegates artifact purge to `moderation.bulkModerate('delete')`) | `takedown.fulfilled` |
| Takedown rejection (admin) | — | `POST /v1/admin/takedowns/:id/reject` → `rejectTakedown` | `takedown.rejected` |

## Retention windows (`lib/bipa.ts:computeRetentionWindowEndsAt`)

| Region / jurisdiction | Ceiling from grant | Statute |
|---|---|---|
| US-IL | 3 years | 740 ILCS 14/15(a) |
| US-WA | 3 years | HB 1493 |
| US-TX | 1 year | CUBI (Bus. & Com. Code §503.001) |
| `us_bipa` (no specific state) | 3 years | conservative ceiling |
| GDPR / LGPD / CCPA / other | `null` — governed by per-event `retention_days` (M1 mechanic) | — |

`detectBipaRegion` is **escalate-only**: any signal (declared region, billing
country combined with a state signal, or geo) pointing at a covered state
raises strictness. Geo never relaxes the rule and conflicts default to the
stricter side. Raw IP / geolocation are never persisted — the detector takes a
region string the caller resolved upstream.

## Takedown SLA (<24h)

The 24-hour SLA is enforced at three layers:

1. **DB trigger** — `received_at + 24h` populates `takedown_requests.sla_due_at`
   on insert (migration `0009_takedowns_bipa.sql`). The service also sets
   `sla_due_at` explicitly so the test shim (which does not run triggers) and a
   future trigger removal stay correct.
2. **Hourly worker sweep** — `apps/worker/jobs/takedown-sla.ts:runTakedownSlaCheck`
   (cron `0 * * * *`) finds rows with `sla_due_at < now()` and status not in
   (`fulfilled`, `rejected`) and emits a structured log line
   (`action='takedown.sla_breach'`, with `breachedBySeconds`) the on-call
   alerting layer matches on.
3. **CI guard** — `apps/worker/test/takedown-sla.test.ts` asserts the sweep
   flags overdue rows and ignores fulfilled/rejected ones.

## Audit logging vs worker logs

API-layer mutations write append-only rows to `audit_log` via
`lib/audit.ts:writeAudit` (actions listed above). The two worker crons
(`bipa-retention`, `takedown-sla`) run in `apps/worker`, which cannot import
`apps/api` code, so they emit **pino structured logs** rather than `audit_log`
rows. BIPA retention destruction is still observable via the
`bipa-retention` logger and is idempotent (a consent already revoked is
skipped). RBAC denials on the admin takedown routes emit `rbac.denied`.

## Authorization summary

| Route | Gate |
|---|---|
| `POST /v1/takedowns`, `GET /v1/takedowns/:id/verify`, `GET /v1/takedowns/:id` | Anonymous-allowed; per-IP rate limit (5/h) + token-gated subject view. RBAC-exempt. |
| `GET /v1/me/biometric-data` | Authenticated; owner = `request.user`. Rate limit 10/day. RBAC-exempt (owner-gated). |
| `GET /v1/consents/biometric/disclosure` | Public read. RBAC-exempt. |
| `DELETE /v1/consents/biometric/:id` | Owner-gated within handler (RBAC-exempt under existing `/v1/consents/biometric/*` rule). |
| `GET /v1/admin/takedowns`, `POST .../fulfill`, `POST .../reject` | `requirePermission('admin:moderate')`. |

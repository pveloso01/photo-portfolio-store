# Manual QA Runbook

This runbook bootstraps a local environment with synthetic data so you can
exercise the API and worker by hand. Closes the loop on F1.38.

## Prerequisites

- Docker Desktop running
- Node 20.18+, pnpm 9+
- Repo dependencies installed: `pnpm install`

## 1. Start infrastructure

```bash
docker compose -f docker-compose.dev.yml up -d
```

This brings up Postgres, Redis, MinIO, and Qdrant on their default dev ports.

## 2. Run database migrations

```bash
pnpm --filter @pkg/db db:migrate
```

## 3. Seed demo data

```bash
pnpm seed
```

Re-running `pnpm seed` is a no-op once the demo dataset exists; the script
keys off slugs / emails / deterministic SKUs.

Expected output:

```
✓ Seed complete
  org:           Demo Studio (id: ...)
  event:         Demo Marathon 2026 (id: ..., slug: demo-marathon-2026)
  organizer:     organizer@demo.test / demo-organizer-pw
  photographer:  photog@demo.test    / demo-photog-pw
  photos:        10
  products:      40
  bib_tags:      5
```

### Demo credentials

| Role          | Email                  | Password             |
|---------------|------------------------|----------------------|
| Organizer     | `organizer@demo.test`  | `demo-organizer-pw`  |
| Photographer  | `photog@demo.test`     | `demo-photog-pw`     |

These passwords are for local manual QA only. Do not reuse them in any
shared, staging, or production environment.

## 4. Start API + worker

```bash
pnpm dev
```

The API listens on `http://localhost:4000` by default. Make sure the
following env vars are set (see `docs/local-dev.md`):

- `DATABASE_URL`
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (>= 32 chars)

## 5. Smoke-test endpoints

Replace `:base` with `http://localhost:4000`. Login first to capture an
access token cookie for authenticated calls.

```bash
# Public event lookup by slug
curl -s ":base/v1/events?slug=demo-marathon-2026" | jq

# Login as the organizer
curl -s -c cookies.txt -X POST ":base/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"organizer@demo.test","password":"demo-organizer-pw"}'

# List photos in the demo event (replace EVENT_ID from step 3 summary)
curl -s -b cookies.txt ":base/v1/events/EVENT_ID/photos" | jq

# Search by bib number
curl -s ":base/v1/events/EVENT_ID/search?kind=bib&q=100" | jq

# View a single product (replace PRODUCT_ID from the photos listing)
curl -s ":base/v1/products/PRODUCT_ID" | jq

# Add a product to an anonymous cart
curl -s -c cart.txt -X POST ":base/v1/cart/items" \
  -H 'content-type: application/json' \
  -d '{"productId":"PRODUCT_ID","quantity":1}'
```

Routes not yet implemented in M1 will return 404; this list documents the
intended QA surface and grows as features land.

## 6. Reset

```bash
pnpm --filter @app/api tsx scripts/teardown.ts
```

This drops the demo org, event, photos, derivatives, products, and bib
tags. Demo users are deleted only when they have no remaining org
memberships. Safe to run repeatedly.

After teardown you can re-run `pnpm seed` to start fresh.

# M1 Integration Smoke Runbook

Manual end-to-end smoke for the full M1 happy path against the **real dev
stack** (Postgres + Redis + MinIO + Qdrant via `docker-compose.dev.yml` +
the seeded demo dataset).

This runbook is the executable spec for the automated integration test at
`apps/api/test/integration.test.ts`. When testcontainers land (issue #107)
the steps below become the canonical assertions the automated suite runs
against ephemeral containers.

## Prerequisites

1. Docker Desktop running.
2. `docker compose -f docker-compose.dev.yml up -d`.
3. `pnpm --filter @pkg/db db:migrate`.
4. `pnpm seed` — capture the printed `event:` id as `EVENT_ID`.
5. `pnpm dev` (starts API on `http://localhost:4000` and the worker).
6. Helpful env vars exported (`DATABASE_URL`, `STRIPE_SECRET_KEY` test key,
   `STRIPE_WEBHOOK_SECRET`, etc — see `docs/local-dev.md`).

Convenience variables for the rest of this doc:

```bash
export BASE=http://localhost:4000
export EVENT_ID=<from pnpm seed output>
```

## 1. Setup verification

```bash
psql "$DATABASE_URL" -c "select id, slug, status from app.events where id = '$EVENT_ID';"
psql "$DATABASE_URL" -c "select count(*) from app.photos where event_id = '$EVENT_ID';"
psql "$DATABASE_URL" -c "select count(*) from app.photo_derivatives pd join app.photos p on p.id = pd.photo_id where p.event_id = '$EVENT_ID';"
psql "$DATABASE_URL" -c "select count(*) from app.bib_tags where event_id = '$EVENT_ID';"
```

Expected: event row with `status=published`, photos = 10, derivatives = 40,
bib_tags = 5 (default seed dataset).

## 2. Auth phase

```bash
# Register a fresh buyer account.
curl -s -X POST "$BASE/v1/auth/register" \
  -H 'content-type: application/json' \
  -d '{"email":"smoke-buyer@test.invalid","password":"smoke-password-123","displayName":"Smoke Buyer"}'

# Login -> capture access token.
ACCESS=$(curl -s -X POST "$BASE/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"smoke-buyer@test.invalid","password":"smoke-password-123"}' \
  | jq -r .accessToken)
echo "$ACCESS"
```

Expected: register returns 201 with `{ user: { id, email, ... } }`. Login
returns 200 with `{ accessToken, refreshToken, user: { ... } }`.

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select action, target_kind from app.audit_log where action in ('auth.register','auth.login') order by created_at desc limit 2;"
```

## 3. Browse phase

```bash
curl -s "$BASE/v1/events/$EVENT_ID" -H "authorization: Bearer $ACCESS" | jq
```

Expected: 200 with `{ event: { id, name, status, currency, ... } }`.

## 4. Search phase — bib

```bash
curl -s -X POST "$BASE/v1/events/$EVENT_ID/search/bib" \
  -H 'content-type: application/json' \
  -d '{"bibNumber":"100"}' | jq
```

Expected: 200 with `{ matches: [ { photoId, previewUrl } ... ] }` where
each `previewUrl` is a signed S3/MinIO URL (contains `X-Amz-Signature=`).

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select id, kind, event_id from app.search_sessions where event_id = '$EVENT_ID' order by created_at desc limit 1;"
psql "$DATABASE_URL" -c "select count(*) from app.search_matches sm join app.search_sessions ss on ss.id = sm.session_id where ss.event_id = '$EVENT_ID' and ss.kind = 'bib';"
```

## 5. Search phase — selfie (consent-gated)

```bash
# Grant biometric consent with all four acknowledgements.
CONSENT=$(curl -s -c consent-cookies.txt -X POST "$BASE/v1/consents/biometric" \
  -H 'content-type: application/json' \
  -d '{
    "eventId":"'$EVENT_ID'",
    "policyVersion":"2026-05-18",
    "policyLocale":"en-US",
    "acknowledgements":{
      "biometricUse":true,
      "retention":true,
      "thirdParty":true,
      "rightsToDelete":true
    }
  }' | jq -r .consentId)
echo "$CONSENT"

# Selfie search. Use any real face photo as the input.
curl -s -X POST "$BASE/v1/events/$EVENT_ID/search/face" \
  -F "consent_id=$CONSENT" \
  -F "selfie=@./test-selfie.jpg;type=image/jpeg" | jq
```

Expected: consent grant returns 201 with `{ consentId, expiresAt,
searchesRemaining: 20 }`. Selfie search returns 200 with `{ sessionId,
matches: [...], consent: { searchesRemaining: 19 } }`.

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select id, status, searches_used, searches_quota from app.consents where id = '$CONSENT';"
psql "$DATABASE_URL" -c "select id, kind, consent_id from app.search_sessions where consent_id = '$CONSENT';"
# Confirm selfie bytes are NOT persisted anywhere.
docker compose -f docker-compose.dev.yml exec minio sh -c "find /data -name '*selfie*' -mmin -5" # expect empty
```

## 6. Cart + checkout

```bash
# Pick a product id from the event.
PRODUCT_ID=$(psql "$DATABASE_URL" -At -c "select id from app.products where event_id = '$EVENT_ID' and active = true limit 1;")
PHOTO_ID=$(psql "$DATABASE_URL" -At -c "select photo_id from app.products where id = '$PRODUCT_ID';")
TIER_ID=$(psql "$DATABASE_URL" -At -c "select id from app.license_tiers where code = 'personal' limit 1;")

# Create cart (sets pps_cart cookie).
curl -s -c cart-cookies.txt -X POST "$BASE/v1/cart" \
  -H 'content-type: application/json' \
  -d '{"eventId":"'$EVENT_ID'"}' | jq

# Add item.
curl -s -b cart-cookies.txt -X POST "$BASE/v1/cart/items" \
  -H 'content-type: application/json' \
  -d "{\"productId\":\"$PRODUCT_ID\",\"photoId\":\"$PHOTO_ID\",\"licenseTierId\":\"$TIER_ID\"}" | jq

CART_ID=$(psql "$DATABASE_URL" -At -c "select id from app.carts where event_id = '$EVENT_ID' order by created_at desc limit 1;")

# Checkout.
CHECKOUT=$(curl -s -b cart-cookies.txt -X POST "$BASE/v1/cart/$CART_ID/checkout" \
  -H 'content-type: application/json' \
  -d '{"buyerEmail":"smoke-buyer@test.invalid"}')
echo "$CHECKOUT" | jq
ORDER_ID=$(echo "$CHECKOUT" | jq -r .orderId)
CLIENT_SECRET=$(echo "$CHECKOUT" | jq -r .clientSecret)
```

Expected: 201 with `{ orderId, clientSecret, totalCents, currency: "USD" }`.

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select id, status, stripe_payment_intent_id, total_cents from app.orders where id = '$ORDER_ID';"
psql "$DATABASE_URL" -c "select status, converted_at from app.carts where id = '$CART_ID';"
psql "$DATABASE_URL" -c "select count(*) from app.order_items where order_id = '$ORDER_ID';"
```

Order status should be `pending_payment`, cart status `converted`.

## 7. Webhook — payment_intent.succeeded

Use the Stripe CLI to forward live test events, or post a synthetic event
signed with the configured `STRIPE_WEBHOOK_SECRET`:

```bash
# Recommended (real Stripe flow):
stripe listen --forward-to localhost:4000/v1/webhooks/stripe &
stripe trigger payment_intent.succeeded \
  --override payment_intent:metadata.orderId=$ORDER_ID

# Or manual confirm of the PI created above using a test card token (4242):
stripe payment_intents confirm <PI_ID> --payment-method pm_card_visa
```

Expected: webhook receiver returns 200 with `{ received: true, idempotent:
false, result: "success" }`.

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select id, type, result, processed_at from app.stripe_webhook_events order by received_at desc limit 1;"
psql "$DATABASE_URL" -c "select status, paid_at, stripe_charge_id from app.orders where id = '$ORDER_ID';"
redis-cli LRANGE bull:fulfillment-digital:waiting 0 -1
redis-cli ZRANGE bull:fulfillment-digital:completed 0 -1
```

Expected: order status `paid`, `paid_at` set, `stripe_charge_id` populated.
Fulfillment job either waiting or already completed in BullMQ.

## 8. Fulfillment — digital

The worker should process the enqueued job automatically. Watch logs:

```bash
pnpm --filter @app/worker dev # in a second pane, or tail logs
```

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select id, kind, status, download_token, object_key, expires_at from app.fulfillments where order_id = '$ORDER_ID';"
aws --endpoint-url http://localhost:9000 s3 ls "s3://photo-derivatives/bundles/$ORDER_ID/"
```

Expected: fulfillment row with `status=completed`, `download_token` populated,
zip file in MinIO at `bundles/<orderId>/<token>.zip`.

Also: buyer should receive an email (check the worker log line
`email.sent kind=fulfillment.digital` or your local mailpit at
`http://localhost:8025` if configured).

## 9. Download phase

```bash
TOKEN=$(psql "$DATABASE_URL" -At -c "select download_token from app.fulfillments where order_id = '$ORDER_ID';")
curl -si "$BASE/v1/orders/$ORDER_ID/downloads/$TOKEN" | head -20
```

Expected: HTTP 302 with `location:` pointing at a signed MinIO URL
containing `X-Amz-Signature=`. Following the redirect downloads the zip.

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select action, target_kind, ip_hash from app.audit_log where action = 'fulfillment.digital.accessed' order by created_at desc limit 1;"
```

## 10. Replay assertions

Re-deliver the same Stripe event id via the Stripe CLI or a manual curl
with the same `id`:

```bash
stripe events resend <evt_id_from_step_7>
```

Expected: 200 with `{ idempotent: true, result: "success" }`.

```bash
psql "$DATABASE_URL" -c "select count(*) from app.stripe_webhook_events where id = '<evt_id>';"
# Should still be exactly 1.
redis-cli ZCARD bull:fulfillment-digital:completed
# Should not have incremented from step 8.
```

## 11. Revocation phase

```bash
curl -si -b consent-cookies.txt -X DELETE "$BASE/v1/consents/biometric/$CONSENT"
```

Expected: 204 with empty body.

Verify side effect:

```bash
psql "$DATABASE_URL" -c "select id, status, revoked_at from app.consents where id = '$CONSENT';"

# Subsequent face search must 403.
curl -si -X POST "$BASE/v1/events/$EVENT_ID/search/face" \
  -F "consent_id=$CONSENT" \
  -F "selfie=@./test-selfie.jpg;type=image/jpeg" | head -5
```

Expected: revoked status persisted, second face search returns 403 with
`{ error: "consent_invalid" }`.

Also confirm Qdrant deletion happened:

```bash
curl -s "http://localhost:6333/collections/face_vectors_$EVENT_ID/points/count"
```

## 12. Audit walkthrough

The following actions must all be present in `app.audit_log`, in the order
listed below (`created_at` ascending), for the smoke session:

```bash
psql "$DATABASE_URL" <<SQL
select action, created_at
  from app.audit_log
 where created_at > now() - interval '15 minutes'
   and action in (
     'auth.register',
     'auth.login',
     'search.bib.executed',
     'biometric.consent.granted',
     'biometric.search.face',
     'cart.created',
     'cart.item.added',
     'order.created',
     'checkout.intent_created',
     'order.paid',
     'fulfillment.digital.completed',
     'fulfillment.digital.accessed',
     'biometric.consent.revoked'
   )
 order by created_at asc;
SQL
```

Expected: 13 rows in the listed order. Any missing row indicates the
corresponding step did not run through the audit path.

## Teardown

```bash
pnpm --filter @app/api tsx scripts/teardown.ts
docker compose -f docker-compose.dev.yml down -v
```

## Gaps vs. the automated test

The automated test at `apps/api/test/integration.test.ts` cannot exercise
the following without real infra (#107):

- Real Postgres joins for the events / downloads / consent verify paths.
- Real Qdrant collection lifecycle on revoke.
- Real S3 streaming through archiver -> `bundles/<orderId>/<token>.zip`.
- Real argon2 password hashing + JWT signing through the auth routes.
- Real SMTP delivery to the buyer mailbox.
- Assertion that selfie bytes are never persisted (requires fs / S3 watch).

This runbook is the canonical proof those work end-to-end on the dev stack
until #107 promotes them into the automated suite.

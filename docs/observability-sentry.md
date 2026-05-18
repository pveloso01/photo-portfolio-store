# Sentry Observability Runbook

Sentry is wired into all three services: `apps/api`, `apps/worker`, and `apps/inference`.
Instrumentation is a no-op when `SENTRY_DSN` is unset, which is the local-dev default.

## What gets captured

- **api** (`@sentry/node`): unhandled exceptions in Fastify route handlers via
  `Sentry.setupFastifyErrorHandler(app)`. Default Node integrations capture
  `uncaughtException` and `unhandledRejection`.
- **worker** (`@sentry/node`): explicit `process.on('uncaughtException')` and
  `process.on('unhandledRejection')` hooks forward errors to Sentry before
  re-throwing.
- **inference** (`sentry-sdk[fastapi]`): `FastApiIntegration` captures unhandled
  exceptions from FastAPI route handlers.

Tracing is enabled at `tracesSampleRate=0.1` in production and `1.0` in
non-production environments.

## Environment variables

| Variable          | Required | Notes                                              |
|-------------------|----------|----------------------------------------------------|
| `SENTRY_DSN`      | no       | When unset, Sentry init is skipped entirely.       |
| `SENTRY_RELEASE`  | no       | Recommended in CI/production. See release tagging. |
| `NODE_ENV`        | no       | Drives `environment` tag and sample rate.          |

### Per-environment configuration

- **local dev**: leave `SENTRY_DSN` unset. Services boot without contacting Sentry.
- **staging / production**: set `SENTRY_DSN` per service (one DSN per project is
  fine; project tagging via `environment` separates them). Set `SENTRY_RELEASE`
  to the git SHA of the deployed artifact.

## Release tagging

In CI, before building or deploying, export the release identifier:

```bash
export SENTRY_RELEASE=$(git rev-parse HEAD)
```

Both Node services and the Python service read `SENTRY_RELEASE` at startup.

## PII scrubbing rules

- `sendDefaultPii` / `send_default_pii` is **off** everywhere.
- The Node `beforeSend` hook additionally strips `event.user.email` and
  `event.user.ip_address` before transmission.
- Do not log request bodies or query strings that contain customer data
  without scrubbing first.

## Verifying

Set `SENTRY_DSN` locally and throw from a route or job. The event should appear
in the Sentry UI within seconds, tagged with the correct `environment` and
`release`.

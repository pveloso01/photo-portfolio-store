# Local development

Runbook for booting the local development stack for `photo-portfolio-store`.

## Prerequisites

- Docker Desktop (or compatible engine with Compose v2)
- Node.js 20.x
- pnpm 9.x
- Python 3.12
- [uv](https://docs.astral.sh/uv/) (Python package and project manager)

## One-time setup

Copy the example env file to a local override:

```bash
cp .env.example .env.local
```

Or, if using Doppler:

```bash
doppler setup
```

## Boot infrastructure

Start all backing services (Postgres, Redis, MinIO, Qdrant, Mailpit) in the
background:

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Verify services

| Service  | Check                                                          |
| -------- | -------------------------------------------------------------- |
| Postgres | `pg_isready -h localhost -p 5432 -U photo -d photo`            |
| MinIO    | Console: http://localhost:9001 (login `minioadmin`/`minioadmin`) |
| Qdrant   | `curl -f http://localhost:6333/readyz`                         |
| Mailpit  | UI: http://localhost:8025                                      |
| Redis    | `redis-cli -h localhost -p 6379 ping` (expect `PONG`)          |

## Boot apps

In separate terminals:

```bash
# Node API + worker
pnpm dev

# Python inference service
pnpm py:dev
```

## Smoke test

```bash
curl localhost:4000/health
```

## Shut down

Stop containers, keep volumes (data preserved):

```bash
docker compose -f docker-compose.dev.yml down
```

Stop containers and wipe all data (fresh slate):

```bash
docker compose -f docker-compose.dev.yml down -v
```

## Notes

- This stack is dev-only. Production manifests live elsewhere (TBD).
- All persistent state is in named Docker volumes for Windows/macOS/Linux
  parity. No host bind mounts.
- MinIO buckets `photo-originals` and `photo-derivatives` are created
  automatically on first boot by the `minio-init` one-shot container.

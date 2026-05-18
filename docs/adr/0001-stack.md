# 1. Canonical stack for photo-portfolio-store

Date: 2026-05-18

## Status

Accepted

## Context

`photo-portfolio-store` is an event photography platform: photographers upload high volumes of images per event, attendees self-identify by face match, and buyers transact via Stripe. The system therefore has three load-bearing axes that pull in different directions:

1. **A transactional HTTP API** that owns orders, ledger, refunds, auth, webhooks, and admin surfaces. Needs ACID guarantees, a mature payments SDK, strong OpenAPI tooling, and high developer velocity.
2. **A face-recognition inference path** that ingests raw photos, detects faces, computes embeddings, and serves nearest-neighbour search against per-event vector indexes. Needs first-class access to modern face models and ONNX tooling.
3. **A background job tier** for thumbnailing, watermarking, EXIF stripping, embedding generation, takedown propagation, and post-purchase delivery. Needs to share types and domain logic with the API.

We also have hard non-functional constraints:

- Low egress cost at scale (a buyer downloading their pack can pull hundreds of MBs).
- Per-event isolation for legal takedown — when an event organiser revokes consent, we must drop face embeddings and derived data cleanly, not just soft-delete rows.
- A cost ceiling that lets the platform stay viable below ~50M indexed faces without re-platforming.
- A small early team — polyglot is acceptable but each language must earn its seat.

This ADR locks in the canonical stack so that subsequent ADRs and implementation work can stop relitigating the choice.

## Decision

### API layer — Node 20 LTS + TypeScript (strict) + Fastify

Fastify chosen over Express (faster, async-native plugin model, schema-first validation via JSON Schema / TypeBox), and over Hono and Elysia (smaller ecosystem, less battle-tested middleware for auth, Stripe webhooks, OpenAPI generation). TypeScript strict mode is non-negotiable.

### Inference service — Python 3.12 + FastAPI + InsightFace (ArcFace) via ONNX Runtime

InsightFace's ArcFace family is the de facto open face-embedding standard. ONNX Runtime runs the same model on CPU today and GPU (CUDA/TensorRT execution provider) later without a rewrite. FastAPI gives us a thin, typed HTTP wrapper that mirrors the Node API's contract style.

### Workers — Node + BullMQ on Redis

Same language as the API so workers can import shared domain types, validators, and Stripe/Postgres clients directly. BullMQ provides retries, rate limiting, repeatable jobs, and a usable dashboard. The inference service is called over HTTP from workers, not embedded.

### Datastores

| Store | Role | Notes |
|---|---|---|
| Postgres 16 | Relational core: users, events, orders, ledger, refunds, consents | ACID + joins. pgvector enabled as a fallback escape hatch. |
| Redis 7 | BullMQ queue backend + ephemeral cache + rate limiting | Single managed instance to start; can split queue and cache later. |
| Cloudflare R2 | Object storage for originals, derivatives, packs | S3-compatible API; near-zero egress when served via Cloudflare CDN. |
| Qdrant | Vector DB for face embeddings | **One collection per event** for clean takedown semantics. |

### Observability

- **Sentry** for application errors and release tracking, across both Node and Python services.
- **OpenTelemetry (OTLP)** for distributed traces; API, workers, and inference service all emit. Backend is swappable (Tempo, Honeycomb, SigNoz).
- **Pino** for structured JSON logs on the Node side; standard `logging` with JSON formatter on the Python side. Both ship to the same log sink with correlated trace IDs.

## Alternatives considered

### Go for the API layer

Rejected. Go is excellent for high-throughput services and would lower runtime cost, but the surrounding ecosystem we depend on is materially weaker: the official Stripe Go SDK lags the Node SDK on new APIs, OpenAPI tooling around Go is fragmented, and image-processing libraries are less polished than `sharp`. For an early-stage team prioritising velocity over raw throughput, Node + TS wins.

### Rust for the inference service

Rejected. Face recognition tooling is overwhelmingly Python-first — InsightFace, DeepFace, the ArcFace reference checkpoints, and most academic baselines all ship as Python packages or PyTorch/ONNX exports. Rebuilding around Rust crates (`ort`, `candle`) would mean reimplementing pre/post-processing pipelines that exist for free in Python, slowing model iteration significantly. Rust may revisit this as an optimisation later for hot serving paths, but not as the primary stack.

### Single-language monolith (all Node, all Python, or all Rust)

Rejected. The asymmetry is fundamental: face/ML tooling is meaningfully better in Python, and HTTP API + worker tooling (typed clients, Stripe SDK, Prisma/Drizzle, BullMQ) is meaningfully better in Node/TS. An all-Node stack would force us to call ONNX from Node and rebuild face pre/post-processing; an all-Python stack would give us a worse API layer and worse worker ergonomics; an all-Rust stack loses both ML iteration speed and payments SDK maturity. Polyglot pays for itself here.

### Fully-managed AWS Rekognition Collections instead of self-hosted InsightFace + Qdrant

Rejected as the long-term path; acceptable as an MVP shortcut if needed. Rekognition pricing is roughly $1 per 1,000 indexed faces plus $0.00001 per face per month for storage. At 10M indexed faces that's ~$10k one-shot indexing plus ~$1.2k/month storage, scaling linearly with reindex churn — order-of-magnitude ~$100k/yr at steady state for our target scale. Self-hosted InsightFace inference plus a Qdrant cluster breaks even well below that and also gives us model portability, on-prem inference for sensitive events, and no vendor-imposed face-data residency constraints.

### DynamoDB or MongoDB instead of Postgres

Rejected. Orders, ledger entries, and refunds are textbook ACID workloads with multi-row invariants (a refund must adjust the ledger and the order atomically). Document stores would force application-level transaction emulation. Postgres also gives us mature analytics tooling and, via pgvector, an emergency escape hatch if Qdrant ever has to be removed.

### Bun runtime instead of Node 20 LTS

Rejected for now. Bun has matured but as of mid-2026 still has rough edges around long-running production servers, native module compatibility, and — critically — the Stripe Node SDK does not yet officially certify against Bun. Payment-handling code is not where we want to be early on a runtime. Revisit once Bun 2.0 ships and Stripe marks compatibility.

## Consequences

### Operational

- **Two production languages.** CI matrix doubles for tests, linters, formatters, security scans, and SBOM generation. Tooling investment (shared OTel config, shared structured-logging schema, shared Sentry projects) needs to happen once and be ruthlessly reused.
- **Inference service is a network hop from workers.** Workers retry on transient inference failures; inference service must be horizontally scalable and stateless. This is desirable — it lets us swap CPU pods for GPU pods without touching workers.
- **Per-event Qdrant collections** give clean takedown semantics: revoking an event drops one collection rather than issuing millions of row deletes. Tradeoff is more collections to manage (monitoring, backup, cardinality on the Qdrant cluster) — acceptable up to mid-five-figures of events.

### Cost

R2 + Cloudflare CDN is the largest single cost-at-scale win in this stack. Object egress on S3 ($0.09/GB after the first GB) would dominate the bill once buyers start downloading photo packs; R2 egress to Cloudflare is effectively free, with paid storage at roughly a quarter of S3 Standard.

Rough self-hosted face-stack cost model (compute + Qdrant + storage only, excluding API/worker/Postgres):

| Indexed faces | Qdrant footprint (512-d float32, replicated) | Approx monthly cost |
|---|---|---|
| 1M | ~4 GB | $150–300 |
| 10M | ~40 GB | $1.2k–2.0k |
| 50M | ~200 GB, sharded | $5k–8k |

Comparable Rekognition spend at 50M faces would be in the $40k–60k/month range before any reindexing churn, which is the load-bearing reason for self-hosting.

### Team and hiring

Polyglot widens the hiring surface in principle but in practice each role is narrower than a monolith would imply: a TypeScript backend engineer owns API + workers + most of the domain; a Python ML engineer owns the inference service and model lifecycle. Cross-training is encouraged but not required for either role to be productive.

### Reversibility

- API framework swap (Fastify -> something else) is contained — route handlers are thin and validation is schema-driven.
- Vector DB swap (Qdrant -> pgvector or Milvus) is moderate — embeddings are portable, but per-event collection semantics would need re-implementation.
- Inference model swap (ArcFace -> newer model) is cheap as long as the embedding dimensionality and similarity metric are preserved; otherwise a full reindex is required.
- Object storage swap (R2 -> S3 or back) is easy because the S3 API is the abstraction; the cost equation changes, not the code.
- Language swap on either API or inference would constitute a re-platform and must be recorded as a new ADR superseding this one.

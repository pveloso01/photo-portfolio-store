// Vitest globalSetup for the integration suite.
//
// Boots Postgres + MinIO via testcontainers in parallel, applies drizzle
// migrations against the live Postgres, then exports the env vars the API
// modules read at import time. The teardown handle is closed when vitest
// exits the run.
//
// Local-dev escape hatch: if INTEGRATION_REUSE_EXTERNAL is set, we skip the
// container start and trust env-supplied DATABASE_URL + S3_* values. This
// lets developers point the integration suite at `docker compose up`
// services for faster inner loops while keeping CI hermetic.

import {
  type StartedMinio,
  type StartedPostgres,
  applyMigrations,
  startMinio,
  startPostgres,
} from '@pkg/test-infra';

let pg: StartedPostgres | undefined;
let minio: StartedMinio | undefined;

export const setup = async (): Promise<void> => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-32-chars-long-xx';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-chars-long-yy';
  process.env.JWT_ACCESS_TTL ??= '15m';
  process.env.JWT_REFRESH_TTL ??= '30d';
  process.env.ARGON2_MEMORY_KIB ??= '8';
  process.env.RATE_LIMIT_AUTH_REQS_PER_MIN ??= '10000';
  process.env.STRIPE_SECRET_KEY ??= 'sk_test_dummy_for_tests';
  process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_test_dummy';
  process.env.IP_HASH_SALT ??= 'test-ip-hash-salt';
  process.env.INFERENCE_URL ??= 'http://inference.stub';
  process.env.INFERENCE_API_KEY ??= 'test-key';
  process.env.QDRANT_URL ??= 'http://qdrant.stub';
  process.env.QDRANT_API_KEY ??= 'test-key';
  process.env.S3_REGION ??= 'us-east-1';
  process.env.S3_BUCKET_ORIGINALS ??= 'photo-originals';
  process.env.S3_BUCKET_DERIVATIVES ??= 'photo-derivatives';

  if (process.env.INTEGRATION_REUSE_EXTERNAL === '1') {
    if (!process.env.DATABASE_URL) {
      throw new Error('INTEGRATION_REUSE_EXTERNAL=1 requires DATABASE_URL to be set externally');
    }
    process.env.S3_ENDPOINT ??= 'http://localhost:9000';
    process.env.S3_ACCESS_KEY_ID ??= 'minioadmin';
    process.env.S3_SECRET_ACCESS_KEY ??= 'minioadmin';
    process.env.S3_PUBLIC_BASE_URL ??= `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET_DERIVATIVES}`;
    await applyMigrations(process.env.DATABASE_URL);
    return;
  }

  [pg, minio] = await Promise.all([startPostgres(), startMinio()]);

  process.env.DATABASE_URL = pg.url;
  process.env.S3_ENDPOINT = minio.endpoint;
  process.env.S3_ACCESS_KEY_ID = minio.accessKey;
  process.env.S3_SECRET_ACCESS_KEY = minio.secretKey;
  process.env.S3_PUBLIC_BASE_URL = `${minio.endpoint}/${process.env.S3_BUCKET_DERIVATIVES}`;

  await applyMigrations(pg.url);
};

export const teardown = async (): Promise<void> => {
  // Don't stop reused containers — let `testcontainers` GC them by label.
  if (process.env.TESTCONTAINERS_REUSE_ENABLE === 'true') return;
  await Promise.allSettled([pg?.stop(), minio?.stop()]);
};

// Vitest globalSetup contract: named `setup`/`teardown` exports OR a
// default function returning teardown. Named exports above suffice.

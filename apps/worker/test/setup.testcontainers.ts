// Vitest globalSetup for the worker integration suite. Mirrors
// apps/api/test/setup.testcontainers.ts — see that file for design notes.

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
  process.env.IP_HASH_SALT ??= 'test-ip-hash-salt';
  process.env.INFERENCE_URL ??= 'http://inference.stub';
  process.env.INFERENCE_API_KEY ??= 'test-key';
  process.env.QDRANT_URL ??= 'http://qdrant.stub';
  process.env.QDRANT_API_KEY ??= 'test-key';
  process.env.S3_REGION ??= 'us-east-1';
  process.env.S3_BUCKET_ORIGINALS ??= 'photo-originals';
  process.env.S3_BUCKET_DERIVATIVES ??= 'photo-derivatives';
  process.env.REDIS_URL ??= 'redis://localhost:6379';

  if (process.env.INTEGRATION_REUSE_EXTERNAL === '1') {
    if (!process.env.DATABASE_URL) {
      throw new Error('INTEGRATION_REUSE_EXTERNAL=1 requires DATABASE_URL to be set externally');
    }
    process.env.S3_ENDPOINT ??= 'http://localhost:9000';
    process.env.S3_ACCESS_KEY_ID ??= 'minioadmin';
    process.env.S3_SECRET_ACCESS_KEY ??= 'minioadmin';
    await applyMigrations(process.env.DATABASE_URL);
    return;
  }

  [pg, minio] = await Promise.all([startPostgres(), startMinio()]);
  process.env.DATABASE_URL = pg.url;
  process.env.S3_ENDPOINT = minio.endpoint;
  process.env.S3_ACCESS_KEY_ID = minio.accessKey;
  process.env.S3_SECRET_ACCESS_KEY = minio.secretKey;
  await applyMigrations(pg.url);
};

export const teardown = async (): Promise<void> => {
  if (process.env.TESTCONTAINERS_REUSE_ENABLE === 'true') return;
  await Promise.allSettled([pg?.stop(), minio?.stop()]);
};

// Vitest globalSetup contract: named `setup` + `teardown` exports.

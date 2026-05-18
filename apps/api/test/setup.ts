// Vitest global setup: provides the env vars that env-validators check at
// module load time. Real values come from .env.local / Doppler in dev and from
// GitHub Actions secrets in CI.

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://photo:photo@localhost:5432/photo_test';
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-at-least-32-chars-long-xx';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret-at-least-32-chars-long-yy';
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';
process.env.S3_BUCKET_ORIGINALS = process.env.S3_BUCKET_ORIGINALS ?? 'photo-originals';
process.env.S3_BUCKET_DERIVATIVES = process.env.S3_BUCKET_DERIVATIVES ?? 'photo-derivatives';
process.env.S3_PUBLIC_BASE_URL =
  process.env.S3_PUBLIC_BASE_URL ?? 'http://localhost:9000/photo-derivatives';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_dummy_for_tests';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_dummy';
process.env.IP_HASH_SALT = process.env.IP_HASH_SALT ?? 'test-ip-hash-salt';

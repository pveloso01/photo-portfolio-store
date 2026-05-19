// Sentry instrument no-op-load test.
//
// Re-enables 1 test skipped under #107. The unit suite ran this in parallel
// with other tests that set SENTRY_DSN, causing a race. In the integration
// suite each test file runs in its own fork by default, so the env-mutation
// is isolated.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('instrument (Sentry) — isolated fork', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
  });

  it('loads as a no-op when SENTRY_DSN is unset', async () => {
    await expect(import('../src/instrument.js')).resolves.toBeDefined();
  });
});

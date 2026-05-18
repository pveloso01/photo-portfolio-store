import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('instrument (Sentry)', () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
  });

  it('loads as a no-op when SENTRY_DSN is unset', async () => {
    await expect(import('../src/instrument.js')).resolves.toBeDefined();
  });
});

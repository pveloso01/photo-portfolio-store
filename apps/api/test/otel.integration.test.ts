// OTEL no-op-load test, re-enabled under the integration suite where
// per-file forks eliminate the env-mutation race that caused this to be
// skipped in the unit suite.

import { describe, expect, it } from 'vitest';

describe('OpenTelemetry init (no-op path) — isolated fork', () => {
  it('loads instrument.ts without throwing when OTEL endpoint is unset', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const mod = await import('../src/instrument.js');
    expect(mod.otelSdk).toBeUndefined();
  });
});

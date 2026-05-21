// F2.12 — payout job unit tests.
// Verifies triggerPayoutRun POSTs to the right URL with the secret header,
// returns {ok, status}, and handles non-2xx without throwing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub logger so the worker logger module does not bootstrap pino-pretty in tests.
vi.mock('../src/lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) },
}));

import { triggerPayoutRun } from '../src/jobs/payouts.js';

const BASE_URL = 'http://api:3000';
const SECRET = 'test-secret';

beforeEach(() => {
  process.env.API_BASE_URL = BASE_URL;
  process.env.INTERNAL_CRON_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.API_BASE_URL;
  delete process.env.INTERNAL_CRON_SECRET;
});

describe('triggerPayoutRun', () => {
  it('POSTs to the correct URL with the x-internal-secret header and returns ok:true', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = input as string;
      capturedInit = init;
      return new Response(JSON.stringify({ result: { created: [], skipped: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await triggerPayoutRun({ fetchImpl: fakeFetch });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(capturedUrl).toBe(`${BASE_URL}/v1/internal/payouts/run`);
    expect((capturedInit?.headers as Record<string, string>)?.['x-internal-secret']).toBe(SECRET);
    expect(capturedInit?.method).toBe('POST');
  });

  it('returns ok:false with the status on a non-2xx response without throwing', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

    const result = await triggerPayoutRun({ fetchImpl: fakeFetch });

    expect(result).toEqual({ ok: false, status: 401 });
  });

  it('returns ok:false with status 0 when fetch itself throws', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('network error');
    };

    const result = await triggerPayoutRun({ fetchImpl: fakeFetch });

    expect(result).toEqual({ ok: false, status: 0 });
  });
});

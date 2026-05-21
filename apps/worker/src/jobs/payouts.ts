// F2.12 — weekly payout cron trigger.
//
// Reads two env vars directly from process.env (not from workerEnvSchema,
// which does not declare them — they are API/cron-bridge concerns):
//
//   API_BASE_URL         — base URL of the API service, e.g. http://api:3000
//   INTERNAL_CRON_SECRET — shared secret for x-internal-secret auth header
//
// Both vars default to empty string when unset; the API endpoint returns 503
// (disabled) or 401 (bad secret) so the cron is safe to deploy before the
// vars are provisioned.

import { logger } from '../lib/logger.js';

const cronLog = logger.child({ job: 'payout-run' });

export interface TriggerPayoutRunResult {
  ok: boolean;
  status: number;
}

/**
 * POST to the internal payout-run endpoint with the shared cron secret.
 * Does NOT throw on non-2xx; logs and returns {ok: false, status} instead
 * so the scheduler can log the outcome without crashing the worker process.
 *
 * @param opts.fetchImpl - injectable fetch implementation for tests (default: global fetch).
 */
export const triggerPayoutRun = async (opts?: {
  fetchImpl?: typeof fetch;
}): Promise<TriggerPayoutRunResult> => {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const apiBaseUrl = process.env.API_BASE_URL ?? '';
  const secret = process.env.INTERNAL_CRON_SECRET ?? '';
  const url = `${apiBaseUrl}/v1/internal/payouts/run`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'x-internal-secret': secret,
        'content-type': 'application/json',
      },
    });
  } catch (err) {
    cronLog.error({ err, url }, 'payout-run: fetch failed');
    return { ok: false, status: 0 };
  }

  if (!response.ok) {
    cronLog.error({ status: response.status, url }, 'payout-run: non-2xx response');
    return { ok: false, status: response.status };
  }

  return { ok: true, status: response.status };
};

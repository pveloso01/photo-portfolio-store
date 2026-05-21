// Cron scheduler bootstrap. Owns the croner instances; the worker entrypoint
// calls startSchedulers() once at boot and keeps the returned handles so they
// can be stopped on shutdown.

import { Cron } from 'croner';
import pino from 'pino';

import { db } from '../lib/db.js';
import { qdrant } from '../lib/qdrant.js';
import { triggerPayoutRun } from './payouts.js';
import { runRetentionPass } from './retention.js';

const log = pino({ name: 'retention-scheduler' });
const payoutLog = pino({ name: 'payout-scheduler' });

/**
 * Wire up cron jobs and return the live handles. Caller is responsible for
 * calling .stop() on each handle during graceful shutdown.
 *
 * - Biometric retention: every 6 hours. Nightly is too lossy for the
 *   biometric SLA (a 24h window of over-retention is hard to defend under
 *   BIPA); every hour is wasteful given normal event lifecycles.
 * - Payout run: weekly, Mondays at 03:00 UTC. Cadence is fixed regardless of
 *   public holidays (locked product decision). Minimum payout = 0 (also
 *   locked). The job calls the internal API endpoint rather than importing
 *   payout logic directly so the worker stays free of API-layer deps.
 * - `protect: true` skips overlapping ticks if a previous run is still in
 *   progress — important for slow purges that span many events.
 */
export const startSchedulers = (): Cron[] => {
  const retentionJob = new Cron(
    '0 */6 * * *',
    { name: 'biometric-retention', protect: true },
    async () => {
      try {
        const result = await runRetentionPass(db, qdrant);
        log.info({ result }, 'retention pass complete');
      } catch (err) {
        log.error({ err }, 'retention pass failed');
      }
    },
  );

  // Weekly payout cron — Mondays 03:00 UTC.
  // Fixed day regardless of holidays (locked decision); no minimum (locked decision).
  const payoutJob = new Cron('0 3 * * 1', { name: 'payout-run', protect: true }, async () => {
    try {
      const result = await triggerPayoutRun();
      if (result.ok) {
        payoutLog.info({ status: result.status }, 'payout-run triggered');
      } else {
        payoutLog.error({ status: result.status }, 'payout-run trigger failed');
      }
    } catch (err) {
      payoutLog.error({ err }, 'payout-run cron error');
    }
  });

  return [retentionJob, payoutJob];
};

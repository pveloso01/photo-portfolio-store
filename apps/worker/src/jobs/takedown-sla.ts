// F3.5 — takedown SLA alert.
//
// Hourly sweep: find takedowns with sla_due_at < now() and status NOT IN
// (fulfilled, rejected). Each overdue row produces a structured log entry the
// on-call alerting layer can match on (action='takedown.sla_breach').

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, sql } from 'drizzle-orm';

const { takedownRequests } = schema.compliance.tables;

export interface SlaBreachRow {
  id: string;
  slaDueAt: Date;
  status: string;
}

export const findOverdueTakedowns = async (
  db: DbClient,
  now: Date = new Date(),
): Promise<SlaBreachRow[]> => {
  const rows = await db
    .select({
      id: takedownRequests.id,
      slaDueAt: takedownRequests.slaDueAt,
      status: takedownRequests.status,
    })
    .from(takedownRequests)
    .where(
      and(
        sql`${takedownRequests.slaDueAt} < ${now}`,
        sql`${takedownRequests.status} not in ('fulfilled', 'rejected')`,
      ),
    );
  return rows.map((r) => ({ id: r.id, slaDueAt: r.slaDueAt, status: r.status }));
};

export interface SlaAlertResult {
  overdueCount: number;
  breaches: SlaBreachRow[];
}

export const runTakedownSlaCheck = async (
  db: DbClient,
  log: { warn: (obj: object, msg: string) => void },
  now: Date = new Date(),
): Promise<SlaAlertResult> => {
  const breaches = await findOverdueTakedowns(db, now);
  for (const row of breaches) {
    log.warn(
      {
        action: 'takedown.sla_breach',
        takedownId: row.id,
        slaDueAt: row.slaDueAt.toISOString(),
        status: row.status,
        breachedBySeconds: Math.floor((now.getTime() - row.slaDueAt.getTime()) / 1000),
      },
      'takedown SLA breached',
    );
  }
  return { overdueCount: breaches.length, breaches };
};

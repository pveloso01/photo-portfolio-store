// F3.11 — async audit-log CSV export.
//
// POST creates an audit_exports row (pending) and kicks the export; the job
// queries audit_log with the saved filters, writes a CSV to R2, and flips the
// row to ready with a file_key + expiry. GET returns status + a signed download
// URL when ready. Both the initiation and the download are themselves audited.
//
// The API has no BullMQ; the export runs inline within the request via
// runExport (kept separate so a future worker can call the same function). For
// the >1M-row cap the export aborts with status=failed.

import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, desc, eq, gte, lte } from 'drizzle-orm';

import { writeAudit } from '../lib/audit.js';
import { buckets as defaultBuckets, s3 as defaultS3 } from '../lib/storage.js';

const { auditExports, auditLog } = schema.compliance.tables;

export const MAX_EXPORT_ROWS = 1_000_000;
const DOWNLOAD_TTL_MS = 60 * 60 * 1000; // 1h
const CSV_SCHEMA_VERSION = '1';

export interface AuditExportFilters {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface ExportDeps {
  s3?: Pick<typeof defaultS3, 'send'>;
  buckets?: { originals: string; derivatives: string };
  signUrl?: (key: string) => Promise<string>;
  now?: () => Date;
}

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const buildWhere = (f: AuditExportFilters) => {
  const conds = [];
  if (f.from) conds.push(gte(auditLog.createdAt, new Date(f.from)));
  if (f.to) conds.push(lte(auditLog.createdAt, new Date(f.to)));
  if (f.actorId) conds.push(eq(auditLog.actorUserId, f.actorId));
  if (f.action) conds.push(eq(auditLog.action, f.action));
  if (f.targetType) conds.push(eq(auditLog.targetKind, f.targetType));
  if (f.targetId) conds.push(eq(auditLog.targetId, f.targetId));
  return conds.length > 0 ? and(...conds) : undefined;
};

export const createExport = async (
  db: DbClient,
  filters: AuditExportFilters,
  ctx: { adminUserId: string },
): Promise<{ jobId: string }> => {
  const rows = await db
    .insert(auditExports)
    .values({ requestedBy: ctx.adminUserId, filters, status: 'pending' })
    .returning({ id: auditExports.id });
  const job = rows[0];
  if (!job) throw new Error('audit-export: insert returned no row');

  await writeAudit(db, {
    action: 'audit.export.requested',
    actorKind: 'user',
    actorUserId: ctx.adminUserId,
    targetKind: 'audit_export',
    targetId: job.id,
    payload: { filters },
  });

  return { jobId: job.id };
};

// Runs the export end-to-end. Inline today; a worker could call this later.
export const runExport = async (
  db: DbClient,
  jobId: string,
  deps: ExportDeps = {},
): Promise<void> => {
  const s3 = deps.s3 ?? defaultS3;
  const bucketCfg = deps.buckets ?? defaultBuckets;
  const now = deps.now ?? (() => new Date());

  const jobRows = await db
    .select({ id: auditExports.id, filters: auditExports.filters })
    .from(auditExports)
    .where(eq(auditExports.id, jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) return;

  await db.update(auditExports).set({ status: 'running' }).where(eq(auditExports.id, jobId));

  try {
    const filters = (job.filters ?? {}) as AuditExportFilters;
    const where = buildWhere(filters);
    const base = db
      .select({
        id: auditLog.id,
        actorUserId: auditLog.actorUserId,
        actorKind: auditLog.actorKind,
        action: auditLog.action,
        targetKind: auditLog.targetKind,
        targetId: auditLog.targetId,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog);
    const rows = await (where ? base.where(where) : base).orderBy(desc(auditLog.createdAt));

    if (rows.length > MAX_EXPORT_ROWS) {
      await db.update(auditExports).set({ status: 'failed' }).where(eq(auditExports.id, jobId));
      return;
    }

    const header = `# schema_version=${CSV_SCHEMA_VERSION}`;
    const cols = 'id,actor_user_id,actor_kind,action,target_kind,target_id,created_at';
    const body = rows.map((r) =>
      [
        r.id,
        r.actorUserId,
        r.actorKind,
        r.action,
        r.targetKind,
        r.targetId,
        r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      ]
        .map(csvEscape)
        .join(','),
    );
    const csv = [header, cols, ...body].join('\n');

    const fileKey = `audit-exports/${jobId}.csv`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketCfg.originals,
        Key: fileKey,
        Body: csv,
        ContentType: 'text/csv',
      }) as never,
    );

    const expiresAt = new Date(now().getTime() + DOWNLOAD_TTL_MS);
    await db
      .update(auditExports)
      .set({ status: 'ready', rowCount: rows.length, fileKey, expiresAt })
      .where(eq(auditExports.id, jobId));
  } catch {
    await db.update(auditExports).set({ status: 'failed' }).where(eq(auditExports.id, jobId));
  }
};

export interface ExportStatus {
  status: string;
  rowCount: number | null;
  downloadUrl?: string;
}

export const getExportStatus = async (
  db: DbClient,
  jobId: string,
  ctx: { adminUserId: string },
  deps: ExportDeps = {},
): Promise<ExportStatus | null> => {
  const rows = await db
    .select({
      id: auditExports.id,
      status: auditExports.status,
      rowCount: auditExports.rowCount,
      fileKey: auditExports.fileKey,
    })
    .from(auditExports)
    .where(eq(auditExports.id, jobId))
    .limit(1);
  const job = rows[0];
  if (!job) return null;

  const result: ExportStatus = { status: job.status, rowCount: job.rowCount ?? null };
  if (job.status === 'ready' && job.fileKey) {
    const sign = deps.signUrl ?? (async (key: string) => `https://files.local/${key}`);
    result.downloadUrl = await sign(job.fileKey);
    await writeAudit(db, {
      action: 'audit.export.downloaded',
      actorKind: 'user',
      actorUserId: ctx.adminUserId,
      targetKind: 'audit_export',
      targetId: jobId,
    });
  }
  return result;
};

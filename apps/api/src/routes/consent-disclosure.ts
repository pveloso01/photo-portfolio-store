// F3.8 — statutory disclosure text endpoint.
//
// GET /v1/consents/biometric/disclosure?jurisdiction=&locale= — anonymous.
// Returns the active disclosure document the subject must read+sign before a
// BIPA-covered enrollment proceeds. Backed by consent_policy_versions
// (existing M1 table; one row per version+locale, scoped by jurisdiction).

import type { DbClient } from '@pkg/db';
import { schema } from '@pkg/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { db as defaultDb } from '../lib/db.js';

const { consentPolicyVersions } = schema.compliance.tables;

const querySchema = z.object({
  jurisdiction: z.enum(['eu_gdpr', 'br_lgpd', 'us_bipa', 'us_ccpa', 'other']).optional(),
  locale: z.string().min(2).max(16).optional(),
});

export interface ConsentDisclosureOptions {
  db?: DbClient;
}

const consentDisclosureRoutes = async (
  app: FastifyInstance,
  opts: ConsentDisclosureOptions = {},
): Promise<void> => {
  const db = opts.db ?? defaultDb;

  app.get('/v1/consents/biometric/disclosure', async (request, reply) => {
    const q = querySchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const jurisdiction = q.data.jurisdiction ?? 'us_bipa';
    const locale = q.data.locale ?? 'en-US';

    const rows = await db
      .select({
        version: consentPolicyVersions.version,
        locale: consentPolicyVersions.locale,
        title: consentPolicyVersions.title,
        bodyMarkdown: consentPolicyVersions.bodyMarkdown,
        jurisdiction: consentPolicyVersions.jurisdiction,
      })
      .from(consentPolicyVersions)
      .where(
        and(
          eq(consentPolicyVersions.jurisdiction, jurisdiction),
          eq(consentPolicyVersions.locale, locale),
          eq(consentPolicyVersions.isActive, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(row);
  });
};

export default consentDisclosureRoutes;

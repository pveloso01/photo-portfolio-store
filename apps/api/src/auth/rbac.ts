// RBAC plugin — declarative role + resource-scoped permission middleware.
//
// Contract with the auth plugin (F1.4):
//   - The auth plugin verifies the access token and decorates `request.user`
//     with `{ id: string; role: UserRole }` before any route handler runs.
//   - A missing or invalid token => 401 from the auth layer.
//   - A valid token whose role/permission does not cover the resource => 403
//     from this layer, with `audit_log(action='rbac.denied', ...)`.
//
// Hot path: role-only checks are O(1) (in-process map). Event-scoped checks
// do at most one DB query, memoized per-request.
//
// Deny-by-default: `assertAllRoutesProtected(app)` walks the route table at
// boot and throws if a non-exempt route lacks a `requirePermission` preHandler.

import { and, eq } from 'drizzle-orm';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';

import { schema } from '@pkg/db';

import { db as defaultDb } from '../lib/db.js';
import type { Permission } from './permissions.js';
import {
  EVENT_MEMBER_PERMISSIONS,
  type EventMemberRole,
  ROLE_PERMISSIONS,
  type UserRole,
} from './role-permissions.js';

// ---------- Types ----------

export type ResourceKind = 'event' | 'org';

export interface Resource {
  kind: ResourceKind;
  id: string;
}

export type ResourceResolver = (req: FastifyRequest) => Resource | undefined;

export interface RequirePermissionOptions {
  resource?: Resource | ResourceResolver;
}

export interface RbacPluginOptions {
  // Allow tests to inject a stub DB client.
  db?: typeof defaultDb;
  // Routes exempted from deny-by-default at startup.
  exemptRoutes?: ReadonlyArray<RegExp>;
}

declare module 'fastify' {
  interface FastifyRequest {
    // Set by the auth plugin. Optional here so this file does not assume
    // auth has registered yet; runtime checks enforce presence. `email` is
    // present only when the auth layer carries it (self-service routes use it
    // for confirmation mail + anonymous-grant email matching).
    user?: { id: string; role: UserRole; email?: string };
    // Populated by this plugin on first access for the current request.
    permissions?: ReadonlyArray<Permission>;
    // Per-request memo of event-member lookups.
    _eventMemberCache?: Map<string, EventMemberRole | null>;
    // Tracks which route declared a permission. Used by the startup audit
    // (`assertAllRoutesProtected`).
    _rbacDeclared?: boolean;
  }

  interface FastifyContextConfig {
    rbacPermission?: Permission;
  }

  interface FastifyInstance {
    requirePermission: (perm: Permission, opts?: RequirePermissionOptions) => preHandlerHookHandler;
  }
}

// ---------- Default exempt routes ----------

const DEFAULT_EXEMPT: ReadonlyArray<RegExp> = [
  /^\/health$/,
  /^\/$/,
  /^\/v1\/auth\//,
  /^\/docs(\/|$)/,
  /^\/openapi(\.json)?$/,
  // F1.33 — biometric consent endpoints are anonymous-allowed and gated by
  // their own consent + event checks, not RBAC.
  /^\/v1\/consents\/biometric(\/.*)?$/,
  // F1.24 — face search is anonymous-allowed and gated by biometric consent.
  /^\/v1\/events\/[^/]+\/search\/face$/,
  // M2 F2.4/F2.5 — storefront pricing (tier listing + price quote) is public.
  /^\/v1\/pricing\/tiers$/,
  /^\/v1\/pricing\/evaluate$/,
  // M2 F2.2/F2.3 — bundle resolve + foto-flat summary are public storefront
  // reads. Organizer bundle creation (POST /v1/events/:id/bundles) is RBAC-gated.
  /^\/v1\/bundles\/[^/]+\/resolve$/,
  /^\/v1\/events\/[^/]+\/foto-flat$/,
  // M2 F2.6 — order read + refund request are owner-gated within the handler
  // (RBAC permissions do not model per-order ownership), like the downloads route.
  /^\/v1\/orders\/[^/]+$/,
  /^\/v1\/orders\/[^/]+\/refund-request$/,
  // M2 F2.9 — Stripe Connect self-service routes; owner = request.user.
  /^\/v1\/me\/kyc\/(start|status)$/,
  // M2 F2.13 — payout dashboard self-service routes; owner = request.user.
  /^\/v1\/me\/payouts(\/.*)?$/,
  // M3 F3.10 — photographer analytics self-service routes; owner = request.user.
  /^\/v1\/me\/photographer\/stats(\.csv)?$/,
  // M2 F2.12 — internal cron-trigger; machine-to-machine, secret-gated (not RBAC).
  /^\/v1\/internal\/payouts\/run$/,
  // M3 F3.4 — public takedown submission/verify/status; anonymous-allowed,
  // token-gated within the handler (not RBAC).
  /^\/v1\/takedowns(\/.*)?$/,
  // M3 F3.6 — right-to-know self-service route; owner = request.user.
  /^\/v1\/me\/biometric-data$/,
  // M3 F3.8 — statutory disclosure text; public read.
  /^\/v1\/consents\/biometric\/disclosure$/,
];

// ---------- Helpers ----------

const ensurePermissions = (req: FastifyRequest): ReadonlyArray<Permission> => {
  if (req.permissions) return req.permissions;
  const role = req.user?.role;
  const perms = role ? ROLE_PERMISSIONS[role] : [];
  req.permissions = perms;
  return perms;
};

interface DenyContext {
  request: FastifyRequest;
  perm: Permission;
  resource?: Resource;
  reason: string;
}

const writeAuditDenied = async (db: typeof defaultDb, ctx: DenyContext): Promise<void> => {
  const { request, perm, resource, reason } = ctx;
  try {
    await db.insert(schema.compliance.auditLog).values({
      actorUserId: request.user?.id ?? null,
      actorKind: 'user',
      action: 'rbac.denied',
      targetKind: resource?.kind ?? null,
      targetId: resource?.id ?? null,
      eventId: resource?.kind === 'event' ? resource.id : null,
      userAgent: request.headers['user-agent'] ?? null,
      payloadJsonb: {
        required_perm: perm,
        user_role: request.user?.role ?? null,
        route: `${request.method} ${request.routeOptions?.url ?? request.url}`,
        reason,
      },
    });
  } catch (err) {
    // Audit failure must never mask the original 403; log and continue.
    request.log.error({ err }, 'rbac: failed to write audit_log');
  }
};

const denyResponse = (reply: FastifyReply, message: string): FastifyReply =>
  reply.code(403).send({ statusCode: 403, error: 'Forbidden', message });

const unauthorized = (reply: FastifyReply): FastifyReply =>
  reply
    .code(401)
    .send({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });

// Resolve event-member role for (user, event) with per-request memoization.
const getEventMemberRole = async (
  db: typeof defaultDb,
  request: FastifyRequest,
  eventId: string,
): Promise<EventMemberRole | null> => {
  if (!request.user) return null;
  if (!request._eventMemberCache) request._eventMemberCache = new Map();
  const cache = request._eventMemberCache;
  if (cache.has(eventId)) return cache.get(eventId) ?? null;

  const rows = await db
    .select({ role: schema.events.eventMembers.role })
    .from(schema.events.eventMembers)
    .where(
      and(
        eq(schema.events.eventMembers.eventId, eventId),
        eq(schema.events.eventMembers.userId, request.user.id),
      ),
    )
    .limit(1);

  const role = (rows[0]?.role as EventMemberRole | undefined) ?? null;
  cache.set(eventId, role);
  return role;
};

// Resolve org admin status for a given event (used to grant cross-event
// access for org admins). Looks up the event's orgId, then checks
// organization_members for an owner/admin row.
const isOrgAdminOfEvent = async (
  db: typeof defaultDb,
  request: FastifyRequest,
  eventId: string,
): Promise<boolean> => {
  if (!request.user) return false;

  const evRows = await db
    .select({ orgId: schema.events.events.orgId })
    .from(schema.events.events)
    .where(eq(schema.events.events.id, eventId))
    .limit(1);
  const orgId = evRows[0]?.orgId;
  if (!orgId) return false;

  const memberRows = await db
    .select({ role: schema.users.organizationMembers.role })
    .from(schema.users.organizationMembers)
    .where(
      and(
        eq(schema.users.organizationMembers.orgId, orgId),
        eq(schema.users.organizationMembers.userId, request.user.id),
      ),
    )
    .limit(1);

  const role = memberRows[0]?.role;
  return role === 'owner' || role === 'admin';
};

const isOrgAdminOfOrg = async (
  db: typeof defaultDb,
  request: FastifyRequest,
  orgId: string,
): Promise<boolean> => {
  if (!request.user) return false;
  const memberRows = await db
    .select({ role: schema.users.organizationMembers.role })
    .from(schema.users.organizationMembers)
    .where(
      and(
        eq(schema.users.organizationMembers.orgId, orgId),
        eq(schema.users.organizationMembers.userId, request.user.id),
      ),
    )
    .limit(1);
  const role = memberRows[0]?.role;
  return role === 'owner' || role === 'admin';
};

// ---------- Public: programmatic permission check ----------

export interface CheckPermissionOptions {
  resource?: Resource;
  db?: typeof defaultDb;
}

export const checkPermission = async (
  request: FastifyRequest,
  perm: Permission,
  opts: CheckPermissionOptions = {},
): Promise<boolean> => {
  if (!request.user) return false;
  const db = opts.db ?? defaultDb;

  // Superadmin shortcut.
  if (request.user.role === 'superadmin') return true;

  const rolePerms = ensurePermissions(request);
  const hasRolePerm = rolePerms.includes(perm);

  // Role-only check.
  if (!opts.resource) return hasRolePerm;

  // Resource-scoped check.
  const { resource } = opts;

  if (resource.kind === 'event') {
    // 1. Org admin of the event's org -> allow.
    if (await isOrgAdminOfEvent(db, request, resource.id)) return true;

    // 2. Event member with sufficient event-role permission -> allow.
    const memberRole = await getEventMemberRole(db, request, resource.id);
    if (memberRole && EVENT_MEMBER_PERMISSIONS[memberRole].includes(perm)) {
      return true;
    }

    // 3. Fall back to role baseline only for read-only event permissions
    //    on published events would require a separate query; we conservatively
    //    require either org-admin or event-member for scoped event checks.
    //    Baseline read-only access is intentionally NOT granted here to
    //    prevent cross-org IDOR (see issue #24 acceptance criteria).
    return false;
  }

  if (resource.kind === 'org') {
    if (await isOrgAdminOfOrg(db, request, resource.id)) {
      // Org admin/owner gets every org-level permission they'd otherwise
      // need plus event permissions on that org's events.
      return true;
    }
    return hasRolePerm;
  }

  return false;
};

// ---------- Plugin ----------

// Tag attached to handlers returned by `requirePermission`. Used by the
// startup audit to confirm coverage.
const RBAC_TAG = Symbol.for('rbac.requirePermission');

const rbacPlugin: FastifyPluginAsync<RbacPluginOptions> = async (app, opts) => {
  const db = opts.db ?? defaultDb;

  // Decorate `request.permissions` lazily.
  app.addHook('onRequest', async (request) => {
    if (request.user) ensurePermissions(request);
  });

  app.decorate(
    'requirePermission',
    function requirePermission(
      perm: Permission,
      options: RequirePermissionOptions = {},
    ): preHandlerHookHandler {
      const handler: preHandlerHookHandler = async (request, reply) => {
        if (!request.user) {
          return unauthorized(reply);
        }

        let resource: Resource | undefined;
        if (options.resource) {
          resource =
            typeof options.resource === 'function' ? options.resource(request) : options.resource;
        }

        const allowed = await checkPermission(request, perm, { resource, db });
        if (allowed) return;

        await writeAuditDenied(db, {
          request,
          perm,
          resource,
          reason: resource
            ? `user lacks ${perm} on ${resource.kind}:${resource.id}`
            : `user lacks ${perm}`,
        });
        return denyResponse(reply, `Missing permission: ${perm}`);
      };
      // Tag the handler so onRoute can confirm coverage.
      (handler as unknown as Record<symbol, unknown>)[RBAC_TAG] = perm;
      return handler;
    },
  );
};

export default fp(rbacPlugin, {
  name: 'rbac',
  fastify: '5.x',
});

// ---------- Startup audit ----------

interface RouteRow {
  method: string;
  url: string;
  protected: boolean;
}

const collectRoutes = (app: FastifyInstance): RouteRow[] => {
  const rows: RouteRow[] = [];
  app.addHook('onRoute', (route) => {
    const preHandlers = Array.isArray(route.preHandler)
      ? route.preHandler
      : route.preHandler
        ? [route.preHandler]
        : [];
    const isProtected = preHandlers.some(
      (h) => h && (h as unknown as Record<symbol, unknown>)[RBAC_TAG] !== undefined,
    );
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      rows.push({ method: String(m), url: route.url, protected: isProtected });
    }
  });
  return rows;
};

export const assertAllRoutesProtected = (
  _app: FastifyInstance,
  options: { exempt?: ReadonlyArray<RegExp>; routes?: ReadonlyArray<RouteRow> } = {},
): void => {
  const exempt = [...(options.exempt ?? []), ...DEFAULT_EXEMPT];
  // If caller supplied a pre-collected route list (from an onRoute hook
  // registered before routes were declared), use it. Otherwise we cannot
  // retroactively read protection info from `printRoutes()`.
  const routes = options.routes;
  if (!routes) {
    throw new Error(
      'assertAllRoutesProtected requires a routes[] snapshot collected via collectRouteCoverage().',
    );
  }
  const unprotected = routes.filter((r) => !r.protected && !exempt.some((rx) => rx.test(r.url)));
  if (unprotected.length > 0) {
    const list = unprotected.map((r) => `  - ${r.method} ${r.url}`).join('\n');
    throw new Error(
      `RBAC startup check failed: the following routes have no permission declaration:\n${list}\nEach protected route MUST attach a preHandler returned by app.requirePermission().`,
    );
  }
};

// Helper that wires `onRoute` collection. Register this BEFORE declaring any
// routes; pass the returned snapshot to `assertAllRoutesProtected` after
// `app.ready()`.
export const collectRouteCoverage = (app: FastifyInstance): RouteRow[] => collectRoutes(app);

export { RBAC_TAG };

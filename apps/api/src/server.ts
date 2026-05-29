import sensible from '@fastify/sensible';
import * as Sentry from '@sentry/node';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import rbacPlugin from './auth/rbac.js';
import { db } from './lib/db.js';
import swaggerPlugin from './plugins/swagger.js';
import adminAuditExportRoutes from './routes/admin/audit-export.js';
import adminAuditRoutes from './routes/admin/audit.js';
import adminHealthRoutes from './routes/admin/health.js';
import adminModerationRoutes from './routes/admin/moderation.js';
import adminOrderSplitsRoutes from './routes/admin/order-splits.js';
import adminPayoutRetryRoutes from './routes/admin/payout-retry.js';
import adminRefundsRoutes from './routes/admin/refunds.js';
import adminTakedownRoutes from './routes/admin/takedowns.js';
import authPasswordlessRoutes from './routes/auth-passwordless.js';
import authRoutes from './routes/auth.js';
import bundlesRoutes from './routes/bundles.js';
import cartRoutes from './routes/cart.js';
import checkoutRoutes from './routes/checkout.js';
import consentDisclosureRoutes from './routes/consent-disclosure.js';
import consentRoutes from './routes/consents.js';
import downloadsRoutes from './routes/downloads.js';
import eventStatsRoutes from './routes/event-stats.js';
import eventsRoutes from './routes/events.js';
import internalPayoutsRoutes from './routes/internal/payouts.js';
import meBiometricDataRoutes from './routes/me-biometric-data.js';
import meKycRoutes from './routes/me-kyc.js';
import mePayoutsRoutes from './routes/me-payouts.js';
import mePhotographerRoutes from './routes/me-photographer.js';
import pricingRoutes from './routes/pricing.js';
import productsRoutes from './routes/products.js';
import refundsRoutes from './routes/refunds.js';
import searchFaceRoutes from './routes/search-face.js';
import searchRoutes from './routes/search.js';
import takedownRoutes from './routes/takedowns.js';
import uploadsRoutes from './routes/uploads.js';
import stripeWebhookRoutes from './routes/webhooks-stripe.js';
import { seedPlatformLedgerAccounts } from './services/ledger.js';
import { seedDefaultLicenseTiers } from './services/products.js';

export const buildServer = async (): Promise<FastifyInstance> => {
  const logLevel = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV === 'development';

  const opts: FastifyServerOptions = isDev
    ? {
        logger: {
          level: logLevel,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        },
        disableRequestLogging: false,
      }
    : {
        logger: { level: logLevel },
        disableRequestLogging: false,
      };

  const app = Fastify(opts);

  await app.register(sensible);

  if (process.env.SENTRY_DSN) {
    Sentry.setupFastifyErrorHandler(app);
  }

  // RBAC must register before any protected routes so app.requirePermission is decorated.
  await app.register(rbacPlugin);

  // Swagger UI (dev or when explicitly enabled).
  if (isDev || process.env.SWAGGER_UI_ENABLED === 'true') {
    await app.register(swaggerPlugin);
  }

  // Idempotent seed (license tiers). Skipped in test env to keep test boot fast.
  if (process.env.NODE_ENV !== 'test') {
    try {
      await seedDefaultLicenseTiers(db);
    } catch (err) {
      app.log.warn({ err }, 'license tier seed failed — continuing');
    }
    try {
      await seedPlatformLedgerAccounts(db);
    } catch (err) {
      app.log.warn({ err }, 'platform ledger account seed failed — continuing');
    }
  }

  // Routes
  await app.register(authRoutes);
  await app.register(authPasswordlessRoutes);
  await app.register(eventsRoutes);
  await app.register(productsRoutes);
  await app.register(uploadsRoutes);
  await app.register(searchRoutes);
  await app.register(cartRoutes);
  // F1.33 + F1.24 — biometric consent gate + selfie face search. Both
  // anonymous-allowed and exempt from the RBAC startup check (they have
  // their own consent/event gating, not RBAC).
  await app.register(consentRoutes);
  await app.register(searchFaceRoutes);
  // M3 F3.8 — statutory biometric disclosure text (public read).
  await app.register(consentDisclosureRoutes);
  // F1.29 / F1.30 / F1.31 — Stripe checkout, webhook receiver, download delivery.
  await app.register(checkoutRoutes);
  await app.register(stripeWebhookRoutes);
  await app.register(downloadsRoutes);
  // M2 F2.4/F2.5 — public storefront pricing: tier multipliers + price quote.
  await app.register(pricingRoutes);
  // M2 F2.2/F2.3 — bundle resolve + foto-flat (public) and organizer bundle
  // creation (RBAC-gated within the plugin).
  await app.register(bundlesRoutes);
  // M2 F2.6 — buyer self-service refund requests (owner-gated within handler).
  await app.register(refundsRoutes);
  // M2 F2.9 — Stripe Connect onboarding (self-service "me" routes).
  await app.register(meKycRoutes);
  // M2 F2.13 — photographer payout dashboard (self-service "me" routes).
  await app.register(mePayoutsRoutes);
  // M3 F3.10 — photographer dashboard analytics (self-service "me" routes).
  await app.register(mePhotographerRoutes);
  // M3 F3.9 — organizer event analytics (event-scoped commerce:read_orders).
  await app.register(eventStatsRoutes);
  // M2 F2.10 — admin order split view. M2 F2.7 — admin refund decision.
  // M2 F2.12 — admin payout retry.
  await app.register(adminOrderSplitsRoutes);
  await app.register(adminRefundsRoutes);
  await app.register(adminPayoutRetryRoutes);
  await app.register(adminAuditRoutes);
  // M3 F3.1 — admin health. F3.2 — moderation queue. F3.11 — audit export.
  await app.register(adminHealthRoutes);
  await app.register(adminModerationRoutes);
  await app.register(adminAuditExportRoutes);
  // M3 F3.4 — public takedown submission/verify/status (anonymous, token-gated).
  await app.register(takedownRoutes);
  // M3 F3.5 — admin takedown queue + fulfill/reject (admin:moderate).
  await app.register(adminTakedownRoutes);
  // M3 F3.6 — right-to-know self-service biometric data export (owner-gated).
  await app.register(meBiometricDataRoutes);
  // M2 F2.12 — internal cron-trigger for the weekly payout run (secret-gated).
  await app.register(internalPayoutsRoutes);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/', async () => ({ name: 'photo-portfolio-store api', ok: true }));

  return app;
};

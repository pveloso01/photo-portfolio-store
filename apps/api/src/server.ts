import sensible from '@fastify/sensible';
import * as Sentry from '@sentry/node';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import rbacPlugin from './auth/rbac.js';
import { db } from './lib/db.js';
import swaggerPlugin from './plugins/swagger.js';
import adminAuditRoutes from './routes/admin/audit.js';
import authPasswordlessRoutes from './routes/auth-passwordless.js';
import authRoutes from './routes/auth.js';
import cartRoutes from './routes/cart.js';
import checkoutRoutes from './routes/checkout.js';
import consentRoutes from './routes/consents.js';
import downloadsRoutes from './routes/downloads.js';
import eventsRoutes from './routes/events.js';
import productsRoutes from './routes/products.js';
import searchFaceRoutes from './routes/search-face.js';
import searchRoutes from './routes/search.js';
import uploadsRoutes from './routes/uploads.js';
import stripeWebhookRoutes from './routes/webhooks-stripe.js';
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
  // F1.29 / F1.30 / F1.31 — Stripe checkout, webhook receiver, download delivery.
  await app.register(checkoutRoutes);
  await app.register(stripeWebhookRoutes);
  await app.register(downloadsRoutes);
  await app.register(adminAuditRoutes);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/', async () => ({ name: 'photo-portfolio-store api', ok: true }));

  return app;
};

// Shared Stripe client. Created here so F1.29 (checkout), F1.30 (webhooks),
// and F1.31 (download fulfillment) all share a single configured SDK instance.
// Keep this surface minimal and additive — multiple agents depend on it.

import { parseEnv, z } from '@pkg/env';
import Stripe from 'stripe';

const stripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
});

const stripeEnv = parseEnv(stripeEnvSchema);

export const stripe = new Stripe(stripeEnv.STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia',
  typescript: true,
});

export const webhookSecret = stripeEnv.STRIPE_WEBHOOK_SECRET;

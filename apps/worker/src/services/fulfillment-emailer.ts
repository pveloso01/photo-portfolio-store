// F1.31 — buyer-facing email for completed digital fulfillment.
//
// Selection order mirrors apps/api/src/lib/email.ts:
//   1. SMTP_URL set                       → nodemailer SMTP transport
//   2. RESEND_API_KEY set (NODE_ENV=prod) → Resend HTTP API
//   3. RESEND_API_KEY set                 → Resend HTTP API
//   4. neither                            → dev fallback: log a warning, do nothing.
//
// The function NEVER throws on send failure; callers (the worker) treat email
// as best-effort. A separate cron (M2) is responsible for re-send.

import { logger } from '../lib/logger.js';

export interface FulfillmentEmailInput {
  to: string;
  eventName: string;
  eventTimezone: string;
  downloadUrl: string;
  expiresAt: Date;
  itemCount: number;
}

export interface SendFulfillmentEmailResult {
  sent: boolean;
  via: 'smtp' | 'resend' | 'noop';
  error?: string;
}

const DEFAULT_FROM = (): string => process.env.MAIL_FROM ?? 'no-reply@example.com';

const formatExpiry = (expiresAt: Date, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(expiresAt);
  } catch {
    // Bad timezone string — fall back to ISO.
    return expiresAt.toISOString();
  }
};

export const buildSubject = (input: FulfillmentEmailInput): string =>
  `Your photos from ${input.eventName} are ready`;

export const buildHtmlBody = (input: FulfillmentEmailInput): string => {
  const expiry = formatExpiry(input.expiresAt, input.eventTimezone);
  return [
    '<p>Hi,</p>',
    `<p>Your ${input.itemCount} photo${input.itemCount === 1 ? '' : 's'} from <strong>${input.eventName}</strong> are ready to download.</p>`,
    `<p><a href="${input.downloadUrl}">Download your photos</a></p>`,
    `<p>The link expires on <strong>${expiry}</strong> (${input.eventTimezone}).</p>`,
    '<p>The download is a single zip archive containing the full-resolution JPEGs for every photo on your order.</p>',
    '<p>Thanks!</p>',
  ].join('\n');
};

export const buildTextBody = (input: FulfillmentEmailInput): string => {
  const expiry = formatExpiry(input.expiresAt, input.eventTimezone);
  return [
    'Hi,',
    '',
    `Your ${input.itemCount} photo${input.itemCount === 1 ? '' : 's'} from ${input.eventName} are ready to download.`,
    '',
    `Download: ${input.downloadUrl}`,
    '',
    `The link expires on ${expiry} (${input.eventTimezone}).`,
    '',
    'The download is a single zip archive containing the full-resolution JPEGs for every photo on your order.',
    '',
    'Thanks!',
  ].join('\n');
};

const sendViaSmtp = async (smtpUrl: string, input: FulfillmentEmailInput): Promise<void> => {
  const nodemailerModule = (await import('nodemailer')) as {
    default?: typeof import('nodemailer');
  } & typeof import('nodemailer');
  const nodemailer = nodemailerModule.default ?? nodemailerModule;
  const transport = nodemailer.createTransport(smtpUrl);
  await transport.sendMail({
    from: DEFAULT_FROM(),
    to: input.to,
    subject: buildSubject(input),
    text: buildTextBody(input),
    html: buildHtmlBody(input),
  });
};

const sendViaResend = async (apiKey: string, input: FulfillmentEmailInput): Promise<void> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: DEFAULT_FROM(),
      to: [input.to],
      subject: buildSubject(input),
      html: buildHtmlBody(input),
      text: buildTextBody(input),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
};

export const sendFulfillmentEmail = async (
  input: FulfillmentEmailInput,
): Promise<SendFulfillmentEmailResult> => {
  const resendKey = process.env.RESEND_API_KEY;
  const smtpUrl = process.env.SMTP_URL;

  try {
    if (resendKey && process.env.NODE_ENV === 'production') {
      await sendViaResend(resendKey, input);
      return { sent: true, via: 'resend' };
    }
    if (smtpUrl) {
      await sendViaSmtp(smtpUrl, input);
      return { sent: true, via: 'smtp' };
    }
    if (resendKey) {
      await sendViaResend(resendKey, input);
      return { sent: true, via: 'resend' };
    }
    logger.warn(
      { to: input.to, subject: buildSubject(input) },
      'fulfillment email: no transport configured — skipping send',
    );
    return { sent: false, via: 'noop' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ to: input.to, err: message }, 'fulfillment email send failed');
    return { sent: false, via: smtpUrl ? 'smtp' : 'resend', error: message };
  }
};

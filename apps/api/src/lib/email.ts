// Minimal transactional email sender.
//
// Selection order:
//   1. SMTP_URL set            → nodemailer SMTP transport (Mailpit, etc.)
//   2. RESEND_API_KEY set      → Resend HTTP API
//   3. neither                 → development fallback: log a warning, do nothing.
//
// In all cases the function resolves; it never throws on send failure for
// development-mode missing config. Real send errors are logged and rethrown
// only when a transport is explicitly configured.

export interface SendMailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
}

const getDefaultFrom = (): string => process.env.MAIL_FROM ?? 'no-reply@example.com';

const sendViaSmtp = async (smtpUrl: string, params: SendMailParams): Promise<void> => {
  // Dynamic import keeps nodemailer optional at install-time for environments
  // that only use Resend.
  const nodemailerModule = (await import('nodemailer')) as {
    default?: typeof import('nodemailer');
  } & typeof import('nodemailer');
  const nodemailer = nodemailerModule.default ?? nodemailerModule;
  const transport = nodemailer.createTransport(smtpUrl);
  await transport.sendMail({
    from: params.from ?? getDefaultFrom(),
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });
};

const sendViaResend = async (apiKey: string, params: SendMailParams): Promise<void> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: params.from ?? getDefaultFrom(),
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
};

export const sendMail = async (params: SendMailParams): Promise<void> => {
  const resendKey = process.env.RESEND_API_KEY;
  const smtpUrl = process.env.SMTP_URL;

  // Resend preferred in production.
  if (resendKey && process.env.NODE_ENV === 'production') {
    await sendViaResend(resendKey, params);
    return;
  }
  if (smtpUrl) {
    await sendViaSmtp(smtpUrl, params);
    return;
  }
  if (resendKey) {
    await sendViaResend(resendKey, params);
    return;
  }
  // Development fallback: do NOT throw, do NOT leak the body to logs.
  // eslint-disable-next-line no-console
  console.warn('[email] no SMTP_URL or RESEND_API_KEY configured — skipping send', {
    to: params.to,
    subject: params.subject,
  });
};

import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import type { MailMessage, MailOutcome } from './mail.js';

/**
 * SMTP sending. Works with any provider - SendGrid, Brevo, Mailgun, Postmark,
 * Gmail with an app password, a personal Outlook.com account - so the app is
 * not tied to one vendor and the credentials can be swapped at any time.
 */

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
      tls: { rejectUnauthorized: env.smtp.rejectUnauthorized },
    });
  }
  return transporter;
}

/** Used by the Settings screen's "Send a test email" button. */
export async function verifyConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explain(err) };
  }
}

/**
 * Node's network errors name the syscall, not the mistake. Translate the ones
 * a misconfiguration actually produces into something a coordinator can act on.
 */
export function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string; responseCode?: number })?.code ?? '';
  const responseCode = (err as { responseCode?: number })?.responseCode;

  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return `Cannot find the mail server "${env.smtp.host}" — check SMTP_HOST is spelled correctly (for example smtp.gmail.com, not smtp-gmail.com). [${raw}]`;
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return `The mail server "${env.smtp.host}" did not accept a connection on port ${env.smtp.port} — check SMTP_PORT (587 for most providers, 465 for implicit TLS). [${raw}]`;
  }
  if (code === 'EAUTH' || responseCode === 535) {
    return `The mail server rejected the username or password — check SMTP_USER and SMTP_PASS. For Gmail this must be a 16-character app password with the spaces removed, not your account password. [${raw}]`;
  }
  if (responseCode === 550 || responseCode === 553) {
    return `The mail server refused the sender "${env.email.from}" — it usually has to be verified with the provider first. [${raw}]`;
  }
  return raw;
}

export async function sendViaSmtp(message: MailMessage): Promise<MailOutcome> {
  try {
    const from = env.email.from || env.smtp.user;
    await getTransporter().sendMail({
      from: env.email.fromName ? `"${env.email.fromName}" <${from}>` : from,
      to: message.to.join(', '),
      replyTo: env.email.replyTo || undefined,
      subject: message.subject,
      html: message.html,
      attachments: (message.attachments ?? []).map((a) => ({
        filename: a.name,
        contentType: a.contentType,
        content: Buffer.from(a.contentBytes, 'base64'),
      })),
    });
    return { status: 'SENT' };
  } catch (err) {
    return { status: 'FAILED', error: explain(err) };
  }
}

/** Reset between config changes, so new credentials take effect immediately. */
export function resetTransport(): void {
  transporter = null;
}

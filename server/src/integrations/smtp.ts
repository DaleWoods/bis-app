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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reset between config changes, so new credentials take effect immediately. */
export function resetTransport(): void {
  transporter = null;
}

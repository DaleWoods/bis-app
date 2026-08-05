import { env } from '../config/env.js';

/**
 * Provider-agnostic mail façade (§12.2). The rest of the app calls sendMail and
 * never learns which provider carried the message, so switching between SMTP
 * and Microsoft Graph is configuration.
 */

export interface MailAttachment {
  name: string;
  contentType: string;
  contentBytes: string; // base64
}

export interface MailMessage {
  to: string[];
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}

export type MailOutcome = { status: 'SENT' | 'SUPPRESSED' | 'FAILED'; error?: string };

export async function sendMail(message: MailMessage): Promise<MailOutcome> {
  const provider = env.email.provider;

  if (provider === 'none') {
    console.info(`[mail] no provider configured - would email ${message.to.join(', ')} | ${message.subject}`);
    return { status: 'SUPPRESSED', error: 'No email provider configured' };
  }
  if (!env.email.sendEnabled) {
    console.info(`[mail] sending disabled - would email ${message.to.join(', ')} | ${message.subject}`);
    return { status: 'SUPPRESSED', error: 'Sending disabled (EMAIL_SEND_ENABLED=false)' };
  }

  if (provider === 'smtp') {
    const { sendViaSmtp } = await import('./smtp.js');
    return sendViaSmtp(message);
  }

  const { sendViaGraph } = await import('./graph.js');
  return sendViaGraph(message);
}

export function providerLabel(): string {
  switch (env.email.provider) {
    case 'smtp':
      return `SMTP (${env.smtp.host})`;
    case 'graph':
      return 'Microsoft Graph';
    default:
      return 'not configured';
  }
}

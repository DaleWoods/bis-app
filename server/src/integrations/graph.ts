import { env } from '../config/env.js';

/**
 * Microsoft Graph mail (§12.2): distribution and reminder/escalation email sent
 * from the coordinator or a shared mailbox using an app registration
 * (client-credentials + Mail.Send application permission).
 *
 * With GRAPH_SEND_ENABLED=false the message is rendered and logged but not sent,
 * so the cadence can be rehearsed safely before go-live.
 */

export class GraphNotConfiguredError extends Error {
  constructor() {
    super('Microsoft Graph is not configured. Set GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_TENANT_ID and GRAPH_SENDER_UPN.');
    this.name = 'GraphNotConfiguredError';
  }
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (!env.graph.configured) throw new GraphNotConfiguredError();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const res = await fetch(`https://login.microsoftonline.com/${env.graph.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.graph.clientId,
      client_secret: env.graph.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

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
  if (!env.graph.sendEnabled || !env.graph.configured) {
    console.info(
      `[graph] send disabled - would email ${message.to.join(', ')} | subject: ${message.subject}`,
    );
    return { status: 'SUPPRESSED', error: env.graph.configured ? 'Sending disabled' : 'Graph not configured' };
  }

  try {
    const token = await accessToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.graph.senderUpn)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: 'HTML', content: message.html },
          toRecipients: message.to.map((address) => ({ emailAddress: { address } })),
          attachments: (message.attachments ?? []).map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.name,
            contentType: a.contentType,
            contentBytes: a.contentBytes,
          })),
        },
        saveToSentItems: true,
      }),
    });

    if (!res.ok) return { status: 'FAILED', error: `${res.status} ${await res.text()}` };
    return { status: 'SENT' };
  } catch (err) {
    return { status: 'FAILED', error: err instanceof Error ? err.message : String(err) };
  }
}

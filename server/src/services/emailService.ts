import { Db } from '../db/index.js';
import { env } from '../config/env.js';
import { MailAttachment, sendMail } from '../integrations/mail.js';
import { newId } from '../util/id.js';
import { formatUkDate, nowIso } from '../util/time.js';
import { Member } from './memberService.js';
import { Round } from './roundService.js';
import { Ticket } from './ticketService.js';

export type EmailKind = 'DISTRIBUTION' | 'REMINDER' | 'ESCALATION';

export interface EmailResult {
  memberId: string;
  email: string;
  status: 'SENT' | 'SUPPRESSED' | 'FAILED';
  error?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roundUrl(round: Round): string {
  return `${env.publicWebOrigin.replace(/\/+$/, '')}/score/${round.id}`;
}

// Mirrors web/src/styles.css - kept as hex here because email clients don't
// see the app's stylesheet, so the palette can't be shared via CSS variables.
const BRAND = '#6d5646';
const GOLD = '#b58512';
const HEADER_BG = '#1a1a1a';
const INK = '#1a1a1a';
const MUTED = '#6b645d';
const BG = '#f6f4f1';
const FONT = "'Gill Sans','Gill Sans MT',Calibri,'Segoe UI',Helvetica,Arial,sans-serif";

/** Table-based, inline-styled shell - the layout most email clients render consistently. */
export function shell(body: string): string {
  return `<div style="background:${BG};padding:24px 12px;font-family:${FONT}">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ddd8d2">
<div style="background:${HEADER_BG};padding:14px 20px;border-bottom:3px solid ${GOLD}">
<span style="color:${GOLD};font-size:12px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase">WOSG</span>
<span style="color:#e8e3da;font-size:12px;padding:0 8px">&middot;</span>
<span style="color:#ffffff;font-size:14px">Business Impact Scoring</span>
</div>
<div style="padding:24px 20px;font-size:15px;color:${INK};line-height:1.5">
${body}
<p style="color:${MUTED};font-size:12px;margin-top:28px">Sent by the Business Impact Scoring app.</p>
</div>
</div>
</div>`;
}

function ctaButton(url: string, label: string): string {
  return `<p><a href="${url}" style="background:${BRAND};color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>`;
}

export function buildDistributionEmail(round: Round, tickets: Ticket[], member: Member): { subject: string; html: string } {
  const list = tickets
    .map(
      (ticket) =>
        `<li style="margin-bottom:6px"><strong>${escapeHtml(ticket.jiraId)}</strong> – ${escapeHtml(ticket.title)}</li>`,
    )
    .join('');
  return {
    subject: `Business Impact Scoring – ${round.weekLabel} (${tickets.length} ticket${tickets.length === 1 ? '' : 's'})`,
    html: shell(`<p>Hi ${escapeHtml(member.name.split(' ')[0] || member.name)},</p>
<p>The ${escapeHtml(round.weekLabel)} scoring round is open. Please score each ticket 0–10 across the seven impact categories before the cut-off.</p>
<p><strong>Cut-off:</strong> ${escapeHtml(formatUkDate(round.cutOffAt))} (${escapeHtml(round.cutOffAt)})</p>
${ctaButton(roundUrl(round), 'Open the round and score')}
<p>Tickets in this round:</p>
<ul>${list}</ul>`),
  };
}

export function buildReminderEmail(
  round: Round,
  member: Member,
  outstandingTickets: Ticket[],
  escalation = false,
): { subject: string; html: string } {
  const outstanding = outstandingTickets.length;
  const list = outstandingTickets
    .map((ticket) => `<li style="margin-bottom:4px"><strong>${escapeHtml(ticket.jiraId)}</strong> – ${escapeHtml(ticket.title)}</li>`)
    .join('');
  return {
    subject: `${escalation ? 'Final reminder' : 'Reminder'}: Business Impact Scoring – ${round.weekLabel}`,
    html: shell(`<p>Hi ${escapeHtml(member.name.split(' ')[0] || member.name)},</p>
<p>You have <strong>${outstanding}</strong> ticket${outstanding === 1 ? '' : 's'} still to score in the ${escapeHtml(round.weekLabel)} round:</p>
<ul>${list}</ul>
<p><strong>Cut-off:</strong> ${escapeHtml(formatUkDate(round.cutOffAt))}. Tickets without at least the minimum number of responses roll over to the next round.</p>
${ctaButton(roundUrl(round), 'Finish scoring')}`),
  };
}

async function logEmail(
  db: Db,
  args: { roundId: string; memberId: string; kind: EmailKind; to: string; subject: string; status: string; error?: string },
): Promise<void> {
  await db.run(
    `INSERT INTO email_log (id, round_id, member_id, kind, to_address, subject, status, error, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), args.roundId, args.memberId, args.kind, args.to, args.subject, args.status, args.error ?? '', nowIso()],
  );
}

/** Distribution email: round opened, link to the in-app round + optional pack (§12.2). */
export async function sendDistribution(
  db: Db,
  round: Round,
  tickets: Ticket[],
  recipients: Member[],
  attachment?: MailAttachment,
): Promise<EmailResult[]> {
  const results: EmailResult[] = [];
  for (const member of recipients) {
    const { subject, html } = buildDistributionEmail(round, tickets, member);
    const outcome = await sendMail({
      to: [member.email],
      subject,
      html,
      attachments: attachment ? [attachment] : undefined,
    });
    await logEmail(db, {
      roundId: round.id,
      memberId: member.id,
      kind: 'DISTRIBUTION',
      to: member.email,
      subject,
      status: outcome.status,
      error: outcome.error,
    });
    results.push({ memberId: member.id, email: member.email, status: outcome.status, error: outcome.error });
  }
  return results;
}

/** Reminder/escalation to members who have not finished before the cut-off (§11, §12.2). */
export async function sendReminders(
  db: Db,
  round: Round,
  outstandingByMember: Array<{ member: Member; outstandingTickets: Ticket[] }>,
  escalation = false,
): Promise<EmailResult[]> {
  const results: EmailResult[] = [];
  for (const { member, outstandingTickets } of outstandingByMember) {
    if (!outstandingTickets.length) continue;
    const { subject, html } = buildReminderEmail(round, member, outstandingTickets, escalation);
    const outcome = await sendMail({ to: [member.email], subject, html });
    await logEmail(db, {
      roundId: round.id,
      memberId: member.id,
      kind: escalation ? 'ESCALATION' : 'REMINDER',
      to: member.email,
      subject,
      status: outcome.status,
      error: outcome.error,
    });
    results.push({ memberId: member.id, email: member.email, status: outcome.status, error: outcome.error });
  }
  return results;
}

export interface EmailLogEntry {
  id: string;
  roundId: string | null;
  memberId: string | null;
  kind: string;
  toAddress: string;
  subject: string;
  status: string;
  error: string;
  sentAt: string;
}

/** §14: failed emails are visible and re-triggerable. */
export async function listEmailLog(db: Db, roundId?: string): Promise<EmailLogEntry[]> {
  const rows = await db.all<any>(
    roundId
      ? 'SELECT * FROM email_log WHERE round_id = ? ORDER BY sent_at DESC LIMIT 500'
      : 'SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 500',
    roundId ? [roundId] : [],
  );
  return rows.map((row) => ({
    id: row.id,
    roundId: row.round_id,
    memberId: row.member_id,
    kind: row.kind,
    toAddress: row.to_address,
    subject: row.subject,
    status: row.status,
    error: row.error,
    sentAt: row.sent_at,
  }));
}

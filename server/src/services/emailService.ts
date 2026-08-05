import { Db } from '../db/index.js';
import { env } from '../config/env.js';
import { MailAttachment, sendMail } from '../integrations/graph.js';
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

function shell(body: string): string {
  return `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#1b1b1b;line-height:1.5">
${body}
<p style="color:#666;font-size:12px;margin-top:28px">Sent by the Business Impact Scoring app.</p>
</div>`;
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
<p><a href="${roundUrl(round)}" style="background:#1F4E79;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block">Open the round and score</a></p>
<p>Tickets in this round:</p>
<ul>${list}</ul>`),
  };
}

export function buildReminderEmail(
  round: Round,
  member: Member,
  outstanding: number,
  escalation = false,
): { subject: string; html: string } {
  return {
    subject: `${escalation ? 'Final reminder' : 'Reminder'}: Business Impact Scoring – ${round.weekLabel}`,
    html: shell(`<p>Hi ${escapeHtml(member.name.split(' ')[0] || member.name)},</p>
<p>You have <strong>${outstanding}</strong> ticket${outstanding === 1 ? '' : 's'} still to score in the ${escapeHtml(round.weekLabel)} round.</p>
<p><strong>Cut-off:</strong> ${escapeHtml(formatUkDate(round.cutOffAt))}. Tickets without at least the minimum number of responses roll over to the next round.</p>
<p><a href="${roundUrl(round)}" style="background:#1F4E79;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;display:inline-block">Finish scoring</a></p>`),
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
  outstandingByMember: Array<{ member: Member; outstanding: number }>,
  escalation = false,
): Promise<EmailResult[]> {
  const results: EmailResult[] = [];
  for (const { member, outstanding } of outstandingByMember) {
    if (outstanding <= 0) continue;
    const { subject, html } = buildReminderEmail(round, member, outstanding, escalation);
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

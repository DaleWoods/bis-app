import { Db } from '../db/index.js';
import { sendMail } from '../integrations/mail.js';
import { audit } from './auditService.js';
import { AUTOMATION_ACTOR, listStuckAutomationSteps, type StuckAutomationStep } from './automationService.js';
import { listPendingDiscussions, type PendingDiscussion } from './discussionService.js';
import { listActiveScorers, listMembers } from './memberService.js';
import { getActiveRound, isScoringOpen, listRounds, listRoundTickets, type Round } from './roundService.js';
import { roundProgress } from './submissionService.js';
import { roundResults } from './resultService.js';
import { shell } from './emailService.js';
import { env } from '../config/env.js';
import { formatUkDate, nowIso } from '../util/time.js';

/**
 * A weekly rollup for admins, distinct from the immediate alerts
 * (`alertOnStuckFailures`, `alertOnUnresolvedDiscussions`) that fire the
 * moment something needs attention. Those are for the thing that just went
 * wrong; this is for the admin who was not looking for anything in
 * particular and would otherwise only find out by opening the app.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function roundUrl(round: Round): string {
  return `${env.publicWebOrigin.replace(/\/+$/, '')}/rounds/${round.id}`;
}

interface FinalisedRoundSummary {
  round: Round;
  ticketCount: number;
  sentForEstimation: number;
  toClose: number;
}

async function summariseFinalisedRound(db: Db, round: Round): Promise<FinalisedRoundSummary> {
  const results = await roundResults(db, round);
  return {
    round,
    ticketCount: results.length,
    sentForEstimation: results.filter((r) => r.aggregate.sendForEstimation).length,
    toClose: results.filter((r) => r.aggregate.toClose).length,
  };
}

export interface WeeklyDigest {
  subject: string;
  html: string;
  /** False when there is a genuinely empty week — sent anyway, so silence never gets mistaken for the digest not running. */
  hadActivity: boolean;
}

/**
 * Everything the digest covers is read live, not stored - the same rounds
 * finalised since the last digest, whatever is pending right now, exactly as
 * an admin opening the app would see it. `since` is the last time this ran
 * (or a week ago, on the first ever send), which is what turns "the most
 * recent finalised round" into "what happened since I last heard from you".
 */
export async function buildWeeklyDigest(db: Db, since: string): Promise<WeeklyDigest> {
  const openRound = await getActiveRound(db);
  const finalisedSince = (await listRounds(db)).filter((r) => r.status === 'FINALISED' && !r.imported && r.finalisedAt && r.finalisedAt > since,
  );
  finalisedSince.sort((a, b) => (a.finalisedAt ?? '').localeCompare(b.finalisedAt ?? ''));
  const finalisedSummaries = await Promise.all(finalisedSince.map((round) => summariseFinalisedRound(db, round)));

  const pendingDiscussions: PendingDiscussion[] = await listPendingDiscussions(db);
  const stuckSteps: StuckAutomationStep[] = await listStuckAutomationSteps(db);

  let openRoundHtml = '';
  if (openRound && isScoringOpen(openRound)) {
    const scorers = await listActiveScorers(db);
    const ticketCount = (await listRoundTickets(db, openRound.id)).length;
    const progress = await roundProgress(db, openRound.id, scorers, ticketCount);
    const complete = progress.filter((p) => p.complete).length;
    openRoundHtml = `<h3 style="margin:20px 0 6px">Open now</h3>
<p style="margin:0 0 12px"><strong>${escapeHtml(openRound.weekLabel)}</strong> — ${complete} of ${progress.length} committee members have finished. Cut-off ${escapeHtml(formatUkDate(openRound.cutOffAt))}.</p>`;
  }

  const finalisedHtml = finalisedSummaries.length
    ? `<h3 style="margin:20px 0 6px">Finalised this week</h3>
<ul style="margin:0;padding-left:20px">${finalisedSummaries
        .map(
          (s) =>
            `<li style="margin-bottom:6px"><a href="${roundUrl(s.round)}"><strong>${escapeHtml(s.round.weekLabel)}</strong></a> — ${s.ticketCount} ticket${s.ticketCount === 1 ? '' : 's'}, ${s.sentForEstimation} sent for estimation${s.toClose ? `, ${s.toClose} to close` : ''}.</li>`,
        )
        .join('')}</ul>`
    : `<h3 style="margin:20px 0 6px">Finalised this week</h3><p style="margin:0">No round finalised since the last digest.</p>`;

  const discussionsHtml = pendingDiscussions.length
    ? `<h3 style="margin:20px 0 6px">Waiting on a discussion</h3>
<ul style="margin:0;padding-left:20px">${pendingDiscussions
        .slice(0, 10)
        .map(
          (item) =>
            `<li style="margin-bottom:6px"><strong>${escapeHtml(item.jiraId)}</strong> – ${escapeHtml(item.title)} (${escapeHtml(item.weekLabel)})</li>`,
        )
        .join('')}${pendingDiscussions.length > 10 ? `<li>…and ${pendingDiscussions.length - 10} more.</li>` : ''}</ul>`
    : '';

  const stuckHtml = stuckSteps.length
    ? `<h3 style="margin:20px 0 6px">Automation needs a look</h3>
<ul style="margin:0;padding-left:20px">${stuckSteps
        .slice(0, 10)
        .map(
          (step) =>
            `<li style="margin-bottom:6px"><strong>${escapeHtml(step.weekLabel)}</strong> — ${escapeHtml(step.action)}: ${escapeHtml(step.outcome)}</li>`,
        )
        .join('')}${stuckSteps.length > 10 ? `<li>…and ${stuckSteps.length - 10} more.</li>` : ''}</ul>`
    : '';

  const hadActivity = Boolean(finalisedSummaries.length || pendingDiscussions.length || stuckSteps.length || openRoundHtml);

  return {
    subject: `BIS weekly digest — ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`,
    html: shell(`<p>Your weekly roundup of Business Impact Scoring.</p>
${openRoundHtml}
${finalisedHtml}
${discussionsHtml}
${stuckHtml}
${hadActivity ? '' : '<p>Nothing needs your attention this week.</p>'}`),
    hadActivity,
  };
}

/**
 * True once in every rolling 7-day window, on the same "read the log, not a
 * clock" pattern as `backupDueToday` - a restart never causes two digests in
 * one week, and a week-long outage sends the next one late rather than never.
 */
export async function digestDueThisWeek(db: Db): Promise<{ due: boolean; since: string }> {
  const last = await db.get<{ at: string }>(
    `SELECT at FROM audit_log WHERE action = 'digest.weekly.sent' ORDER BY at DESC LIMIT 1`,
  );
  if (!last) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    return { due: true, since: weekAgo };
  }
  const daysSince = (Date.now() - new Date(last.at).getTime()) / 86_400_000;
  return { due: daysSince >= 7, since: last.at };
}

/**
 * Sent to every active admin, whether or not there was anything to report -
 * a digest that goes quiet in a slow week is indistinguishable from one that
 * has stopped running, and "nothing needs your attention" is itself useful
 * to hear on a schedule.
 */
export async function runWeeklyDigestIfDue(db: Db): Promise<void> {
  const { due, since } = await digestDueThisWeek(db);
  if (!due) return;

  const admins = (await listMembers(db, false)).filter((m) => m.role === 'ADMIN');
  const digest = await buildWeeklyDigest(db, since);

  if (admins.length) {
    await sendMail({ to: admins.map((a) => a.email), subject: digest.subject, html: digest.html });
  }
  await audit(db, AUTOMATION_ACTOR, 'digest.weekly.sent', 'system', '', {
    recipients: admins.length,
    hadActivity: digest.hadActivity,
    sentAt: nowIso(),
  });
}

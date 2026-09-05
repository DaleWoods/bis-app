import { Db } from '../db/index.js';
import { sendMail } from '../integrations/mail.js';
import { nowIso } from '../util/time.js';
import { AuditActor, audit } from './auditService.js';
import { DISCUSSION_OUTCOMES, DiscussionOutcome } from '../domain/types.js';
import { AUTOMATION_ACTOR } from './automationService.js';
import { listCategories } from './configService.js';
import { listMembers } from './memberService.js';
import { roundResults } from './resultService.js';
import { HttpishError, Round, addTicketToRound, listRounds } from './roundService.js';
import { listRoundSubmissions } from './submissionService.js';

/**
 * §10.4: what happened at the meeting about a ticket the committee was split
 * on. An empty outcome is a meeting that has not happened yet.
 */
export interface Discussion {
  roundId: string;
  ticketId: string;
  /** When the meeting is (or was). Free-form scheduling lives in Outlook; this is the note of it. */
  meetingAt: string | null;
  outcome: DiscussionOutcome | '';
  /** The number the meeting settled on. Null until an AGREED outcome is recorded. */
  agreedScore: number | null;
  note: string;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string;
}

/** A split ticket, everything the coordinator needs to run the meeting about it. */
export interface DiscussionItem {
  ticketId: string;
  jiraId: string;
  title: string;
  responsesCount: number;
  /** The average of the committee's totals - the number under dispute. */
  calculatedScore: number | null;
  stdDev: number | null;
  lowest: number | null;
  highest: number | null;
  /** Unattributed, in ascending order, as everywhere else in the app (§9). */
  totals: number[];
  /** Queries and closure notes left with the scores, also unattributed. */
  notes: string[];
  discussion: Discussion | null;
  /** True while the ticket is held out of JIRA write-back. */
  blockingWriteBack: boolean;
}

function mapDiscussion(row: any): Discussion {
  return {
    roundId: row.round_id,
    ticketId: row.ticket_id,
    meetingAt: row.meeting_at ?? null,
    outcome: (row.outcome ?? '') as DiscussionOutcome | '',
    agreedScore: row.agreed_score === null || row.agreed_score === undefined ? null : Number(row.agreed_score),
    note: row.note ?? '',
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? '',
  };
}

export async function listDiscussions(db: Db, roundId: string): Promise<Map<string, Discussion>> {
  const rows = await db.all<any>('SELECT * FROM ticket_discussions WHERE round_id = ?', [roundId]);
  return new Map(rows.map((row) => [row.ticket_id as string, mapDiscussion(row)]));
}

/**
 * Whether a ticket is still waiting on its discussion, and so must not be
 * written to JIRA. The one place that decides it, because both the write-back
 * and the screens that explain the write-back have to agree.
 */
export function heldForDiscussion(discussionRequired: boolean, discussion: Discussion | null | undefined): boolean {
  if (!discussionRequired) return false;
  return discussion?.outcome !== 'AGREED';
}

/**
 * The agenda: every ticket in the round the committee was split on, plus any
 * ticket with a discussion already recorded against it - a coordinator who
 * lowers the spread threshold afterwards should still see what was decided.
 */
export async function discussionAgenda(db: Db, round: Round): Promise<DiscussionItem[]> {
  const [results, discussions, submissions] = await Promise.all([
    roundResults(db, round),
    listDiscussions(db, round.id),
    listRoundSubmissions(db, round.id),
  ]);

  const notesByTicket = new Map<string, string[]>();
  for (const submission of submissions) {
    const text = [submission.moreInfo, submission.closureInfo].filter((s) => s && s.trim()).join(' — ');
    if (!text) continue;
    const bucket = notesByTicket.get(submission.ticketId) ?? [];
    bucket.push(text.trim());
    notesByTicket.set(submission.ticketId, bucket);
  }

  const items: DiscussionItem[] = [];
  for (const { ticket, aggregate } of results) {
    const discussion = discussions.get(ticket.id) ?? null;
    if (!aggregate.discussionRequired && !discussion) continue;
    const totals = [...aggregate.totalsDistribution].sort((a, b) => a - b);
    items.push({
      ticketId: ticket.id,
      jiraId: ticket.jiraId,
      title: ticket.title,
      responsesCount: aggregate.responsesCount,
      calculatedScore: aggregate.businessScore,
      stdDev: aggregate.stdDev,
      lowest: totals.length ? totals[0] : null,
      highest: totals.length ? totals[totals.length - 1] : null,
      totals,
      notes: notesByTicket.get(ticket.id) ?? [],
      discussion,
      blockingWriteBack: heldForDiscussion(aggregate.discussionRequired, discussion),
    });
  }
  return items;
}

export interface PendingDiscussion {
  roundId: string;
  weekLabel: string;
  ticketId: string;
  jiraId: string;
  title: string;
  stdDev: number | null;
}

/**
 * Every ticket, across every round, that is split enough to need a meeting
 * and has no outcome recorded yet - live, not a stored flag. A ticket that
 * narrows back under the threshold, or gets AGREED/RESCORE/CLOSE recorded
 * against it, drops off on its own with nothing to clear.
 */
export async function listPendingDiscussions(db: Db): Promise<PendingDiscussion[]> {
  const rounds = (await listRounds(db)).filter((r) => r.status !== 'DRAFT');
  const pending: PendingDiscussion[] = [];
  for (const round of rounds) {
    const [results, discussions] = await Promise.all([roundResults(db, round), listDiscussions(db, round.id)]);
    for (const { ticket, aggregate } of results) {
      if (!aggregate.discussionRequired) continue;
      if (discussions.get(ticket.id)?.outcome) continue;
      pending.push({
        roundId: round.id,
        weekLabel: round.weekLabel,
        ticketId: ticket.id,
        jiraId: ticket.jiraId,
        title: ticket.title,
        stdDev: aggregate.stdDev,
      });
    }
  }
  return pending;
}

/**
 * Emails every active admin the first time a ticket becomes split enough to
 * need a decision, and never again for that same round+ticket - see
 * alertOnStuckFailures in automationService.ts for the same audit_log
 * dedup pattern. Safe to call on every tick: with nothing pending, this is a
 * handful of cheap reads.
 */
export async function alertOnUnresolvedDiscussions(db: Db): Promise<void> {
  const pending = await listPendingDiscussions(db);
  if (!pending.length) return;

  for (const item of pending) {
    const key = `${item.roundId}:${item.ticketId}`;
    const already = await db.get<{ id: string }>(
      `SELECT id FROM audit_log WHERE action = 'discussion.alerted' AND entity_id = ?`,
      [key],
    );
    if (already) continue;

    const admins = (await listMembers(db, false)).filter((m) => m.role === 'ADMIN');
    if (admins.length) {
      await sendMail({
        to: admins.map((a) => a.email),
        subject: `BIS: ${item.jiraId} needs a discussion — ${item.weekLabel}`,
        html: `<p><strong>${item.jiraId}</strong> — ${item.title}</p>
<p>The committee's scores were split enough on this one (spread ${
          item.stdDev !== null ? item.stdDev.toFixed(1) : '—'
        }) that it needs a decision before a score can go to JIRA.</p>
<p>Open the round's Discussions tab to book a meeting or record what was decided.</p>`,
      });
    }
    // Recorded even with no active admins to send to, so a pending
    // discussion with nobody to tell does not get re-checked forever - the
    // banner still shows it regardless of whether the email went anywhere.
    await audit(db, AUTOMATION_ACTOR, 'discussion.alerted', 'ticket', key, {
      roundId: item.roundId,
      ticketId: item.ticketId,
    });
  }
}

export interface DiscussionInput {
  meetingAt?: string | null;
  outcome?: DiscussionOutcome | '';
  agreedScore?: number | null;
  note?: string;
}

export interface DiscussionResult {
  discussion: Discussion;
  /** The round a RESCORE ticket was put into, when there was one open to put it in. */
  rescoredInto: { id: string; weekLabel: string } | null;
}

/**
 * Record what the meeting decided (or that one is booked).
 *
 * Allowed on a finalised round on purpose: the meeting happens after the round
 * closes, which is the whole reason the ticket is held back. It does not touch
 * the frozen results - the committee's scores stay exactly as they were given,
 * and the agreed number is recorded alongside them as the decision it is.
 */
export async function recordDiscussion(
  db: Db,
  actor: AuditActor,
  round: Round,
  ticketId: string,
  input: DiscussionInput,
): Promise<DiscussionResult> {
  const inRound = await db.get('SELECT ticket_id FROM round_tickets WHERE round_id = ? AND ticket_id = ?', [
    round.id,
    ticketId,
  ]);
  if (!inRound) throw new HttpishError(404, 'That ticket is not in this round');

  const outcome = (input.outcome ?? '') as DiscussionOutcome | '';
  if (outcome && !DISCUSSION_OUTCOMES.includes(outcome as DiscussionOutcome)) {
    throw new HttpishError(400, `Unknown discussion outcome "${outcome}"`);
  }

  let agreedScore: number | null = null;
  if (outcome === 'AGREED') {
    const categories = await listCategories(db, true);
    const maxTotal = categories.reduce((sum, c) => sum + c.scaleMax, 0);
    const fallback = (await roundResults(db, round)).find((r) => r.ticket.id === ticketId)?.aggregate.businessScore;
    const value = input.agreedScore ?? fallback ?? null;
    if (value === null) {
      throw new HttpishError(400, 'Agreeing a score needs a score — there is nothing to fall back on for this ticket');
    }
    if (!Number.isFinite(value) || value < 0 || value > maxTotal) {
      throw new HttpishError(400, `The agreed score has to be between 0 and ${maxTotal}`);
    }
    agreedScore = Math.round(value);
  }

  const existing = await db.get<any>('SELECT * FROM ticket_discussions WHERE round_id = ? AND ticket_id = ?', [
    round.id,
    ticketId,
  ]);
  const now = nowIso();
  const meetingAt = input.meetingAt === undefined ? (existing?.meeting_at ?? null) : input.meetingAt || null;
  const note = input.note === undefined ? (existing?.note ?? '') : input.note;

  if (existing) {
    await db.run(
      `UPDATE ticket_discussions
          SET meeting_at = ?, outcome = ?, agreed_score = ?, note = ?, resolved_at = ?, resolved_by = ?
        WHERE round_id = ? AND ticket_id = ?`,
      [
        meetingAt,
        outcome,
        agreedScore,
        note,
        outcome ? now : null,
        outcome ? (actor.email ?? '') : '',
        round.id,
        ticketId,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO ticket_discussions (round_id, ticket_id, meeting_at, outcome, agreed_score, note, opened_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [round.id, ticketId, meetingAt, outcome, agreedScore, note, now, outcome ? now : null, outcome ? (actor.email ?? '') : ''],
    );
  }

  // "Score it again next round" is only a decision if the ticket actually gets
  // in front of the committee again, so it is put into whichever round is
  // still taking tickets. If there is none yet, the automatic roll-over picks
  // it up when the next round is created.
  let rescoredInto: DiscussionResult['rescoredInto'] = null;
  if (outcome === 'RESCORE') {
    const rounds = await listRounds(db);
    const target = rounds
      .filter((r) => r.id !== round.id && (r.status === 'DRAFT' || r.status === 'OPEN'))
      .sort((a, b) => a.cutOffAt.localeCompare(b.cutOffAt))[0];
    if (target) {
      await addTicketToRound(db, target.id, ticketId);
      rescoredInto = { id: target.id, weekLabel: target.weekLabel };
    }
  }

  await audit(db, actor, 'round.discussion', 'ticket', ticketId, {
    roundId: round.id,
    outcome,
    agreedScore,
    rescoredInto: rescoredInto?.id ?? '',
  });

  const row = await db.get<any>('SELECT * FROM ticket_discussions WHERE round_id = ? AND ticket_id = ?', [
    round.id,
    ticketId,
  ]);
  return { discussion: mapDiscussion(row), rescoredInto };
}

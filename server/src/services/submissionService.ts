import { Db } from '../db/index.js';
import { SubmissionInput } from '../domain/scoring.js';
import {
  RELEVANCE_REQUIRING_REASON,
  RELEVANCE_REQUESTOR_ONLY,
  RELEVANCE_VALUES,
  Relevance,
  ScoringConfig,
  canScore,
} from '../domain/types.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';
import { listCategories } from './configService.js';
import { Member } from './memberService.js';
import { HttpishError, Round, isScoringOpen } from './roundService.js';
import { Ticket } from './ticketService.js';

export interface Submission {
  id: string;
  roundId: string;
  ticketId: string;
  memberId: string;
  memberName?: string;
  relevance: Relevance;
  closureReason: string;
  closureInfo: string;
  moreInfo: string;
  archived: boolean;
  scores: Record<string, number>;
  submittedAt: string;
  updatedAt: string;
}

interface SubmissionRow {
  id: string;
  round_id: string;
  ticket_id: string;
  member_id: string;
  member_name?: string;
  relevance: string;
  closure_reason: string;
  closure_info: string;
  more_info: string;
  archived: number;
  submitted_at: string;
  updated_at: string;
}

function map(row: SubmissionRow, scores: Record<string, number>): Submission {
  return {
    id: row.id,
    roundId: row.round_id,
    ticketId: row.ticket_id,
    memberId: row.member_id,
    memberName: row.member_name,
    relevance: row.relevance as Relevance,
    closureReason: row.closure_reason,
    closureInfo: row.closure_info,
    moreInfo: row.more_info,
    archived: Number(row.archived) === 1,
    scores,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

async function attachScores(db: Db, rows: SubmissionRow[]): Promise<Submission[]> {
  if (!rows.length) return [];
  // Scoped to the submissions being mapped. It used to select every score in
  // the round, so one committee member opening their own scoring page pulled
  // back the whole committee's answers to throw most of them away.
  const placeholders = rows.map(() => '?').join(', ');
  const scoreRows = await db.all<{ submission_id: string; category_id: string; score: number }>(
    `SELECT submission_id, category_id, score FROM submission_scores
     WHERE submission_id IN (${placeholders})`,
    rows.map((row) => row.id),
  );
  const byId = new Map<string, Record<string, number>>();
  for (const score of scoreRows) {
    const bucket = byId.get(score.submission_id) ?? {};
    bucket[score.category_id] = Number(score.score);
    byId.set(score.submission_id, bucket);
  }
  return rows.map((row) => map(row, byId.get(row.id) ?? {}));
}

/** All submissions in a round - coordinator only (§9). */
export async function listRoundSubmissions(db: Db, roundId: string): Promise<Submission[]> {
  const rows = await db.all<SubmissionRow>(
    `SELECT s.*, m.name AS member_name FROM submissions s JOIN members m ON m.id = s.member_id
     WHERE s.round_id = ? ORDER BY m.name ASC`,
    [roundId],
  );
  return attachScores(db, rows);
}

/** What a committee member is allowed to see while a round is open: their own. */
export async function listMemberSubmissions(db: Db, roundId: string, memberId: string): Promise<Submission[]> {
  const rows = await db.all<SubmissionRow>('SELECT * FROM submissions WHERE round_id = ? AND member_id = ?', [
    roundId,
    memberId,
  ]);
  return attachScores(db, rows);
}

/** Shape the §10 calculation consumes. */
export function toScoringInput(submission: Submission): SubmissionInput {
  return {
    id: submission.id,
    memberId: submission.memberId,
    relevance: submission.relevance,
    archived: submission.archived,
    scores: submission.scores,
  };
}

export interface SubmissionPayload {
  relevance: Relevance;
  scores?: Record<string, number>;
  closureReason?: string;
  closureInfo?: string;
  moreInfo?: string;
}

/**
 * Create or replace this member's submission for a ticket, applying the §8
 * relevance and closure rules. Members may edit their own answer until the
 * cut-off; nothing here can touch anyone else's submission.
 */
export async function saveSubmission(
  db: Db,
  args: {
    round: Round;
    ticket: Ticket;
    member: Member;
    payload: SubmissionPayload;
    config: ScoringConfig;
    at?: Date;
  },
): Promise<Submission> {
  const { round, ticket, member, payload, config } = args;

  // Coordinators run the round; the committee scores it. Enforced here rather
  // than only in the UI, so it holds for any caller.
  if (!canScore(member.role)) {
    throw new HttpishError(403, 'Coordinators and viewers do not score tickets — only committee members do');
  }

  if (!isScoringOpen(round, args.at ?? new Date())) {
    throw new HttpishError(
      409,
      round.status === 'OPEN' ? 'The cut-off for this round has passed' : `This round is ${round.status.toLowerCase()}`,
    );
  }

  const inRound = await db.get('SELECT ticket_id FROM round_tickets WHERE round_id = ? AND ticket_id = ?', [
    round.id,
    ticket.id,
  ]);
  if (!inRound) throw new HttpishError(404, 'Ticket is not part of this round');

  if (!RELEVANCE_VALUES.includes(payload.relevance)) {
    throw new HttpishError(400, 'Unknown relevance answer');
  }

  // §8: only the original requestor may say a ticket isn't relevant today.
  // Driven by the constant rather than a literal, so adding an answer to the
  // list in domain/types.ts is enough - these rules were already declared there
  // and enforced separately here, which is how the two drift apart.
  if (RELEVANCE_REQUESTOR_ONLY.includes(payload.relevance)) {
    const requestor = (ticket.originalRequestor ?? '').trim().toLowerCase();
    if (!requestor || requestor !== member.email.trim().toLowerCase()) {
      throw new HttpishError(403, "Only the original requestor can answer \"This ticket isn't relevant today\"");
    }
  }

  const needsReason = RELEVANCE_REQUIRING_REASON.includes(payload.relevance);
  if (needsReason && !(payload.closureReason ?? '').trim()) {
    throw new HttpishError(400, 'A reason is required for this answer');
  }
  if (
    payload.relevance === 'NO_CLOSE' &&
    config.closureReasons.length &&
    !config.closureReasons.includes((payload.closureReason ?? '').trim())
  ) {
    throw new HttpishError(400, `Reason for closure must be one of: ${config.closureReasons.join(', ')}`);
  }

  const categories = await listCategories(db);

  // With no categories there is nothing to score, and an empty "Yes" would be
  // stored as a valid response worth 0 - dragging down the ticket's average and
  // counting toward its minimum-responses gate. Refuse rather than record that.
  if (payload.relevance === 'YES' && categories.length === 0) {
    throw new HttpishError(
      409,
      'There are no active scoring categories, so scores cannot be recorded. Ask the coordinator to restore them in Settings.',
    );
  }

  const scores: Record<string, number> = {};
  if (payload.relevance === 'YES') {
    for (const category of categories) {
      const raw = payload.scores?.[category.id];
      if (raw === undefined || raw === null || raw === ('' as unknown)) {
        throw new HttpishError(400, `Missing score for "${category.name}"`);
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < category.scaleMin || value > category.scaleMax) {
        throw new HttpishError(
          400,
          `"${category.name}" must be a whole number between ${category.scaleMin} and ${category.scaleMax}`,
        );
      }
      scores[category.id] = value;
    }
  }

  const now = nowIso();
  const existing = await db.get<SubmissionRow>(
    'SELECT * FROM submissions WHERE round_id = ? AND ticket_id = ? AND member_id = ?',
    [round.id, ticket.id, member.id],
  );

  /*
    A score is given once and stands.

    Allowing revisions sounded harmless and was not: an answer that can be
    changed is an answer that can be changed *after* seeing what everyone else
    said, and the spread that decides whether a ticket needs discussing is only
    meaningful if each score was formed independently. It also made "who has
    responded" a moving target - a member could be complete on Tuesday and not
    on Wednesday.

    An excluded submission is the way back: the coordinator excludes the wrong
    one, which frees the member to score it again.
  */
  if (existing && !(Number(existing.archived) === 1)) {
    throw new HttpishError(
      409,
      'You have already scored this ticket, and a score cannot be changed once it is in. Ask whoever is running the round if it needs correcting.',
    );
  }

  const id = existing?.id ?? newId();
  await db.tx(async (tx) => {
    if (existing) {
      // Only reachable for a submission the coordinator excluded, which is the
      // sanctioned way to let somebody score again. Scoring again un-excludes
      // it, or the new answer would be recorded and still not count.
      await tx.run(
        `UPDATE submissions SET relevance = ?, closure_reason = ?, closure_info = ?, more_info = ?, archived = 0, submitted_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          payload.relevance,
          payload.closureReason ?? '',
          payload.closureInfo ?? '',
          payload.moreInfo ?? '',
          now,
          now,
          id,
        ],
      );
      await tx.run('DELETE FROM submission_scores WHERE submission_id = ?', [id]);
    } else {
      await tx.run(
        `INSERT INTO submissions (id, round_id, ticket_id, member_id, relevance, closure_reason, closure_info, more_info, archived, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          id,
          round.id,
          ticket.id,
          member.id,
          payload.relevance,
          payload.closureReason ?? '',
          payload.closureInfo ?? '',
          payload.moreInfo ?? '',
          now,
          now,
        ],
      );
    }

    for (const [categoryId, score] of Object.entries(scores)) {
      await tx.run('INSERT INTO submission_scores (submission_id, category_id, score) VALUES (?, ?, ?)', [
        id,
        categoryId,
        score,
      ]);
    }
  });

  const row = (await db.get<SubmissionRow>('SELECT * FROM submissions WHERE id = ?', [id])) as SubmissionRow;
  return map(row, scores);
}

/**
 * Exclude a submission from the aggregates without deleting it (§10.1 treats
 * archived scores as never counting). Used when a score was recorded by
 * someone who should not have been scoring, or entered in error.
 */
export async function setSubmissionArchived(db: Db, submissionId: string, archived: boolean): Promise<void> {
  await db.run('UPDATE submissions SET archived = ?, updated_at = ? WHERE id = ?', [
    archived ? 1 : 0,
    nowIso(),
    submissionId,
  ]);
}

/**
 * Which tickets each member has not yet scored - the useful half of "you have
 * 3 outstanding", which used to make somebody go and work out which 3 for
 * themselves before a reminder was any use to them.
 */
export async function outstandingTicketsByMember(
  db: Db,
  roundId: string,
  scorers: Member[],
  tickets: Ticket[],
): Promise<Map<string, Ticket[]>> {
  const rows = await db.all<{ member_id: string; ticket_id: string }>(
    'SELECT member_id, ticket_id FROM submissions WHERE round_id = ? AND archived = 0',
    [roundId],
  );
  const doneByMember = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!doneByMember.has(row.member_id)) doneByMember.set(row.member_id, new Set());
    doneByMember.get(row.member_id)!.add(row.ticket_id);
  }
  return new Map(
    scorers.map((member) => {
      const done = doneByMember.get(member.id) ?? new Set<string>();
      return [member.id, tickets.filter((t) => !done.has(t.id))];
    }),
  );
}

/**
 * How many finalised rounds in a row, counting back from the most recent, this
 * member finished - stopping at the first one they left unfinished.
 *
 * A run of rounds you have kept up is the one number that makes missing the
 * next one cost something, which is most of why it is here: an average of five
 * of twelve scoring is not a comprehension problem, it is nobody minding
 * whether they do. It counts back rather than totalling, because "you have
 * done the last four" is a thing to keep going and "you have done 23 in your
 * time here" is not.
 *
 * A held ticket never reached the committee, so requiring it would break the
 * run of everyone who scored everything they were actually shown. Rounds with
 * nothing in them teach nothing either way and are skipped without breaking
 * the run - and so, harmlessly, are the rounds before a member joined, since
 * the walk stops at the first round they did not complete.
 */
export async function memberStreak(db: Db, memberId: string, limit = 52): Promise<number> {
  const rounds = await db.all<{ id: string; ticket_count: number }>(
    `SELECT r.id, (SELECT COUNT(*) FROM round_tickets rt WHERE rt.round_id = r.id AND rt.held = 0) AS ticket_count
     FROM rounds r WHERE r.status = 'FINALISED' ORDER BY r.cut_off_at DESC LIMIT ?`,
    [limit],
  );
  const considered = rounds.filter((r) => Number(r.ticket_count) > 0);
  if (!considered.length) return 0;

  const roundIds = considered.map((r) => r.id);
  const placeholders = roundIds.map(() => '?').join(',');
  const rows = await db.all<{ round_id: string; submitted: number }>(
    `SELECT round_id, COUNT(*) AS submitted FROM submissions
     WHERE member_id = ? AND round_id IN (${placeholders}) AND archived = 0 GROUP BY round_id`,
    [memberId, ...roundIds],
  );
  const submittedByRound = new Map(rows.map((r) => [r.round_id, Number(r.submitted)]));

  let streak = 0;
  for (const round of considered) {
    if ((submittedByRound.get(round.id) ?? 0) < Number(round.ticket_count)) break;
    streak += 1;
  }
  return streak;
}

export interface MemberParticipation {
  memberId: string;
  memberName: string;
  team: string;
  /** How many of the last `roundsConsidered` finalised rounds this member completed. */
  roundsCompleted: number;
  roundsConsidered: number;
}

/**
 * Completion rate over the last `limit` finalised rounds - not this round's
 * progress, which `roundProgress` already covers, but the pattern across
 * several. A round with no tickets teaches nothing about who engaged, so it
 * is left out of the count on both sides of the fraction.
 */
export async function participationHistory(db: Db, scorers: Member[], limit = 8): Promise<MemberParticipation[]> {
  const rounds = await db.all<{ id: string; ticket_count: number }>(
    `SELECT r.id, (SELECT COUNT(*) FROM round_tickets rt WHERE rt.round_id = r.id) AS ticket_count
     FROM rounds r WHERE r.status = 'FINALISED' ORDER BY r.cut_off_at DESC LIMIT ?`,
    [limit],
  );
  const considered = rounds.filter((r) => Number(r.ticket_count) > 0);
  if (!considered.length) {
    return scorers.map((m) => ({ memberId: m.id, memberName: m.name, team: m.team, roundsCompleted: 0, roundsConsidered: 0 }));
  }

  const roundIds = considered.map((r) => r.id);
  const placeholders = roundIds.map(() => '?').join(',');
  const rows = await db.all<{ member_id: string; round_id: string; submitted: number }>(
    `SELECT member_id, round_id, COUNT(*) AS submitted FROM submissions
     WHERE round_id IN (${placeholders}) AND archived = 0 GROUP BY member_id, round_id`,
    roundIds,
  );
  const submittedByMemberRound = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!submittedByMemberRound.has(row.member_id)) submittedByMemberRound.set(row.member_id, new Map());
    submittedByMemberRound.get(row.member_id)!.set(row.round_id, Number(row.submitted));
  }
  const ticketCountByRound = new Map(considered.map((r) => [r.id, Number(r.ticket_count)]));

  return scorers.map((member) => {
    const byRound = submittedByMemberRound.get(member.id) ?? new Map();
    const roundsCompleted = considered.filter(
      (r) => (byRound.get(r.id) ?? 0) >= (ticketCountByRound.get(r.id) ?? Infinity),
    ).length;
    return { memberId: member.id, memberName: member.name, team: member.team, roundsCompleted, roundsConsidered: considered.length };
  });
}

export interface MemberProgress {
  memberId: string;
  memberName: string;
  memberEmail: string;
  team: string;
  submitted: number;
  outstanding: number;
  lastSubmittedAt: string | null;
  complete: boolean;
}

/** Coordinator dashboard: who has responded and who needs chasing (§4, §9). */
export async function roundProgress(db: Db, roundId: string, scorers: Member[], ticketCount: number): Promise<MemberProgress[]> {
  const rows = await db.all<{ member_id: string; submitted: number; last_at: string | null }>(
    `SELECT member_id, COUNT(*) AS submitted, MAX(updated_at) AS last_at FROM submissions
     WHERE round_id = ? AND archived = 0 GROUP BY member_id`,
    [roundId],
  );
  const byMember = new Map(rows.map((r) => [r.member_id, r]));
  return scorers.map((member) => {
    const row = byMember.get(member.id);
    const submitted = Number(row?.submitted ?? 0);
    return {
      memberId: member.id,
      memberName: member.name,
      memberEmail: member.email,
      team: member.team,
      submitted,
      outstanding: Math.max(ticketCount - submitted, 0),
      lastSubmittedAt: row?.last_at ?? null,
      complete: ticketCount > 0 && submitted >= ticketCount,
    };
  });
}

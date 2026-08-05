import { Db } from '../db/index.js';
import { SubmissionInput } from '../domain/scoring.js';
import { RELEVANCE_VALUES, Relevance, ScoringConfig } from '../domain/types.js';
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
  const scoreRows = await db.all<{ submission_id: string; category_id: string; score: number }>(
    `SELECT ss.submission_id, ss.category_id, ss.score FROM submission_scores ss
     JOIN submissions s ON s.id = ss.submission_id WHERE s.round_id = ?`,
    [rows[0].round_id],
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

export async function listTicketSubmissions(db: Db, roundId: string, ticketId: string): Promise<Submission[]> {
  const rows = await db.all<SubmissionRow>(
    `SELECT s.*, m.name AS member_name FROM submissions s JOIN members m ON m.id = s.member_id
     WHERE s.round_id = ? AND s.ticket_id = ?`,
    [roundId, ticketId],
  );
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
  if (payload.relevance === 'NO_NOT_RELEVANT_TODAY') {
    const requestor = (ticket.originalRequestor ?? '').trim().toLowerCase();
    if (!requestor || requestor !== member.email.trim().toLowerCase()) {
      throw new HttpishError(403, "Only the original requestor can answer \"This ticket isn't relevant today\"");
    }
  }

  const needsReason = payload.relevance === 'NO_CLOSE' || payload.relevance === 'NO_NOT_RELEVANT_TODAY';
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

  const id = existing?.id ?? newId();
  await db.tx(async (tx) => {
    if (existing) {
      await tx.run(
        `UPDATE submissions SET relevance = ?, closure_reason = ?, closure_info = ?, more_info = ?, updated_at = ?
         WHERE id = ?`,
        [
          payload.relevance,
          payload.closureReason ?? '',
          payload.closureInfo ?? '',
          payload.moreInfo ?? '',
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

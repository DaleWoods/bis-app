import { Db } from '../db/index.js';
import { RoundStatus, Stream } from '../domain/types.js';
import { newId } from '../util/id.js';
import { isPast, nowIso } from '../util/time.js';
import { Ticket, mapTicket } from './ticketService.js';

export interface Round {
  id: string;
  weekLabel: string;
  cutOffAt: string;
  status: RoundStatus;
  stream: Stream;
  notes: string;
  distributionSentAt: string | null;
  /** Start of the scoring window. Null = opens when someone opens it. */
  opensAt: string | null;
  /** Automation leaves this round alone while true. */
  automationPaused: boolean;
  openedAt: string | null;
  closedAt: string | null;
  finalisedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  ticketCount: number;
}

interface RoundRow {
  id: string;
  week_label: string;
  cut_off_at: string;
  status: string;
  stream: string;
  notes: string;
  distribution_sent_at: string | null;
  opens_at: string | null;
  automation_paused: number | null;
  opened_at: string | null;
  closed_at: string | null;
  finalised_at: string | null;
  created_by: string | null;
  created_at: string;
  ticket_count?: number;
}

function map(row: RoundRow): Round {
  return {
    id: row.id,
    weekLabel: row.week_label,
    cutOffAt: row.cut_off_at,
    status: row.status as RoundStatus,
    stream: (row.stream as Stream) ?? 'ECOM',
    notes: row.notes,
    distributionSentAt: row.distribution_sent_at,
    opensAt: row.opens_at ?? null,
    automationPaused: Number(row.automation_paused ?? 0) === 1,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    finalisedAt: row.finalised_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ticketCount: Number(row.ticket_count ?? 0),
  };
}

const WITH_COUNT = `SELECT r.*, (SELECT COUNT(*) FROM round_tickets rt WHERE rt.round_id = r.id) AS ticket_count FROM rounds r`;

export async function listRounds(db: Db): Promise<Round[]> {
  const rows = await db.all<RoundRow>(`${WITH_COUNT} ORDER BY r.cut_off_at DESC`);
  return rows.map(map);
}

export async function getRound(db: Db, id: string): Promise<Round | undefined> {
  const row = await db.get<RoundRow>(`${WITH_COUNT} WHERE r.id = ?`, [id]);
  return row ? map(row) : undefined;
}

/** The round a committee member is asked to score right now. */
export async function getActiveRound(db: Db): Promise<Round | undefined> {
  const row = await db.get<RoundRow>(`${WITH_COUNT} WHERE r.status = 'OPEN' ORDER BY r.cut_off_at ASC`);
  return row ? map(row) : undefined;
}

export async function createRound(
  db: Db,
  input: { weekLabel: string; cutOffAt: string; opensAt?: string | null; stream?: Stream; notes?: string; createdBy?: string },
): Promise<Round> {
  const id = newId();
  const now = nowIso();
  await db.run(
    `INSERT INTO rounds (id, week_label, cut_off_at, opens_at, status, stream, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    [id, input.weekLabel, input.cutOffAt, input.opensAt ?? null, input.stream ?? 'ECOM', input.notes ?? '', input.createdBy ?? null, now, now],
  );
  return (await getRound(db, id)) as Round;
}

export async function updateRound(
  db: Db,
  id: string,
  input: { weekLabel?: string; cutOffAt?: string; opensAt?: string | null; notes?: string; stream?: Stream; automationPaused?: boolean },
): Promise<Round | undefined> {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (input.weekLabel !== undefined) {
    sets.push('week_label = ?');
    params.push(input.weekLabel);
  }
  if (input.cutOffAt !== undefined) {
    sets.push('cut_off_at = ?');
    params.push(input.cutOffAt);
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?');
    params.push(input.notes);
  }
  if (input.stream !== undefined) {
    sets.push('stream = ?');
    params.push(input.stream);
  }
  if (input.opensAt !== undefined) {
    sets.push('opens_at = ?');
    params.push(input.opensAt);
  }
  if (input.automationPaused !== undefined) {
    sets.push('automation_paused = ?');
    params.push(input.automationPaused ? 1 : 0);
  }
  if (!sets.length) return getRound(db, id);
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  await db.run(`UPDATE rounds SET ${sets.join(', ')} WHERE id = ?`, params);
  return getRound(db, id);
}

/**
 * A finalised round can now be reopened. It used to be a dead end, on the
 * reasoning that finalised results are frozen - but results being frozen is
 * exactly why someone needs a way back when a round finalises with the wrong
 * scores in it, and once automation finalises rounds unattended that stopped
 * being hypothetical.
 *
 * Reopening is a two-step climb (FINALISED -> CLOSED -> OPEN) rather than one
 * button, and the caller says what it costs: the snapshot is rewritten on the
 * next finalise, and anything already written to JIRA stays there until a fresh
 * write-back replaces it.
 */
const ALLOWED_TRANSITIONS: Record<RoundStatus, RoundStatus[]> = {
  DRAFT: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['OPEN', 'FINALISED'],
  FINALISED: ['CLOSED'],
};

export function canTransition(from: RoundStatus, to: RoundStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export async function setRoundStatus(db: Db, id: string, status: RoundStatus): Promise<Round> {
  const round = await getRound(db, id);
  if (!round) throw new HttpishError(404, 'Round not found');
  if (round.status === status) return round;
  if (!canTransition(round.status, status)) {
    throw new HttpishError(409, `Cannot move a ${round.status} round to ${status}`);
  }

  const now = nowIso();

  // Coming back from FINALISED, clear the stamp and let the automated tail of
  // the cycle run again. Without this the round would still read as finalised,
  // and the automation log would refuse to close, finalise or write back a
  // second time - reopening would leave it stuck.
  if (round.status === 'FINALISED') {
    await db.run('UPDATE rounds SET finalised_at = NULL WHERE id = ?', [id]);
    await db.run("DELETE FROM round_automation_log WHERE round_id = ? AND action IN ('close', 'finalise', 'writeback')", [
      id,
    ]);
  }

  const column =
    status === 'OPEN' ? 'opened_at' : status === 'CLOSED' ? 'closed_at' : status === 'FINALISED' ? 'finalised_at' : null;
  if (column) {
    await db.run(`UPDATE rounds SET status = ?, ${column} = ?, updated_at = ? WHERE id = ?`, [status, now, now, id]);
  } else {
    await db.run('UPDATE rounds SET status = ?, updated_at = ? WHERE id = ?', [status, now, id]);
  }
  return (await getRound(db, id)) as Round;
}

export async function markDistributed(db: Db, id: string): Promise<void> {
  await db.run('UPDATE rounds SET distribution_sent_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id]);
}

export async function listRoundTickets(db: Db, roundId: string): Promise<Ticket[]> {
  const rows = await db.all<any>(
    `SELECT t.* FROM round_tickets rt JOIN tickets t ON t.id = rt.ticket_id
     WHERE rt.round_id = ? ORDER BY rt.position ASC, t.jira_id ASC`,
    [roundId],
  );
  return rows.map(mapTicket);
}

/**
 * A round stops taking tickets once the committee has stopped scoring it.
 *
 * Adding one to a CLOSED round gives it a ticket nobody can score; adding one
 * to a FINALISED round is worse, because removeTicketFromRound refuses to undo
 * it - the ticket sits in a frozen round for good, unscored and unremovable.
 * Both are refused here, so it does not matter which door the ticket came
 * through: the JIRA import, the CSV import, or "add to round".
 */
export function assertRoundAcceptsTickets(round: Round): void {
  if (round.status === 'FINALISED') {
    throw new HttpishError(409, `${round.weekLabel} is finalised — its tickets and scores cannot be changed`);
  }
  if (round.status === 'CLOSED') {
    throw new HttpishError(
      409,
      `${round.weekLabel} is closed, so nobody can score a ticket added to it. Reopen the round, or import into the next one.`,
    );
  }
}

export async function addTicketToRound(db: Db, roundId: string, ticketId: string, position?: number): Promise<void> {
  const round = await getRound(db, roundId);
  if (!round) throw new HttpishError(404, 'Round not found');
  assertRoundAcceptsTickets(round);

  const existing = await db.get('SELECT ticket_id FROM round_tickets WHERE round_id = ? AND ticket_id = ?', [
    roundId,
    ticketId,
  ]);
  if (existing) return;
  const max = await db.get<{ max_position: number | null }>(
    'SELECT MAX(position) AS max_position FROM round_tickets WHERE round_id = ?',
    [roundId],
  );
  const nextPosition = position ?? Number(max?.max_position ?? 0) + 1;
  await db.run('INSERT INTO round_tickets (round_id, ticket_id, position, added_at) VALUES (?, ?, ?, ?)', [
    roundId,
    ticketId,
    nextPosition,
    nowIso(),
  ]);
}

/**
 * Take a ticket out of a round, along with the scores given to it in that
 * round - otherwise those submissions linger, show up under "who scored what",
 * and come back if the ticket is added again.
 *
 * Refused on a finalised round: those results are frozen and written back to
 * JIRA, so removing a ticket would rewrite history.
 */
export async function removeTicketFromRound(
  db: Db,
  roundId: string,
  ticketId: string,
): Promise<{ submissionsRemoved: number }> {
  const round = await getRound(db, roundId);
  if (!round) throw new HttpishError(404, 'Round not found');
  if (round.status === 'FINALISED') {
    throw new HttpishError(409, 'This round is finalised — its tickets and scores cannot be changed');
  }

  const row = await db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM submissions WHERE round_id = ? AND ticket_id = ?',
    [roundId, ticketId],
  );
  const submissionsRemoved = Number(row?.count ?? 0);

  await db.tx(async (tx) => {
    // submission_scores cascade from submissions.
    await tx.run('DELETE FROM submissions WHERE round_id = ? AND ticket_id = ?', [roundId, ticketId]);
    await tx.run('DELETE FROM ticket_results WHERE round_id = ? AND ticket_id = ?', [roundId, ticketId]);
    await tx.run('DELETE FROM round_tickets WHERE round_id = ? AND ticket_id = ?', [roundId, ticketId]);
  });

  return { submissionsRemoved };
}

export async function reorderRoundTickets(db: Db, roundId: string, ticketIds: string[]): Promise<void> {
  await db.tx(async (tx) => {
    for (const [index, ticketId] of ticketIds.entries()) {
      await tx.run('UPDATE round_tickets SET position = ? WHERE round_id = ? AND ticket_id = ?', [
        index + 1,
        roundId,
        ticketId,
      ]);
    }
  });
}

/** Scoring is accepted while the round is OPEN and the cut-off has not passed (§11). */
export function isScoringOpen(round: Round, at: Date = new Date()): boolean {
  return round.status === 'OPEN' && !isPast(round.cutOffAt, at);
}

export class HttpishError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpishError';
  }
}

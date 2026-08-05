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
  input: { weekLabel: string; cutOffAt: string; stream?: Stream; notes?: string; createdBy?: string },
): Promise<Round> {
  const id = newId();
  const now = nowIso();
  await db.run(
    `INSERT INTO rounds (id, week_label, cut_off_at, status, stream, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
    [id, input.weekLabel, input.cutOffAt, input.stream ?? 'ECOM', input.notes ?? '', input.createdBy ?? null, now, now],
  );
  return (await getRound(db, id)) as Round;
}

export async function updateRound(
  db: Db,
  id: string,
  input: { weekLabel?: string; cutOffAt?: string; notes?: string; stream?: Stream },
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
  if (!sets.length) return getRound(db, id);
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  await db.run(`UPDATE rounds SET ${sets.join(', ')} WHERE id = ?`, params);
  return getRound(db, id);
}

const ALLOWED_TRANSITIONS: Record<RoundStatus, RoundStatus[]> = {
  DRAFT: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['OPEN', 'FINALISED'],
  FINALISED: [],
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

export async function addTicketToRound(db: Db, roundId: string, ticketId: string, position?: number): Promise<void> {
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

export async function removeTicketFromRound(db: Db, roundId: string, ticketId: string): Promise<void> {
  await db.run('DELETE FROM round_tickets WHERE round_id = ? AND ticket_id = ?', [roundId, ticketId]);
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

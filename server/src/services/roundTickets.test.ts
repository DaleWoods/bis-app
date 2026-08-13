import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, listCategories } from './configService.js';
import { addTicketToRound, createRound, setRoundStatus, type Round } from './roundService.js';
import { upsertTicket } from './ticketService.js';

/**
 * Reported in testing: a round that had been closed and written back to JIRA
 * still accepted an import. The tickets landed in it unscoreable, and
 * removeTicketFromRound then refused to take them out again because the round
 * was finalised - so they were stuck there.
 */
let db: Db;
let round: Round;
let ticketId: string;

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  round = await createRound(db, { weekLabel: 'Week 1', cutOffAt: '2099-01-01T00:00:00.000Z' });
  ticketId = (await upsertTicket(db, { jiraId: 'ECOM-1', title: 'A ticket' })).id;
});

afterEach(async () => {
  await db.close();
});

describe('adding a ticket to a round', () => {
  it('is allowed while the round is a draft', async () => {
    await addTicketToRound(db, round.id, ticketId);
    const rows = await db.all('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [round.id]);
    expect(rows).toHaveLength(1);
  });

  it('is allowed while the round is open', async () => {
    round = await setRoundStatus(db, round.id, 'OPEN');
    await addTicketToRound(db, round.id, ticketId);
    const rows = await db.all('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [round.id]);
    expect(rows).toHaveLength(1);
  });

  it('is refused once the round is closed, because nobody can score it', async () => {
    await setRoundStatus(db, round.id, 'OPEN');
    await setRoundStatus(db, round.id, 'CLOSED');

    await expect(addTicketToRound(db, round.id, ticketId)).rejects.toThrow(/closed/i);
    const rows = await db.all('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [round.id]);
    expect(rows).toHaveLength(0);
  });

  it('is refused once the round is finalised, because it could never be undone', async () => {
    await setRoundStatus(db, round.id, 'OPEN');
    await setRoundStatus(db, round.id, 'CLOSED');
    await setRoundStatus(db, round.id, 'FINALISED');

    await expect(addTicketToRound(db, round.id, ticketId)).rejects.toThrow(/finalised/i);
  });
});

describe('the scoring categories', () => {
  it('label the bottom of every scale the same way', async () => {
    const categories = await listCategories(db);
    expect(categories).toHaveLength(7);
    expect([...new Set(categories.map((c) => c.zeroLabel))]).toEqual(['Not Impacted']);
  });
});

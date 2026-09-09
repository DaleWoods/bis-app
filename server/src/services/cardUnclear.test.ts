import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getAppConfig, listCategories } from './configService.js';
import { addTicketToRound, createRound, setRoundStatus, type Round } from './roundService.js';
import { getTicket, upsertTicket } from './ticketService.js';
import { saveMember, type Member } from './memberService.js';
import { listRoundSubmissions, saveSubmission, setSubmissionArchived } from './submissionService.js';

/**
 * §4 recommendation: a scorer's own signal that a card was too thin to score
 * from, distinct from the free-text "Notes or questions" field. These tests
 * cover the one thing that matters about it - it round-trips through a save
 * and is visible to the coordinator per submission.
 */

let db: Db;
let round: Round;
let ticketId: string;
let alice: Member;

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  alice = await saveMember(db, { name: 'Alice', email: 'alice@example.com', team: 'Trading', role: 'COMMITTEE' });
  round = await createRound(db, { weekLabel: 'Week 1', cutOffAt: '2099-01-01T00:00:00.000Z' });
  round = await setRoundStatus(db, round.id, 'OPEN');
  const ticket = await upsertTicket(db, { jiraId: 'ECOM-1', title: 'A ticket' });
  await addTicketToRound(db, round.id, ticket.id);
  ticketId = ticket.id;
});

afterEach(async () => {
  await db.close();
});

async function scoreWith(cardUnclear: boolean | undefined) {
  const categories = await listCategories(db);
  return saveSubmission(db, {
    round,
    ticket: (await getTicket(db, ticketId))!,
    member: alice,
    payload: {
      relevance: 'YES',
      scores: Object.fromEntries(categories.map((c) => [c.id, 5])),
      cardUnclear,
    },
    config: (await getAppConfig(db)).scoring,
  });
}

describe('cardUnclear', () => {
  it('defaults to false when not sent', async () => {
    const submission = await scoreWith(undefined);
    expect(submission.cardUnclear).toBe(false);
  });

  it('is recorded and readable back on the submission', async () => {
    const submission = await scoreWith(true);
    expect(submission.cardUnclear).toBe(true);
  });

  it('is visible to the coordinator alongside everyone else’s submissions', async () => {
    await scoreWith(true);
    const submissions = await listRoundSubmissions(db, round.id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ memberId: alice.id, cardUnclear: true });
  });

  it('is still readable once the submission is excluded', async () => {
    const submission = await scoreWith(true);
    await setSubmissionArchived(db, submission.id, true);
    const submissions = await listRoundSubmissions(db, round.id);
    expect(submissions[0]).toMatchObject({ cardUnclear: true, archived: true });
  });
});

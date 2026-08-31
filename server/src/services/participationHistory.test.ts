import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getAppConfig, listCategories } from './configService.js';
import { addTicketToRound, createRound, setRoundStatus, type Round } from './roundService.js';
import { getTicket, upsertTicket } from './ticketService.js';
import { saveMember, type Member } from './memberService.js';
import { memberStreak, participationHistory, saveSubmission } from './submissionService.js';

let db: Db;
let alice: Member;
let bob: Member;

/** Open, with its tickets in - scoring happens against this, before it finalises. */
async function openRound(weekLabel: string, ticketCount = 1, cutOffAt = '2099-01-01T00:00:00.000Z'): Promise<Round> {
  let round = await createRound(db, { weekLabel, cutOffAt });
  round = await setRoundStatus(db, round.id, 'OPEN');
  for (let i = 0; i < ticketCount; i += 1) {
    const ticket = await upsertTicket(db, { jiraId: `ECOM-${weekLabel}-${i}`, title: 'A ticket' });
    await addTicketToRound(db, round.id, ticket.id);
  }
  return round;
}

async function finalise(round: Round): Promise<Round> {
  await setRoundStatus(db, round.id, 'CLOSED');
  return setRoundStatus(db, round.id, 'FINALISED');
}

async function score(round: Round, member: Member, ticketId: string): Promise<void> {
  const categories = await listCategories(db);
  await saveSubmission(db, {
    round,
    ticket: (await getTicket(db, ticketId))!,
    member,
    payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, 5])) },
    config: (await getAppConfig(db)).scoring,
  });
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  alice = await saveMember(db, { name: 'Alice', email: 'alice@example.com', team: 'Trading', role: 'COMMITTEE' });
  bob = await saveMember(db, { name: 'Bob', email: 'bob@example.com', team: 'Ops', role: 'COMMITTEE' });
});

afterEach(async () => {
  await db.close();
});

describe('participationHistory', () => {
  it('counts a round as completed only when every ticket in it was scored', async () => {
    const round1 = await openRound('Week 1', 2);
    const tickets = await db.all<{ ticket_id: string }>('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [round1.id]);

    // Alice scores both tickets - a complete round for her.
    for (const { ticket_id } of tickets) await score(round1, alice, ticket_id);
    // Bob only scores one of the two.
    await score(round1, bob, tickets[0].ticket_id);
    await finalise(round1);

    const history = await participationHistory(db, [alice, bob], 8);
    expect(history.find((h) => h.memberId === alice.id)).toMatchObject({ roundsCompleted: 1, roundsConsidered: 1 });
    expect(history.find((h) => h.memberId === bob.id)).toMatchObject({ roundsCompleted: 0, roundsConsidered: 1 });
  });

  it('only looks at the most recent `limit` finalised rounds', async () => {
    for (let i = 0; i < 5; i += 1) {
      // Distinct, increasing cut-offs so "most recent" is unambiguous.
      const round = await openRound(`Week ${i}`, 1, `2099-0${i + 1}-01T00:00:00.000Z`);
      const [{ ticket_id }] = await db.all<{ ticket_id: string }>('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [round.id]);
      // Alice only scores the last two rounds created (the two with the latest cut-off).
      if (i >= 3) await score(round, alice, ticket_id);
      await finalise(round);
    }

    const history = await participationHistory(db, [alice], 2);
    expect(history[0]).toMatchObject({ roundsCompleted: 2, roundsConsidered: 2 });
  });

  it('leaves an empty round out of both sides of the fraction', async () => {
    await createRound(db, { weekLabel: 'Empty week', cutOffAt: '2099-01-01T00:00:00.000Z' });
    // Not finalised, and has no tickets - neither should count.
    const history = await participationHistory(db, [alice], 8);
    expect(history[0]).toMatchObject({ roundsCompleted: 0, roundsConsidered: 0 });
  });
});

describe('memberStreak', () => {
  /** `count` finalised rounds of one ticket each, oldest first, scored by whoever `scoredBy` says. */
  async function finalisedRounds(count: number, scoredBy: (index: number) => Member[]): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const round = await openRound(`Week ${i}`, 1, `2099-0${i + 1}-01T00:00:00.000Z`);
      const [{ ticket_id }] = await db.all<{ ticket_id: string }>(
        'SELECT ticket_id FROM round_tickets WHERE round_id = ?',
        [round.id],
      );
      for (const member of scoredBy(i)) await score(round, member, ticket_id);
      await finalise(round);
    }
  }

  it('counts back from the most recent round and stops at the first one missed', async () => {
    // Alice scores rounds 0, 2, 3 - so counting back from the newest her run is 2, not 3.
    await finalisedRounds(4, (i) => (i === 1 ? [] : [alice]));
    expect(await memberStreak(db, alice.id)).toBe(2);
  });

  it('is zero for somebody who missed the most recent round, however many they did before', async () => {
    await finalisedRounds(3, (i) => (i === 2 ? [] : [alice]));
    expect(await memberStreak(db, alice.id)).toBe(0);
  });

  it('does not count a round that is still open', async () => {
    await finalisedRounds(1, () => [alice]);
    const open = await openRound('This week', 1);
    const [{ ticket_id }] = await db.all<{ ticket_id: string }>('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [
      open.id,
    ]);
    await score(open, alice, ticket_id);
    // The round she just finished has not finalised, so it is not part of the run yet.
    expect(await memberStreak(db, alice.id)).toBe(1);
  });

  it('does not break a run on a ticket the committee was never shown', async () => {
    await finalisedRounds(2, () => [alice]);
    const round = await openRound('Held week', 2, '2099-09-01T00:00:00.000Z');
    const tickets = await db.all<{ ticket_id: string }>('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [
      round.id,
    ]);
    // One ticket is held back, so only the other one ever reached her.
    await db.run('UPDATE round_tickets SET held = 1 WHERE round_id = ? AND ticket_id = ?', [
      round.id,
      tickets[1].ticket_id,
    ]);
    await score(round, alice, tickets[0].ticket_id);
    await finalise(round);
    expect(await memberStreak(db, alice.id)).toBe(3);
  });

  it('is zero when nothing has finalised yet', async () => {
    await openRound('This week', 1);
    expect(await memberStreak(db, alice.id)).toBe(0);
  });
});

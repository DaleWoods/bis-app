import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getScoringConfig, listCategories } from './configService.js';
import { snapshotRoundResults } from './resultService.js';
import { addTicketToRound, createRound, setRoundStatus, type Round } from './roundService.js';
import { saveMember, type Member } from './memberService.js';
import { saveSubmission } from './submissionService.js';
import { upsertTicket } from './ticketService.js';
import { buildAnalytics } from './analyticsService.js';

let db: Db;
let members: Member[];

async function finalise(round: Round): Promise<Round> {
  await setRoundStatus(db, round.id, 'CLOSED');
  const finalised = await setRoundStatus(db, round.id, 'FINALISED');
  await snapshotRoundResults(db, finalised);
  return finalised;
}

/** A finalised round with one ticket, scored by three members with the given per-category values. */
async function finalisedRound(weekLabel: string, cutOffAt: string, scores: Record<string, number>[]): Promise<Round> {
  let round = await createRound(db, { weekLabel, cutOffAt });
  round = await setRoundStatus(db, round.id, 'OPEN');
  const ticket = await upsertTicket(db, { jiraId: `ECOM-${Math.floor(Math.random() * 1_000_000)}`, title: 'A ticket' });
  await addTicketToRound(db, round.id, ticket.id);

  const config = await getScoringConfig(db);
  for (const [i, categoryScores] of scores.entries()) {
    await saveSubmission(db, {
      round,
      ticket,
      member: members[i],
      config,
      payload: { relevance: 'YES', scores: categoryScores },
    });
  }
  return finalise(round);
}

/** Nobody scored it - the "Unsure" answer, or nobody responded at all. */
async function unscoredRound(weekLabel: string, cutOffAt: string): Promise<Round> {
  let round = await createRound(db, { weekLabel, cutOffAt });
  round = await setRoundStatus(db, round.id, 'OPEN');
  const ticket = await upsertTicket(db, { jiraId: `ECOM-${Math.floor(Math.random() * 1_000_000)}`, title: 'Nobody scored this' });
  await addTicketToRound(db, round.id, ticket.id);
  await saveSubmission(db, {
    round,
    ticket,
    member: members[0],
    config: await getScoringConfig(db),
    payload: { relevance: 'UNSURE' },
  });
  return finalise(round);
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  members = await Promise.all(
    [0, 1, 2].map((i) => saveMember(db, { name: `M${i}`, email: `m${i}@example.com`, team: 'Trading', role: 'COMMITTEE' })),
  );
});

afterEach(async () => {
  await db.close();
});

describe('buildAnalytics', () => {
  it('is empty with no finalised rounds', async () => {
    const analytics = await buildAnalytics(db);
    expect(analytics.rounds).toEqual([]);
    expect(analytics.categoryDrivers).toEqual([]);
  });

  it('summarises a finalised round: average business score, ticket count, scorers', async () => {
    const categories = await listCategories(db);
    const flat = Object.fromEntries(categories.map((c) => [c.id, 5]));
    const round = await finalisedRound('Week 1', '2099-01-01T00:00:00.000Z', [flat, flat, flat]);

    const { rounds } = await buildAnalytics(db);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      roundId: round.id,
      weekLabel: 'Week 1',
      ticketCount: 1,
      avgBusinessScore: 5 * categories.length,
      scorers: 3,
    });
  });

  it('orders rounds oldest first and respects the limit', async () => {
    const categories = await listCategories(db);
    const flat = Object.fromEntries(categories.map((c) => [c.id, 5]));
    await finalisedRound('Week 1', '2099-01-01T00:00:00.000Z', [flat]);
    await finalisedRound('Week 2', '2099-01-08T00:00:00.000Z', [flat]);
    await finalisedRound('Week 3', '2099-01-15T00:00:00.000Z', [flat]);

    const { rounds } = await buildAnalytics(db, 2);
    expect(rounds.map((r) => r.weekLabel)).toEqual(['Week 2', 'Week 3']);
  });

  it('finds which category most often drove a ticket highest and lowest', async () => {
    const categories = await listCategories(db);
    const [first, ...rest] = categories;
    const low = (value: number) => Object.fromEntries([...rest.map((c) => [c.id, value] as const), [first.id, 10]]);
    // Ticket 1: first category always 10, everything else 2 - first wins highest.
    await finalisedRound('Week 1', '2099-01-01T00:00:00.000Z', [low(2), low(2), low(2)]);
    // Ticket 2: same shape, a different round.
    await finalisedRound('Week 2', '2099-01-08T00:00:00.000Z', [low(2), low(2), low(2)]);

    const { categoryDrivers } = await buildAnalytics(db);
    const winner = categoryDrivers.find((d) => d.categoryId === first.id)!;
    expect(winner.timesHighest).toBe(2);
    expect(winner.timesLowest).toBe(0);
    expect(winner.avgScore).toBe(10);

    const loser = categoryDrivers.find((d) => d.categoryId === rest[0].id)!;
    expect(loser.timesLowest).toBe(2);
    expect(loser.avgScore).toBe(2);
  });

  it('leaves a ticket nobody scored out of the category drivers', async () => {
    await unscoredRound('Week 1', '2099-01-01T00:00:00.000Z');
    const { categoryDrivers, rounds } = await buildAnalytics(db);
    // The round itself still shows up, just with nothing to average.
    expect(rounds).toHaveLength(1);
    expect(rounds[0].avgBusinessScore).toBeNull();
    expect(categoryDrivers).toEqual([]);
  });
});

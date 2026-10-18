import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getScoringConfig, listCategories } from './configService.js';
import { snapshotRoundResults } from './resultService.js';
import { addTicketToRound, createRound, setRoundStatus, type Round } from './roundService.js';
import { saveMember, type Member } from './memberService.js';
import { saveSubmission } from './submissionService.js';
import { upsertTicket } from './ticketService.js';
import { buildAnalytics, buildAnalyticsContext } from './analyticsService.js';

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

describe('buildAnalyticsContext', () => {
  it('says plainly there is nothing yet, with no finalised rounds', async () => {
    const context = await buildAnalyticsContext(db);
    expect(context).toContain('No finalised rounds yet');
  });

  it('includes the round, ticket and score for something the assistant might be asked about', async () => {
    const categories = await listCategories(db);
    const flat = Object.fromEntries(categories.map((c) => [c.id, 5]));
    await finalisedRound('Week 1', '2099-01-01T00:00:00.000Z', [flat, flat, flat]);

    const context = await buildAnalyticsContext(db);
    expect(context).toContain('round="Week 1"');
    expect(context).toContain(`businessScore=${5 * categories.length}`);
  });

  it("resolves a ticket's requestor to their team when the requestor is a known member", async () => {
    let round = await createRound(db, { weekLabel: 'Week 1', cutOffAt: '2099-01-01T00:00:00.000Z' });
    round = await setRoundStatus(db, round.id, 'OPEN');
    const ticket = await upsertTicket(db, {
      jiraId: 'ECOM-9001',
      title: 'Raised by Trading',
      originalRequestor: members[0].email.toUpperCase(), // case shouldn't matter
    });
    await addTicketToRound(db, round.id, ticket.id);
    await finalise(round);

    const context = await buildAnalyticsContext(db);
    expect(context).toContain('requestorTeam=Trading');
  });

  it('says "unknown" rather than guessing when the requestor is not on the committee', async () => {
    let round = await createRound(db, { weekLabel: 'Week 1', cutOffAt: '2099-01-01T00:00:00.000Z' });
    round = await setRoundStatus(db, round.id, 'OPEN');
    const ticket = await upsertTicket(db, {
      jiraId: 'ECOM-9002',
      title: 'Raised by nobody on the committee',
      originalRequestor: 'someone-external@example.com',
    });
    await addTicketToRound(db, round.id, ticket.id);
    await finalise(round);

    const context = await buildAnalyticsContext(db);
    expect(context).toContain('requestorTeam=unknown');
  });

  it('finds the category the committee splits on most', async () => {
    const categories = await listCategories(db);
    const [split, ...rest] = categories;
    // Everyone agrees on every category except the first, where they are 0, 5 and 10.
    const marks = [0, 5, 10].map((m) => ({ ...Object.fromEntries(rest.map((c) => [c.id, 4])), [split.id]: m }));
    await finalisedRound('W1', '2099-01-06T17:00:00.000Z', marks);

    const { categoryDrivers } = await buildAnalytics(db);
    const top = categoryDrivers.find((d) => d.categoryId === split.id)!;
    expect(top.timesMostSplit).toBe(1);
    expect(top.avgSpread).toBeCloseTo(5, 5);
    const calm = categoryDrivers.find((d) => d.categoryId === rest[0].id)!;
    expect(calm).toMatchObject({ timesMostSplit: 0, avgSpread: 0 });
  });
});

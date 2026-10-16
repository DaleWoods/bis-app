import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getAppConfig, listCategories } from './configService.js';
import { addTicketToRound, createRound, getRound, setRoundStatus, type Round } from './roundService.js';
import { getTicket, upsertTicket } from './ticketService.js';
import { saveMember, type Member } from './memberService.js';
import { saveSubmission } from './submissionService.js';
import { snapshotRoundResults } from './resultService.js';
import { buildLeague } from './leagueService.js';
import { DEFAULT_LEAGUE_CONFIG, type LeagueConfig } from '../domain/types.js';

let db: Db;
let alice: Member;
let bob: Member;
let cara: Member;

const rules: LeagueConfig = {
  enabled: true,
  seasonRounds: 8,
  pointsPerTicket: 10,
  fullRoundBonus: 25,
  earlyFinisherBonus: 15,
  earlyFinisherPlaces: 1,
};

async function openRound(weekLabel: string, ticketCount: number, cutOffAt: string): Promise<Round> {
  let round = await createRound(db, { weekLabel, cutOffAt });
  round = await setRoundStatus(db, round.id, 'OPEN');
  for (let i = 0; i < ticketCount; i += 1) {
    const ticket = await upsertTicket(db, { jiraId: `ECOM-${weekLabel}-${i}`, title: 'A ticket' });
    await addTicketToRound(db, round.id, ticket.id);
  }
  return round;
}

async function ticketsOf(round: Round): Promise<string[]> {
  const rows = await db.all<{ ticket_id: string }>('SELECT ticket_id FROM round_tickets WHERE round_id = ?', [round.id]);
  return rows.map((r) => r.ticket_id);
}

async function finalise(round: Round): Promise<void> {
  await setRoundStatus(db, round.id, 'CLOSED');
  await setRoundStatus(db, round.id, 'FINALISED');
  await snapshotRoundResults(db, (await getRound(db, round.id))!);
}

/** Answer `count` of the round's tickets, all at `mark`, finishing at `at` so finishing order is explicit. */
async function answer(round: Round, member: Member, count: number, at: string, mark = 5): Promise<void> {
  const categories = await listCategories(db);
  const tickets = (await ticketsOf(round)).slice(0, count);
  for (const ticketId of tickets) {
    await saveSubmission(db, {
      round,
      ticket: (await getTicket(db, ticketId))!,
      member,
      payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, mark])) },
      config: (await getAppConfig(db)).scoring,
      at: new Date(at),
    });
  }
  await db.run('UPDATE submissions SET updated_at = ? WHERE round_id = ? AND member_id = ?', [at, round.id, member.id]);
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  alice = await saveMember(db, { name: 'Alice', email: 'alice@example.com', team: 'Trading', role: 'COMMITTEE' });
  bob = await saveMember(db, { name: 'Bob', email: 'bob@example.com', team: 'Ops', role: 'COMMITTEE' });
  cara = await saveMember(db, { name: 'Cara', email: 'cara@example.com', team: 'Ops', role: 'COMMITTEE' });
});

afterEach(async () => {
  await db.close();
});

describe('buildLeague', () => {
  it('awards points per ticket, for finishing, and for finishing first', async () => {
    const round = await openRound('W1', 2, '2099-01-06T17:00:00.000Z');
    await answer(round, bob, 2, '2099-01-02T09:00:00.000Z'); // finished, and first
    await answer(round, alice, 2, '2099-01-03T09:00:00.000Z'); // finished, second
    await answer(round, cara, 1, '2099-01-01T09:00:00.000Z'); // earliest, but did not finish
    await finalise(round);

    const league = await buildLeague(db, [alice, bob, cara], rules);
    const row = (m: Member) => league.rows.find((r) => r.memberId === m.id)!;
    expect(row(bob)).toMatchObject({ rank: 1, points: 20 + 25 + 15, firstPlaces: 1, roundsCompleted: 1 });
    expect(row(alice)).toMatchObject({ rank: 2, points: 20 + 25, firstPlaces: 0 });
    expect(row(cara)).toMatchObject({ rank: 3, points: 10, roundsCompleted: 0, roundsEligible: 1 });
    expect(league.latestRound).toEqual({ weekLabel: 'W1', firstFinisher: 'Bob' });
    expect(row(bob).badges).toContain('early-bird');
  });

  it('never rewards what was scored, only taking part', async () => {
    const round = await openRound('W1', 1, '2099-01-06T17:00:00.000Z');
    await answer(round, alice, 1, '2099-01-02T09:00:00.000Z', 0);
    await answer(round, bob, 1, '2099-01-02T09:00:00.000Z', 10);
    await finalise(round);

    const league = await buildLeague(db, [alice, bob], { ...rules, earlyFinisherPlaces: 0 });
    const [a, b] = [alice, bob].map((m) => league.rows.find((r) => r.memberId === m.id)!);
    expect(a.points).toBe(b.points);
    // An exact tie shares the place rather than splitting it on the alphabet.
    expect(a.rank).toBe(1);
    expect(b.rank).toBe(1);
  });

  it('ignores a round that is still open', async () => {
    const done = await openRound('W1', 1, '2099-01-06T17:00:00.000Z');
    await answer(done, alice, 1, '2099-01-02T09:00:00.000Z');
    await finalise(done);
    const open = await openRound('W2', 1, '2099-01-13T17:00:00.000Z');
    await answer(open, bob, 1, '2099-01-09T09:00:00.000Z');

    const league = await buildLeague(db, [alice, bob], rules);
    expect(league.roundsInSeason).toBe(1);
    expect(league.rows.find((r) => r.memberId === bob.id)!.points).toBe(0);
  });

  it('does not count a round that closed before somebody joined against them', async () => {
    const early = await openRound('W1', 1, '2000-01-04T17:00:00.000Z');
    await answer(early, alice, 1, '2000-01-02T09:00:00.000Z');
    await finalise(early);
    const later = await openRound('W2', 1, '2099-01-06T17:00:00.000Z');
    await answer(later, alice, 1, '2099-01-02T09:00:00.000Z');
    await answer(later, bob, 1, '2099-01-03T09:00:00.000Z');
    await finalise(later);

    const league = await buildLeague(db, [alice, bob], rules);
    // Bob was created today, after W1 closed in 2000.
    expect(league.rows.find((r) => r.memberId === bob.id)).toMatchObject({ roundsEligible: 1, roundsCompleted: 1, completionRate: 1 });
    expect(league.rows.find((r) => r.memberId === alice.id)).toMatchObject({ roundsEligible: 2, roundsCompleted: 2 });
  });

  it('shows movement since the latest round, and a comeback for finishing after a miss', async () => {
    const r1 = await openRound('W1', 1, '2099-01-06T17:00:00.000Z');
    await answer(r1, alice, 1, '2099-01-02T09:00:00.000Z');
    await answer(r1, bob, 1, '2099-01-03T09:00:00.000Z');
    await finalise(r1);
    const r2 = await openRound('W2', 1, '2099-01-13T17:00:00.000Z');
    await answer(r2, alice, 1, '2099-01-09T09:00:00.000Z');
    await finalise(r2);
    const r3 = await openRound('W3', 3, '2099-01-20T17:00:00.000Z');
    await answer(r3, bob, 3, '2099-01-16T09:00:00.000Z');
    await finalise(r3);

    const league = await buildLeague(db, [alice, bob], rules);
    const b = league.rows.find((r) => r.memberId === bob.id)!;
    const a = league.rows.find((r) => r.memberId === alice.id)!;
    expect(b).toMatchObject({ rank: 1, previousRank: 2, movement: 1 });
    expect(a).toMatchObject({ rank: 2, previousRank: 1, movement: -1 });
    expect(b.badges).toContain('comeback');
    expect(a.badges).not.toContain('comeback');
  });

  it('only counts the configured season', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const round = await openRound(`W${i}`, 1, `2099-0${i}-06T17:00:00.000Z`);
      await answer(round, alice, 1, `2099-0${i}-02T09:00:00.000Z`);
      await finalise(round);
    }
    const league = await buildLeague(db, [alice], { ...rules, seasonRounds: 2 });
    expect(league.roundsInSeason).toBe(2);
    expect(league.rows[0]).toMatchObject({ roundsCompleted: 2, ticketsAnswered: 2 });
    expect(league.rows[0].badges).toContain('ever-present');
  });

  it('works out how much steadier the average would be if everyone scored', async () => {
    const round = await openRound('W1', 1, '2099-01-06T17:00:00.000Z');
    await answer(round, alice, 1, '2099-01-02T09:00:00.000Z', 2);
    await answer(round, bob, 1, '2099-01-02T09:00:00.000Z', 8);
    await finalise(round);

    const four = [alice, bob, cara, await saveMember(db, { name: 'Dev', email: 'dev@example.com', role: 'COMMITTEE' })];
    const league = await buildLeague(db, four, rules);
    expect(league.coverage.committeeSize).toBe(4);
    expect(league.coverage.avgResponsesPerTicket).toBe(2);
    expect(league.coverage.marginNow).not.toBeNull();
    expect(league.coverage.marginIfEveryone!).toBeLessThan(league.coverage.marginNow!);
  });

  it('shows nothing when switched off', async () => {
    const round = await openRound('W1', 1, '2099-01-06T17:00:00.000Z');
    await answer(round, alice, 1, '2099-01-02T09:00:00.000Z');
    await finalise(round);
    const league = await buildLeague(db, [alice], { ...rules, enabled: false });
    expect(league.enabled).toBe(false);
    expect(league.rows).toEqual([]);
  });

  it('ships switched on, with the defaults the guide describes', async () => {
    expect((await getAppConfig(db)).league).toEqual(DEFAULT_LEAGUE_CONFIG);
  });
});

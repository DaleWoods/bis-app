import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';

/**
 * The reported bug: a finalised round said "0 written, 1 skipped, 0 failed" and
 * gave no reason, so it read as broken when it was working exactly as §10 says.
 * The reason is the answer; these tests hold on to it.
 */

const writeBusinessScore = vi.fn();
const transitionIssue = vi.fn();

vi.mock('../integrations/jira.js', () => ({
  writeBusinessScore,
  transitionIssue,
  JiraNotConfiguredError: class extends Error {},
}));

vi.mock('../config/env.js', () => ({
  env: { jira: { configured: true, baseUrl: 'https://example.atlassian.net', email: 'a@b.c', apiToken: 'x' } },
}));

const { ensureDefaultConfig, ensureSeedCategories, saveConfigSection, listCategories, getAppConfig } = await import('./configService.js');
const { writeBackRound } = await import('./jiraService.js');
const { createRound, addTicketToRound, getRound, setRoundStatus } = await import('./roundService.js');
const { upsertTicket, getTicket } = await import('./ticketService.js');
const { saveMember } = await import('./memberService.js');
const { saveSubmission } = await import('./submissionService.js');
const { recordDiscussion } = await import('./discussionService.js');

let db: Db;
let roundId: string;
let ticketId: string;

const ACTOR = { id: 'test', email: 'test@example.com' };

/** `count` committee members each give the ticket a 5 in every category. */
async function scoreIt(count: number, relevance: 'YES' | 'UNSURE' = 'YES') {
  const config = await getAppConfig(db);
  const categories = await listCategories(db);
  const scores = Object.fromEntries(categories.map((c) => [c.id, 5]));
  const round = (await getRound(db, roundId))!;
  const ticket = (await getTicket(db, ticketId))!;

  for (let i = 0; i < count; i += 1) {
    const member = await saveMember(db, {
      name: `Scorer ${i}`,
      email: `scorer${i}@example.com`,
      team: 'Trading',
      role: 'COMMITTEE',
    });
    await saveSubmission(db, {
      round,
      ticket,
      member,
      payload: { relevance, scores: relevance === 'YES' ? scores : undefined },
      config: config.scoring,
    });
  }
}

/**
 * One member per entry, each giving every category that number - so [0, 10] is
 * the 0/70 against 70/70 split that started all this.
 */
async function scoreEach(perCategory: number[]) {
  const config = await getAppConfig(db);
  const categories = await listCategories(db);
  const round = (await getRound(db, roundId))!;
  const ticket = (await getTicket(db, ticketId))!;

  for (const [i, value] of perCategory.entries()) {
    const member = await saveMember(db, {
      name: `Split ${i}`,
      email: `split${i}@example.com`,
      team: 'Trading',
      role: 'COMMITTEE',
    });
    await saveSubmission(db, {
      round,
      ticket,
      member,
      payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, value])) },
      config: config.scoring,
    });
  }
}

beforeEach(async () => {
  writeBusinessScore.mockReset().mockResolvedValue(undefined);
  transitionIssue.mockReset().mockResolvedValue('Ready for Estimation');

  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  await saveConfigSection(db, 'jira', { businessScoreFieldId: 'customfield_101' }, 'test');

  // Far-future cut-off and OPEN, because scoring is only accepted on an open
  // round that has not reached its cut-off.
  const round = await createRound(db, { weekLabel: 'Week 1', cutOffAt: '2099-01-01T00:00:00.000Z' });
  roundId = round.id;
  await setRoundStatus(db, roundId, 'OPEN');
  const ticket = await upsertTicket(db, { jiraId: 'ECOM-2463', title: 'test dale (ignore)' });
  ticketId = ticket.id;
  await addTicketToRound(db, roundId, ticketId);
});

afterEach(async () => {
  await db.close();
});

describe('writeBackRound', () => {
  it('says how many responses were short of the minimum, not just "skipped"', async () => {
    await scoreIt(2); // minSubmissions defaults to 5

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    expect(entry.status).toBe('SKIPPED');
    expect(entry.reason).toContain('2 of the 5 responses needed');
    expect(entry.businessScore).not.toBeNull();
    expect(writeBusinessScore).not.toHaveBeenCalled();
  });

  it('explains a shortfall caused by non-Yes answers, not just a low count', async () => {
    // The reported case: 4 people submitted, the gate said "3 of 5" with
    // nothing to say why - it read as a bug (5 responses, still refused) when
    // one of the 4 had actually answered "Unsure", which does not count as a
    // response at all (§10.1).
    const config = await getAppConfig(db);
    const categories = await listCategories(db);
    const scores = Object.fromEntries(categories.map((c) => [c.id, 5]));
    const round = (await getRound(db, roundId))!;
    const ticket = (await getTicket(db, ticketId))!;
    const relevances: Array<'YES' | 'UNSURE'> = ['YES', 'YES', 'YES', 'UNSURE'];
    for (const [i, relevance] of relevances.entries()) {
      const member = await saveMember(db, { name: `Mix ${i}`, email: `mix${i}@example.com`, team: 'Trading', role: 'COMMITTEE' });
      await saveSubmission(db, { round, ticket, member, payload: { relevance, scores: relevance === 'YES' ? scores : undefined }, config: config.scoring });
    }

    const [entry] = await writeBackRound(db, ACTOR, round);
    expect(entry.status).toBe('SKIPPED');
    expect(entry.reason).toContain('3 of the 5 responses needed');
    expect(entry.reason).toContain('4 submitted in total');
    expect(entry.reason).toContain('1 answered something other than "Yes"');
  });

  it('writes it anyway when a coordinator overrides the gate', async () => {
    await scoreIt(2);

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!, { ignoreMinSubmissions: true });
    expect(entry.status).toBe('SUCCESS');
    expect(writeBusinessScore).toHaveBeenCalledWith('ECOM-2463', 'customfield_101', entry.businessScore);
  });

  it('writes without an override once the minimum is met', async () => {
    await scoreIt(5);

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    expect(entry.status).toBe('SUCCESS');
    expect(entry.businessScore).toBe(35);
  });

  it('explains a ticket nobody scored, rather than skipping it silently', async () => {
    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    expect(entry.status).toBe('SKIPPED');
    expect(entry.reason).toBe('Nobody has scored this ticket');
  });

  it('distinguishes "nobody scored it" from "nobody said it was relevant"', async () => {
    await scoreIt(1, 'UNSURE');

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    expect(entry.reason).toMatch(/Nobody answered "Yes"/);
  });

  it('does not write the same score twice, and says why', async () => {
    await scoreIt(5);
    const round = (await getRound(db, roundId))!;

    await writeBackRound(db, ACTOR, round);
    const [second] = await writeBackRound(db, ACTOR, round);

    expect(second.status).toBe('SKIPPED');
    expect(second.reason).toMatch(/already written/i);
    expect(writeBusinessScore).toHaveBeenCalledTimes(1);
  });

  it('moves a ticket on later, without writing its score again', async () => {
    // The reported case: the transition name was wrong, so the score went
    // across and the ticket stayed put. Correcting the name and re-running has
    // to be able to finish the job.
    await saveConfigSection(db, 'jira', { businessScoreFieldId: 'customfield_101', transitionOnFinalise: false }, 'test');
    await scoreIt(5);
    const round = (await getRound(db, roundId))!;

    expect((await writeBackRound(db, ACTOR, round))[0].status).toBe('SUCCESS');
    expect(transitionIssue).not.toHaveBeenCalled();

    await saveConfigSection(db, 'jira', { businessScoreFieldId: 'customfield_101', transitionOnFinalise: true }, 'test');
    const [second] = await writeBackRound(db, ACTOR, round);

    expect(second.status).toBe('SUCCESS');
    expect(second.transitionedTo).toBe('Ready for Estimation');
    expect(second.reason).toMatch(/already in JIRA/i);
    // The score was right the first time; re-writing it is noise on the ticket.
    expect(writeBusinessScore).toHaveBeenCalledTimes(1);
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  it('moves a ticket later that was written under the responses override, without needing the override again', async () => {
    // The reported case: a coordinator overrode the responses gate to get an
    // early score written, then came back to move the ticket - without the
    // override this time - and the plain retry refused, quoting the same
    // responses shortfall the write itself had already been forgiven for.
    // Once a score is written, that question is settled; only toClose and
    // discussionRequired should still gate the move.
    await saveConfigSection(db, 'jira', { businessScoreFieldId: 'customfield_101', transitionOnFinalise: false }, 'test');
    await scoreIt(2); // still short of the minimum of 5
    const round = (await getRound(db, roundId))!;

    const [first] = await writeBackRound(db, ACTOR, round, { ignoreMinSubmissions: true });
    expect(first.status).toBe('SUCCESS');
    expect(transitionIssue).not.toHaveBeenCalled();

    await saveConfigSection(db, 'jira', { businessScoreFieldId: 'customfield_101', transitionOnFinalise: true }, 'test');
    const [second] = await writeBackRound(db, ACTOR, round);

    expect(second.status).toBe('SUCCESS');
    expect(second.transitionedTo).toBe('Ready for Estimation');
    expect(writeBusinessScore).toHaveBeenCalledTimes(1);
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the ticket has actually moved', async () => {
    await scoreIt(5);
    const round = (await getRound(db, roundId))!;

    await writeBackRound(db, ACTOR, round);
    const [second] = await writeBackRound(db, ACTOR, round);

    expect(second.status).toBe('SKIPPED');
    expect(transitionIssue).toHaveBeenCalledTimes(1);
  });

  it('reports a JIRA failure with the message JIRA gave', async () => {
    await scoreIt(5);
    writeBusinessScore.mockRejectedValue(new Error('403 Field is not on the screen'));

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    expect(entry.status).toBe('FAILED');
    expect(entry.reason).toContain('Field is not on the screen');
  });

  it('retries a previously failed ticket on the next run', async () => {
    await scoreIt(5);
    const round = (await getRound(db, roundId))!;

    writeBusinessScore.mockRejectedValueOnce(new Error('timeout'));
    expect((await writeBackRound(db, ACTOR, round))[0].status).toBe('FAILED');
    expect((await writeBackRound(db, ACTOR, round))[0].status).toBe('SUCCESS');
  });

  it('moves the ticket on once the score is in JIRA', async () => {
    await scoreIt(5);

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    expect(entry.status).toBe('SUCCESS');
    expect(transitionIssue).toHaveBeenCalledWith('ECOM-2463', '[RA] Rdy Estimation');
    expect(entry.transitionedTo).toBe('Ready for Estimation');
  });

  it('keeps the score written when the transition is the thing that fails', async () => {
    await scoreIt(5);
    transitionIssue.mockRejectedValue(new Error('Transition is not valid from this status'));

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!);
    // The score landed. Calling the whole ticket FAILED would send a
    // coordinator chasing a score that is already there.
    expect(entry.status).toBe('SUCCESS');
    expect(entry.transitionedTo).toBe('');
    expect(entry.reason).toContain('Transition is not valid');
  });
});

/**
 * Dale's test round: two members, 0/70 and 70/70. The average of those is not a
 * number either of them agreed with, and the meeting about it might end in a
 * re-score - so nothing goes to JIRA until the meeting is recorded.
 */
describe('a ticket the committee was split on', () => {
  it('is held out of the write-back until the discussion is recorded', async () => {
    await scoreEach([0, 10]);

    const [entry] = await writeBackRound(db, ACTOR, (await getRound(db, roundId))!, { ignoreMinSubmissions: true });
    expect(entry.status).toBe('SKIPPED');
    expect(entry.reason).toContain('0 to 70');
    expect(writeBusinessScore).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('writes the agreed score, not the average, once the meeting has happened', async () => {
    await scoreEach([0, 10]);
    const round = (await getRound(db, roundId))!;
    await recordDiscussion(db, ACTOR, round, ticketId, { outcome: 'AGREED', agreedScore: 42 });

    const [entry] = await writeBackRound(db, ACTOR, round, { ignoreMinSubmissions: true });
    expect(entry.status).toBe('SUCCESS');
    expect(entry.businessScore).toBe(42);
    expect(writeBusinessScore).toHaveBeenCalledWith('ECOM-2463', 'customfield_101', 42);
    // Agreeing a score is what makes it ready, so it moves on like any other.
    expect(transitionIssue).toHaveBeenCalledWith('ECOM-2463', '[RA] Rdy Estimation');
  });

  it('stays out of JIRA when the meeting sends it back to be scored again', async () => {
    await scoreEach([0, 10]);
    const round = (await getRound(db, roundId))!;
    await recordDiscussion(db, ACTOR, round, ticketId, { outcome: 'RESCORE' });

    const [entry] = await writeBackRound(db, ACTOR, round, { ignoreMinSubmissions: true });
    expect(entry.status).toBe('SKIPPED');
    expect(entry.reason).toMatch(/scored again/);
    expect(writeBusinessScore).not.toHaveBeenCalled();
  });

  it('stays out of JIRA when the meeting decides to close it', async () => {
    await scoreEach([0, 10]);
    const round = (await getRound(db, roundId))!;
    await recordDiscussion(db, ACTOR, round, ticketId, { outcome: 'CLOSE' });

    const [entry] = await writeBackRound(db, ACTOR, round, { ignoreMinSubmissions: true });
    expect(entry.status).toBe('SKIPPED');
    expect(entry.reason).toMatch(/close/i);
    expect(writeBusinessScore).not.toHaveBeenCalled();
  });

  it('rewrites JIRA when the agreed score is changed afterwards', async () => {
    await scoreEach([0, 10]);
    const round = (await getRound(db, roundId))!;

    await recordDiscussion(db, ACTOR, round, ticketId, { outcome: 'AGREED', agreedScore: 42 });
    await writeBackRound(db, ACTOR, round, { ignoreMinSubmissions: true });

    await recordDiscussion(db, ACTOR, round, ticketId, { outcome: 'AGREED', agreedScore: 50 });
    const [entry] = await writeBackRound(db, ACTOR, round, { ignoreMinSubmissions: true });

    expect(entry.status).toBe('SUCCESS');
    expect(writeBusinessScore).toHaveBeenLastCalledWith('ECOM-2463', 'customfield_101', 50);
  });
});

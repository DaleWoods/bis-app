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
});

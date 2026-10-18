import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getAppConfig, listCategories } from './configService.js';
import { addTicketToRound, createRound, getRound, setRoundStatus } from './roundService.js';
import { getTicket, upsertTicket } from './ticketService.js';
import { saveMember, type Member } from './memberService.js';
import { saveSubmission } from './submissionService.js';
import { snapshotRoundResults } from './resultService.js';
import { closeFromMatrix, getMatrixView, recordReview, runMatrixSnapshotIfDue } from './matrixService.js';
import { DEFAULT_MATRIX_CONFIG } from '../domain/types.js';
import { env } from '../config/env.js';
import { addComment, searchHopper, transitionIssue } from '../integrations/jira.js';
import { saveConfigSection } from './configService.js';

vi.mock('../integrations/jira.js', () => ({ searchHopper: vi.fn(), transitionIssue: vi.fn(), addComment: vi.fn() }));

let db: Db;
let scorers: Member[];

/** One finalised round scoring the given tickets, every scorer giving `mark` in every category. */
async function scoreRound(label: string, cutOffAt: string, jiraIds: string[], mark: number): Promise<void> {
  let round = await createRound(db, { weekLabel: label, cutOffAt });
  round = await setRoundStatus(db, round.id, 'OPEN');
  const categories = await listCategories(db);
  for (const jiraId of jiraIds) {
    const ticket = await upsertTicket(db, { jiraId, title: `Ticket ${jiraId}` });
    await addTicketToRound(db, round.id, ticket.id);
    for (const member of scorers) {
      await saveSubmission(db, {
        round,
        ticket: (await getTicket(db, ticket.id))!,
        member,
        payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, mark])) },
        config: (await getAppConfig(db)).scoring,
      });
    }
  }
  await setRoundStatus(db, round.id, 'CLOSED');
  await setRoundStatus(db, round.id, 'FINALISED');
  await snapshotRoundResults(db, (await getRound(db, round.id))!);
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  scorers = [];
  for (let i = 0; i < 5; i += 1) {
    scorers.push(await saveMember(db, { name: `M${i}`, email: `m${i}@example.com`, role: 'COMMITTEE' }));
  }
});

afterEach(async () => {
  await db.close();
});

describe('getMatrixView without JIRA', () => {
  it("plots the app's latest committee score against the ticket's effort", async () => {
    await scoreRound('W1', '2099-01-06T17:00:00.000Z', ['ECOM-1', 'ECOM-2'], 2);
    await db.run("UPDATE tickets SET backend_poker_score = 8, frontend_poker_score = 5 WHERE jira_id = 'ECOM-1'");

    const view = await getMatrixView(db);
    expect(view.source).toBe('app');
    expect(view.sourceNote).toMatch(/not connected/);
    expect(view.points).toHaveLength(1);
    expect(view.points[0]).toMatchObject({ key: 'ECOM-1', effort: { backend: 8, frontend: 5, total: 13 } });
    // Seven categories at 2 each.
    expect(view.points[0].businessScore).toBe(14);
    // Scored but never estimated: listed, not silently dropped.
    expect(view.unestimated.map((u) => u.key)).toEqual(['ECOM-2']);
  });

  it('uses the most recent finalised score when a ticket was scored twice', async () => {
    await scoreRound('W1', '2099-01-06T17:00:00.000Z', ['ECOM-1'], 2);
    await scoreRound('W2', '2099-01-13T17:00:00.000Z', ['ECOM-1'], 6);
    await db.run("UPDATE tickets SET backend_poker_score = 8 WHERE jira_id = 'ECOM-1'");

    const view = await getMatrixView(db);
    expect(view.points).toHaveLength(1);
    expect(view.points[0].businessScore).toBe(42);
  });

  it('lets a manual effort replace the poker figures, as it does for priority', async () => {
    await scoreRound('W1', '2099-01-06T17:00:00.000Z', ['ECOM-1'], 3);
    await db.run("UPDATE tickets SET backend_poker_score = 8, manual_effort = 30 WHERE jira_id = 'ECOM-1'");
    expect((await getMatrixView(db)).points[0].effort.total).toBe(30);
  });

  it('carries the splits and priority bands from Settings', async () => {
    const view = await getMatrixView(db);
    expect(view.splits).toEqual({ value: DEFAULT_MATRIX_CONFIG.valueSplit, effort: DEFAULT_MATRIX_CONFIG.effortSplit });
    expect(view.priorityBands.high).toBeGreaterThan(view.priorityBands.medium);
  });
});

describe('getMatrixView with JIRA', () => {
  const saved = { baseUrl: env.jira.baseUrl, email: env.jira.email, apiToken: env.jira.apiToken };
  afterEach(() => {
    Object.assign(env.jira, saved);
    vi.mocked(searchHopper).mockReset();
  });

  it("reads the Queue tab's tickets, adding testing hours as points and skipping the -1 placeholder", async () => {
    Object.assign(env.jira, { baseUrl: 'https://example.atlassian.net', email: 'a@b.c', apiToken: 't' });
    await saveConfigSection(db, 'jira', { businessScoreFieldId: 'customfield_score' }, 'test');
    await saveConfigSection(db, 'scoring', { effort: { mode: 'BACKEND_PLUS_FRONTEND', backendFieldId: 'cf_be', frontendFieldId: 'cf_fe' } }, 'test');
    await saveConfigSection(db, 'queue', { hopperJql: 'status = "Rdy FE Dev"' }, 'test');
    await saveConfigSection(db, 'matrix', { testingFieldId: 'cf_test' }, 'test');
    const issue = { summary: 's', status: 'Rdy FE Dev', statusCategory: 'To Do', reporterName: 'Ola', reporterEmail: 'ola@example.com' };
    vi.mocked(searchHopper).mockResolvedValue([
      { ...issue, key: 'ECOM-1', businessScore: 30, backendEffort: 13, frontendEffort: 8, testingEffort: 3 },
      { ...issue, key: 'ECOM-2', businessScore: -1, backendEffort: 5, frontendEffort: 0, testingEffort: 0 },
      { ...issue, key: 'ECOM-3', businessScore: 40, backendEffort: 0, frontendEffort: 0, testingEffort: 0 },
    ]);

    const view = await getMatrixView(db);
    expect(vi.mocked(searchHopper).mock.calls[0][0]).toBe('status = "Rdy FE Dev"');
    expect(vi.mocked(searchHopper).mock.calls[0][1]).toMatchObject({ testingFieldId: 'cf_test' });
    expect(view.source).toBe('jira');
    // A point is 6 h × 7.5 days ÷ 13 ≈ 3.46 testing hours, so 3 hours is
    // about 0.9 of a point - not 3 points.
    expect(view.points.map((p) => [p.key, p.effort.total])).toEqual([['ECOM-1', 21.9]]);
    expect(view.points[0].effort).toMatchObject({ testing: 0.9, testingHours: 3 });
    expect(view.testingHoursPerPoint).toBeCloseTo(3.46, 2);
    expect(view.unestimated.map((u) => u.key)).toEqual(['ECOM-3']);
    expect(view.jiraBrowseUrl).toBe('https://example.atlassian.net/browse/');
  });
});

describe('matrix reviews', () => {
  it('keeps the latest decision per ticket, with the score and effort it was made on', async () => {
    await recordReview(db, { key: 'ECOM-9', outcome: 'REQUESTED', note: 'asked Ola', businessScore: 20, effort: 25, actorEmail: 'n@x' });
    await recordReview(db, { key: 'ECOM-9', outcome: 'KEPT', note: 'needed for Rolex launch', businessScore: 20, effort: 25, actorEmail: 'n@x' });
    const { reviews } = await getMatrixView(db);
    expect(reviews['ECOM-9']).toMatchObject({ outcome: 'KEPT', note: 'needed for Rolex launch', businessScore: 20, effort: 25, by: 'n@x' });
  });
});

describe('closeFromMatrix', () => {
  const saved = { baseUrl: env.jira.baseUrl, email: env.jira.email, apiToken: env.jira.apiToken };
  beforeEach(() => {
    Object.assign(env.jira, { baseUrl: 'https://example.atlassian.net', email: 'a@b.c', apiToken: 't' });
  });
  afterEach(() => {
    Object.assign(env.jira, saved);
    vi.mocked(transitionIssue).mockReset();
    vi.mocked(addComment).mockReset();
  });

  it('refuses until a close transition is chosen', async () => {
    await expect(closeFromMatrix(db, { key: 'ECOM-9', reason: 'r', businessScore: 1, effort: 2, actorEmail: '' })).rejects.toThrow(
      /close transition/,
    );
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  it('moves the ticket, comments the reason and logs it', async () => {
    await saveConfigSection(db, 'matrix', { closeTransitionName: "Won't Do" }, 'test');
    vi.mocked(transitionIssue).mockResolvedValue("Won't Do");
    const result = await closeFromMatrix(db, { key: 'ECOM-9', reason: 'no justification', businessScore: 18, effort: 31, actorEmail: 'n@x' });
    expect(result.movedTo).toBe("Won't Do");
    expect(transitionIssue).toHaveBeenCalledWith('ECOM-9', "Won't Do");
    expect(vi.mocked(addComment).mock.calls[0][1]).toContain('no justification');
    expect((await getMatrixView(db)).reviews['ECOM-9'].outcome).toBe('CLOSED');
  });

  it('logs nothing and comments nothing when JIRA refuses the move', async () => {
    await saveConfigSection(db, 'matrix', { closeTransitionName: "Won't Do" }, 'test');
    vi.mocked(transitionIssue).mockRejectedValue(new Error('no such transition'));
    await expect(closeFromMatrix(db, { key: 'ECOM-9', reason: 'r', businessScore: 1, effort: 2, actorEmail: '' })).rejects.toThrow();
    expect(addComment).not.toHaveBeenCalled();
    expect((await getMatrixView(db)).reviews['ECOM-9']).toBeUndefined();
  });
});

describe('runMatrixSnapshotIfDue', () => {
  it('records the box counts once a day, using the saved lines', async () => {
    await scoreRound('W1', '2099-01-06T17:00:00.000Z', ['ECOM-1', 'ECOM-2', 'ECOM-3'], 9);
    await scoreRound('W2', '2099-01-13T17:00:00.000Z', ['ECOM-4'], 1);
    // 63 points each for 1-3, 7 for 4.
    await db.run("UPDATE tickets SET backend_poker_score = 5 WHERE jira_id IN ('ECOM-1', 'ECOM-4')");
    await db.run("UPDATE tickets SET backend_poker_score = 30 WHERE jira_id = 'ECOM-2'");

    const day = new Date('2099-02-01T09:00:00Z');
    expect(await runMatrixSnapshotIfDue(db, day)).toBe(true);
    expect(await runMatrixSnapshotIfDue(db, day)).toBe(false);
    const { history } = await getMatrixView(db);
    expect(history).toEqual([{ day: '2099-02-01', counts: { doNext: 1, plan: 1, fitIn: 1, question: 0, unestimated: 1 } }]);
  });

  it('records nothing while there is nothing to plot', async () => {
    expect(await runMatrixSnapshotIfDue(db, new Date('2099-02-01T09:00:00Z'))).toBe(false);
  });
});

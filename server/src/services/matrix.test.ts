import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getAppConfig, listCategories } from './configService.js';
import { addTicketToRound, createRound, getRound, setRoundStatus } from './roundService.js';
import { getTicket, upsertTicket } from './ticketService.js';
import { saveMember, type Member } from './memberService.js';
import { saveSubmission } from './submissionService.js';
import { snapshotRoundResults } from './resultService.js';
import { getMatrixView } from './matrixService.js';
import { DEFAULT_MATRIX_CONFIG } from '../domain/types.js';

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

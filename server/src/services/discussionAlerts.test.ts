import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';

/**
 * `listPendingDiscussions` and `alertOnUnresolvedDiscussions` - kept apart
 * from any test file that exercises real submissions against an unconfigured
 * mail provider, for the same reason automationAlerts.test.ts is separate
 * from automationCycle.test.ts: mocking `sendMail` at file scope here would
 * silently change what those other tests are checking.
 */

const sendMail = vi.fn();

vi.mock('../integrations/mail.js', () => ({
  sendMail,
}));

const { ensureDefaultConfig, ensureSeedCategories, listCategories, getScoringConfig } = await import(
  './configService.js'
);
const { saveMember } = await import('./memberService.js');
const { createRound, addTicketToRound, setRoundStatus } = await import('./roundService.js');
const { saveSubmission } = await import('./submissionService.js');
const { upsertTicket } = await import('./ticketService.js');
const { recordDiscussion, listPendingDiscussions, alertOnUnresolvedDiscussions } = await import(
  './discussionService.js'
);

let db: Db;
const ACTOR = { id: 'test', email: 'test@example.com' };

async function scoredTicket(splitScores: number[]) {
  let round = await createRound(db, { weekLabel: 'W', cutOffAt: '2099-01-01T00:00:00.000Z' });
  round = await setRoundStatus(db, round.id, 'OPEN');
  const ticket = await upsertTicket(db, { jiraId: `ECOM-${Math.floor(Math.random() * 100000)}`, title: 'A ticket' });
  await addTicketToRound(db, round.id, ticket.id);

  const categories = await listCategories(db);
  const config = await getScoringConfig(db);
  for (const [i, total] of splitScores.entries()) {
    const member = await saveMember(db, { name: `M${i}`, email: `m${i}@example.com`, team: 'Trading', role: 'COMMITTEE' });
    await saveSubmission(db, {
      round,
      ticket,
      member,
      config,
      payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, total])) },
    });
  }
  return { round, ticket };
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  sendMail.mockReset();
  sendMail.mockResolvedValue({ status: 'SENT' });
});

afterEach(async () => {
  await db.close();
});

describe('listPendingDiscussions', () => {
  it('is empty when nothing is split', async () => {
    await scoredTicket([5, 5, 5]);
    expect(await listPendingDiscussions(db)).toHaveLength(0);
  });

  it('includes a ticket the committee split on, with no outcome recorded', async () => {
    const { round, ticket } = await scoredTicket([10, 10, 2]); // std dev ~32, over the default threshold of 16
    const pending = await listPendingDiscussions(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ roundId: round.id, ticketId: ticket.id, jiraId: ticket.jiraId });
  });

  it('drops off once an outcome is recorded', async () => {
    const { round, ticket } = await scoredTicket([10, 10, 2]);
    await recordDiscussion(db, ACTOR, round, ticket.id, { outcome: 'AGREED', agreedScore: 50 });
    expect(await listPendingDiscussions(db)).toHaveLength(0);
  });
});

describe('alertOnUnresolvedDiscussions', () => {
  it('emails every active admin once, and does not repeat on an unchanged occurrence', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await scoredTicket([10, 10, 2]);

    await alertOnUnresolvedDiscussions(db);
    await alertOnUnresolvedDiscussions(db);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [message] = sendMail.mock.calls[0];
    expect(message.to).toEqual(['admin@example.com']);
  });

  it('does not throw when there are no active admins', async () => {
    await scoredTicket([10, 10, 2]);
    await expect(alertOnUnresolvedDiscussions(db)).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends no email when nothing is pending', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await scoredTicket([5, 5, 5]);
    await alertOnUnresolvedDiscussions(db);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('stops alerting once the discussion is resolved', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    const { round, ticket } = await scoredTicket([10, 10, 2]);

    await alertOnUnresolvedDiscussions(db);
    expect(sendMail).toHaveBeenCalledTimes(1);

    await recordDiscussion(db, ACTOR, round, ticket.id, { outcome: 'AGREED', agreedScore: 50 });
    await alertOnUnresolvedDiscussions(db);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

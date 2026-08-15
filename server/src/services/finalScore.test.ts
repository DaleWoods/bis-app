import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, getScoringConfig, listCategories } from './configService.js';
import { buildFeedbackView, snapshotRoundResults } from './resultService.js';
import { addTicketToRound, createRound, setRoundStatus, type Round } from './roundService.js';
import { saveMember, type Member } from './memberService.js';
import { listRoundSubmissions, saveSubmission, setSubmissionArchived } from './submissionService.js';
import { upsertTicket, type Ticket } from './ticketService.js';

/**
 * A score is given once and stands. An answer that can be revised is an answer
 * that can be revised after hearing what everyone else said, and the spread
 * that decides whether a ticket needs discussing is only meaningful if each
 * score was formed independently.
 */
let db: Db;
let round: Round;
let ticket: Ticket;
let members: Member[];

async function score(member: Member, value: number): Promise<void> {
  const categories = await listCategories(db);
  await saveSubmission(db, {
    round,
    ticket,
    member,
    config: await getScoringConfig(db),
    payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, value])) },
  });
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);

  members = [];
  for (const name of ['A', 'B']) {
    members.push(await saveMember(db, { name, email: `${name.toLowerCase()}@example.com`, team: 'T', role: 'COMMITTEE' }));
  }

  round = await createRound(db, { weekLabel: 'W', cutOffAt: '2099-01-01T00:00:00.000Z' });
  round = await setRoundStatus(db, round.id, 'OPEN');
  ticket = await upsertTicket(db, { jiraId: 'ECOM-1', title: 'A ticket' });
  await addTicketToRound(db, round.id, ticket.id);
});

afterEach(async () => {
  await db.close();
});

describe('scoring a ticket', () => {
  it('is accepted once', async () => {
    await score(members[0], 5);
    const [submission] = await listRoundSubmissions(db, round.id);
    expect(submission.relevance).toBe('YES');
  });

  it('is refused a second time, whatever the answer would have been', async () => {
    await score(members[0], 5);
    await expect(score(members[0], 9)).rejects.toThrow(/cannot be changed once it is in/i);

    // And the original stands rather than being half-written.
    const categories = await listCategories(db);
    const [submission] = await listRoundSubmissions(db, round.id);
    expect(categories.map((c) => submission.scores[c.id])).toEqual(categories.map(() => 5));
  });

  it('does not stop anybody else scoring it', async () => {
    await score(members[0], 5);
    await score(members[1], 8);
    expect(await listRoundSubmissions(db, round.id)).toHaveLength(2);
  });

  it('can be given again once the coordinator excludes the wrong one', async () => {
    // The sanctioned way back: excluding is the coordinator's call, not the
    // member's, so a score still cannot be quietly rewritten.
    await score(members[0], 5);
    const [submission] = await listRoundSubmissions(db, round.id);
    await setSubmissionArchived(db, submission.id, true);

    await score(members[0], 9);
    const [rescored] = await listRoundSubmissions(db, round.id);
    const categories = await listCategories(db);
    expect(rescored.archived).toBe(false);
    expect(rescored.scores[categories[0].id]).toBe(9);
  });
});

describe('the feedback view', () => {
  it('shows a member their own score and where the ticket came in the round', async () => {
    const second = await upsertTicket(db, { jiraId: 'ECOM-2', title: 'Another' });
    await addTicketToRound(db, round.id, second.id);

    await score(members[0], 2); // 14 on ECOM-1
    await score(members[1], 4); // 28 on ECOM-1
    for (const member of members) {
      await saveSubmission(db, {
        round,
        ticket: second,
        member,
        config: await getScoringConfig(db),
        payload: { relevance: 'YES', scores: Object.fromEntries((await listCategories(db)).map((c) => [c.id, 8])) },
      });
    }

    await setRoundStatus(db, round.id, 'CLOSED');
    const finalised = await setRoundStatus(db, round.id, 'FINALISED');
    await snapshotRoundResults(db, finalised);

    const view = await buildFeedbackView(db, finalised, new Map(), members[0].id);
    const first = view.find((t) => t.jiraId === 'ECOM-1')!;
    const other = view.find((t) => t.jiraId === 'ECOM-2')!;

    expect(first.yourTotal).toBe(14);
    expect(first.businessScore).toBe(21);
    // ECOM-2 scored 56, so it tops the table.
    expect(other.rank).toBe(1);
    expect(first.rank).toBe(2);
  });

  it('keeps another member’s score to themselves', async () => {
    await score(members[0], 2);
    await score(members[1], 10);

    await setRoundStatus(db, round.id, 'CLOSED');
    const finalised = await setRoundStatus(db, round.id, 'FINALISED');
    await snapshotRoundResults(db, finalised);

    // B reads it: they see their own 70, never A's 14 attributed to A.
    const view = await buildFeedbackView(db, finalised, new Map(), members[1].id);
    expect(view[0].yourTotal).toBe(70);
    expect(JSON.stringify(view[0])).not.toContain(members[0].id);
    expect(JSON.stringify(view[0])).not.toContain('a@example.com');
  });

  it('leaves the own-score fields empty for somebody who did not score', async () => {
    await score(members[0], 5);
    await setRoundStatus(db, round.id, 'CLOSED');
    const finalised = await setRoundStatus(db, round.id, 'FINALISED');
    await snapshotRoundResults(db, finalised);

    expect((await buildFeedbackView(db, finalised, new Map(), members[1].id))[0].yourTotal).toBeNull();
    // And with no member at all - the coordinator's own read of the page.
    expect((await buildFeedbackView(db, finalised))[0].yourTotal).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, listCategories, saveConfigSection } from './configService.js';
import { buildFeedbackView, roundResults, snapshotRoundResults } from './resultService.js';
import { addTicketToRound, createRound, getRound, setRoundStatus, type Round } from './roundService.js';
import { saveMember, type Member } from './memberService.js';
import { saveSubmission, setSubmissionArchived, listRoundSubmissions } from './submissionService.js';
import { getScoringConfig } from './configService.js';
import { upsertTicket, type Ticket } from './ticketService.js';

/**
 * Finalising freezes the numbers.
 *
 * The snapshot was written on finalise and never read back - every consumer
 * recomputed from live submissions - so excluding a submission or moving a
 * threshold after the fact silently rewrote a finalised round, including what a
 * later JIRA write-back would send. These are the cases that used to drift.
 */

let db: Db;
let round: Round;
let ticket: Ticket;
let members: Member[];

/** OPEN -> CLOSED -> FINALISED, the only route the transitions allow. */
async function finalise(): Promise<Round> {
  await setRoundStatus(db, round.id, 'CLOSED');
  const finalised = await setRoundStatus(db, round.id, 'FINALISED');
  await snapshotRoundResults(db, finalised);
  return finalised;
}

async function score(member: Member, value: number): Promise<void> {
  const categories = await listCategories(db);
  await saveSubmission(db, {
    round,
    ticket,
    member,
    config: await getScoringConfig(db),
    payload: {
      relevance: 'YES',
      scores: Object.fromEntries(categories.map((c) => [c.id, value])),
    },
  });
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);

  members = [];
  for (const name of ['A', 'B', 'C']) {
    members.push(
      await saveMember(db, { name, email: `${name.toLowerCase()}@example.com`, team: 'Trading', role: 'COMMITTEE' }),
    );
  }

  round = await createRound(db, { weekLabel: 'W', cutOffAt: '2099-01-01T00:00:00.000Z' });
  round = await setRoundStatus(db, round.id, 'OPEN');
  ticket = await upsertTicket(db, { jiraId: 'ECOM-1', title: 'A ticket' });
  await addTicketToRound(db, round.id, ticket.id);
});

afterEach(async () => {
  await db.close();
});

describe('a finalised round', () => {
  it('keeps its score when a submission is excluded afterwards', async () => {
    await score(members[0], 10); // 70
    await score(members[1], 10); // 70
    await score(members[2], 2); //  14

    const before = (await roundResults(db, round))[0].aggregate.businessScore;
    expect(before).toBe(51); // (70 + 70 + 14) / 3

    await finalise();

    // Excluding the outlier would move a live calculation to 70.
    const submissions = await listRoundSubmissions(db, round.id);
    const outlier = submissions.find((s) => s.memberId === members[2].id)!;
    await setSubmissionArchived(db, outlier.id, true);

    const after = (await roundResults(db, (await getRound(db, round.id))!))[0].aggregate.businessScore;
    expect(after).toBe(before);
  });

  it('keeps its discussion flag when the threshold is changed afterwards', async () => {
    await score(members[0], 10);
    await score(members[1], 1);

    const finalised = await finalise();
    const frozen = (await roundResults(db, finalised))[0].aggregate.discussionRequired;
    expect(frozen).toBe(true);

    // A threshold nothing could exceed. A live recalculation would clear the flag.
    await saveConfigSection(db, 'scoring', { stdDevDiscussionThreshold: 999 }, 'test');

    const after = (await roundResults(db, (await getRound(db, round.id))!))[0].aggregate.discussionRequired;
    expect(after).toBe(true);
  });

  it('shows the committee the same frozen numbers in the feedback view', async () => {
    await score(members[0], 10);
    await score(members[1], 10);

    await finalise();

    const submissions = await listRoundSubmissions(db, round.id);
    await setSubmissionArchived(db, submissions[0].id, true);

    const feedback = await buildFeedbackView(db, (await getRound(db, round.id))!);
    expect(feedback[0].businessScore).toBe(70);
    expect(feedback[0].responsesCount).toBe(2);
  });

  it('recalculates again once it is reopened', async () => {
    await score(members[0], 10);
    await score(members[1], 2);

    await finalise();

    // Reopening is the sanctioned way back: the results are meant to move again.
    await setRoundStatus(db, round.id, 'CLOSED');
    const reopened = (await getRound(db, round.id))!;

    const submissions = await listRoundSubmissions(db, round.id);
    const low = submissions.find((s) => s.memberId === members[1].id)!;
    await setSubmissionArchived(db, low.id, true);

    expect((await roundResults(db, reopened))[0].aggregate.businessScore).toBe(70);
  });

  it('falls back to a live calculation when there is no snapshot', async () => {
    await score(members[0], 5);
    // Finalised without snapshotRoundResults - the state of every round
    // finalised before the snapshot was stored whole.
    await setRoundStatus(db, round.id, 'CLOSED');
    const finalised = await setRoundStatus(db, round.id, 'FINALISED');
    expect((await roundResults(db, finalised))[0].aggregate.businessScore).toBe(35);
  });
});

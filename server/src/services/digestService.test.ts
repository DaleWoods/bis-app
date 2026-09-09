import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';

/**
 * The weekly admin digest - kept apart from files that exercise real
 * submissions against an unconfigured mail provider, same reasoning as
 * discussionAlerts.test.ts.
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
const { snapshotRoundResults } = await import('./resultService.js');
const { buildWeeklyDigest, digestDueThisWeek, runWeeklyDigestIfDue } = await import('./digestService.js');

let db: Db;

async function finalisedRound(weekLabel: string, scores: number[]) {
  let round = await createRound(db, { weekLabel, cutOffAt: '2099-01-01T00:00:00.000Z' });
  round = await setRoundStatus(db, round.id, 'OPEN');
  const ticket = await upsertTicket(db, { jiraId: `ECOM-${Math.floor(Math.random() * 100000)}`, title: 'A ticket' });
  await addTicketToRound(db, round.id, ticket.id);

  const categories = await listCategories(db);
  const config = await getScoringConfig(db);
  for (const [i, total] of scores.entries()) {
    const member = await saveMember(db, { name: `M${i}`, email: `m${i}@example.com`, team: 'Trading', role: 'COMMITTEE' });
    await saveSubmission(db, {
      round,
      ticket,
      member,
      config,
      payload: { relevance: 'YES', scores: Object.fromEntries(categories.map((c) => [c.id, total])) },
    });
  }
  round = await setRoundStatus(db, round.id, 'CLOSED');
  round = await setRoundStatus(db, round.id, 'FINALISED');
  await snapshotRoundResults(db, round);
  return round;
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

describe('digestDueThisWeek', () => {
  it('is due with a week-old "since" when nothing has ever sent', async () => {
    const { due, since } = await digestDueThisWeek(db);
    expect(due).toBe(true);
    expect(new Date(since).getTime()).toBeLessThan(Date.now());
  });

  it('is not due again immediately after sending', async () => {
    await runWeeklyDigestIfDue(db);
    expect((await digestDueThisWeek(db)).due).toBe(false);
  });
});

describe('buildWeeklyDigest', () => {
  it('summarises a round finalised since the given date', async () => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const round = await finalisedRound('Week 1', [5, 5, 5]);
    const digest = await buildWeeklyDigest(db, since);
    expect(digest.hadActivity).toBe(true);
    expect(digest.html).toContain('Week 1');
    expect(digest.html).toContain('1 ticket');
    expect(digest.html).toContain(round.id);
  });

  it('says nothing was finalised when the window is empty', async () => {
    const since = new Date().toISOString();
    const digest = await buildWeeklyDigest(db, since);
    expect(digest.html).toContain('No round finalised since the last digest.');
  });

  it('ignores a round finalised before the given date', async () => {
    await finalisedRound('Old week', [5, 5, 5]);
    const since = new Date(Date.now() + 3_600_000).toISOString(); // an hour in the future
    const digest = await buildWeeklyDigest(db, since);
    expect(digest.html).toContain('No round finalised since the last digest.');
  });
});

describe('runWeeklyDigestIfDue', () => {
  it('emails every active admin and records the send', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await saveMember(db, { name: 'Old admin', email: 'old@example.com', team: 'Ops', role: 'ADMIN', active: false });
    await finalisedRound('Week 1', [5, 5, 5]);

    await runWeeklyDigestIfDue(db);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toEqual(['admin@example.com']);
  });

  it('does not send twice in the same week', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await runWeeklyDigestIfDue(db);
    await runWeeklyDigestIfDue(db);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('records the send even with no active admin to mail', async () => {
    await runWeeklyDigestIfDue(db);
    expect(sendMail).not.toHaveBeenCalled();
    expect((await digestDueThisWeek(db)).due).toBe(false);
  });
});

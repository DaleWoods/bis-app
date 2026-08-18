import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultConfig, ensureSeedCategories, saveConfigSection } from './configService.js';
import { listAutomationLog, runDueAutomation } from './automationService.js';
import { createRound, getRound, listRounds, listRoundTickets, setRoundStatus, updateRound } from './roundService.js';
import { addTicketToRound } from './roundService.js';
import { saveMember } from './memberService.js';
import { upsertTicket } from './ticketService.js';

/**
 * The cycle end to end, with the clock wound forward by hand.
 *
 * On a real SQLite database rather than mocks, because the parts that can go
 * wrong are the parts that touch it: the claim rows that stop a step running
 * twice, the status transitions, and what happens when a coordinator has
 * already done by hand what automation was about to do.
 *
 * Email is not configured in the test environment, so distribution composes and
 * suppresses rather than sending - which is exactly the path a real instance
 * takes before SMTP is set up.
 */

const OPENS_AT = '2026-08-06T08:00:00.000Z';
const CUT_OFF = '2026-08-11T16:00:00.000Z';

let db: Db;

async function automation(overrides: Record<string, unknown> = {}) {
  await saveConfigSection(db, 'automation', { enabled: true, createRounds: false, ...overrides }, 'test');
}

async function aRound(overrides: Record<string, unknown> = {}) {
  const round = await createRound(db, {
    weekLabel: 'Week commencing 03 Aug 2026',
    cutOffAt: CUT_OFF,
    opensAt: OPENS_AT,
    ...overrides,
  });
  // A drafted card, not a blank one - these tests are about the cycle, not
  // about the hold-back gate, which has its own tests below.
  const ticket = await upsertTicket(db, {
    jiraId: `ECOM-${Math.random().toString().slice(2, 7)}`,
    title: 'A ticket',
    execSummary: 'Something a buyer would care about',
    panelCurrent: 'How it works today',
  });
  await addTicketToRound(db, round.id, ticket.id);
  return round;
}

beforeEach(async () => {
  db = await createDb({ driver: 'sqlite', sqliteFile: ':memory:' });
  await migrate(db);
  await ensureDefaultConfig(db);
  await ensureSeedCategories(db);
  await saveMember(db, { name: 'Committee', email: 'c@example.com', team: 'Trading', role: 'COMMITTEE' });
});

afterEach(async () => {
  await db.close();
});

describe('the automated cycle', () => {
  it('opens the round at its opening time, and not a moment before', async () => {
    await automation();
    const round = await aRound();

    await runDueAutomation(db, new Date('2026-08-06T07:59:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('DRAFT');

    await runDueAutomation(db, new Date('2026-08-06T08:01:00Z'));
    const opened = await getRound(db, round.id);
    expect(opened?.status).toBe('OPEN');

    // Opened, but NOT stamped as distributed: no email provider is configured
    // here, so every message was composed and suppressed. Stamping it anyway
    // put a "Distributed" badge on a round the committee had never been told
    // about, and flipped the button to "Re-send to committee".
    expect(opened?.distributionSentAt).toBeNull();

    // The step still ran, and still says what it did.
    const log = await listAutomationLog(db, round.id);
    expect(log.find((entry) => entry.action === 'distribute')?.outcome).toContain('Opened and emailed 0');
  });

  it('closes at the cut-off and finalises after the grace period', async () => {
    await automation({ finaliseDelayHours: 2 });
    const round = await aRound();

    await runDueAutomation(db, new Date('2026-08-11T16:01:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('CLOSED');

    // Inside the grace period the results are still open to a late submission.
    await runDueAutomation(db, new Date('2026-08-11T17:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('CLOSED');

    await runDueAutomation(db, new Date('2026-08-11T18:01:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('FINALISED');
  });

  it('retries a failed step once, after the cooldown', async () => {
    await automation();
    const round = await aRound();

    // A step that failed 40 minutes ago - past the 30-minute cooldown - on
    // its first attempt.
    await db.run(
      `INSERT INTO round_automation_log (id, round_id, action, ran_at, outcome, attempts)
       VALUES ('log-1', ?, 'close', ?, 'Failed: simulated JIRA blip', 1)`,
      [round.id, '2026-08-11T16:20:00.000Z'],
    );

    const run = await runDueAutomation(db, new Date('2026-08-11T17:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('CLOSED');
    expect(run.steps.some((s) => s.action === 'close' && s.outcome.includes('cut-off'))).toBe(true);
  });

  it('does not retry before the cooldown has passed', async () => {
    await automation();
    const round = await aRound();

    // Failed five minutes ago - still inside the cooldown.
    await db.run(
      `INSERT INTO round_automation_log (id, round_id, action, ran_at, outcome, attempts)
       VALUES ('log-2', ?, 'close', ?, 'Failed: simulated JIRA blip', 1)`,
      [round.id, '2026-08-11T16:55:00.000Z'],
    );

    await runDueAutomation(db, new Date('2026-08-11T17:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('OPEN');
  });

  it('leaves a step that has already had its one retry for a person, however long it waits', async () => {
    await automation();
    const round = await aRound();

    // Already retried once (attempts = 2) and failed again, long enough ago
    // that a cooldown would otherwise have passed.
    await db.run(
      `INSERT INTO round_automation_log (id, round_id, action, ran_at, outcome, attempts)
       VALUES ('log-3', ?, 'close', ?, 'Failed: simulated JIRA blip (retries exhausted — run this step by hand)', 2)`,
      [round.id, '2026-08-11T10:00:00.000Z'],
    );

    await runDueAutomation(db, new Date('2026-08-12T09:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('OPEN');
  });

  it('fires the escalation reminder at its own configured hour, naming what is outstanding', async () => {
    await automation();
    const round = await aRound();
    // Open it, so there is a round to be reminded about.
    await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));

    // Default cadence: escalationHoursBeforeCutOff = 2. Cut-off is 16:00, so
    // 15:00 is inside the escalation window and past the ordinary 4-hour one.
    const run = await runDueAutomation(db, new Date('2026-08-11T15:00:00Z'));
    const escalated = run.steps.find((s) => s.action.startsWith('escalate:'));
    expect(escalated).toBeTruthy();
    // Email is not configured in tests, so the send is suppressed rather than
    // sent - the target count is what proves the outstanding ticket was found.
    expect(escalated?.outcome).toMatch(/chased 0 of 1 outstanding member/i);

    const emails = await db.all<{ kind: string; subject: string }>(
      "SELECT kind, subject FROM email_log WHERE round_id = ? AND kind = 'ESCALATION'",
      [round.id],
    );
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toMatch(/^Final reminder:/);
  });

  it('runs each step exactly once, however often the tick fires', async () => {
    await automation();
    const round = await aRound();

    for (let i = 0; i < 5; i += 1) await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));
    for (let i = 0; i < 5; i += 1) await runDueAutomation(db, new Date('2026-08-11T19:00:00Z'));

    const log = await listAutomationLog(db, round.id);
    const actions = log.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain('distribute');
    expect(actions).toContain('close');
    expect(actions).toContain('finalise');
  });

  it('picks up a step whose moment passed while the service was down', async () => {
    await automation();
    const round = await aRound();

    // Nothing ran at the cut-off; the first tick is a day late.
    await runDueAutomation(db, new Date('2026-08-12T18:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('FINALISED');
  });

  it('treats a round closed early by hand as closed, not as a conflict', async () => {
    await automation();
    const round = await aRound();
    await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));

    // The coordinator closes it days before the cut-off.
    await setRoundStatus(db, round.id, 'CLOSED');

    const run = await runDueAutomation(db, new Date('2026-08-11T19:00:00Z'));
    expect(run.steps.some((s) => s.outcome.startsWith('Failed'))).toBe(false);
    expect((await getRound(db, round.id))?.status).toBe('FINALISED');
  });

  it('leaves a paused round entirely alone', async () => {
    await automation();
    const round = await aRound();
    await updateRound(db, round.id, { automationPaused: true });

    await runDueAutomation(db, new Date('2026-08-12T18:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('DRAFT');
    expect(await listAutomationLog(db, round.id)).toHaveLength(0);
  });

  it('does nothing at all while the master switch is off', async () => {
    await saveConfigSection(db, 'automation', { enabled: false }, 'test');
    const round = await aRound();

    const run = await runDueAutomation(db, new Date('2026-08-12T18:00:00Z'));
    expect(run.skipped).toMatch(/switched off/i);
    expect((await getRound(db, round.id))?.status).toBe('DRAFT');
  });

  it('will not email the committee a round with no tickets in it', async () => {
    await automation();
    const round = await createRound(db, { weekLabel: 'Empty week', cutOffAt: CUT_OFF, opensAt: OPENS_AT });

    await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('DRAFT');

    // ...and it is not stuck: adding a ticket lets the next tick send it.
    const ticket = await upsertTicket(db, {
      jiraId: 'ECOM-9',
      title: 'Late arrival',
      execSummary: 'Something a buyer would care about',
      panelCurrent: 'How it works today',
    });
    await addTicketToRound(db, round.id, ticket.id);
    await runDueAutomation(db, new Date('2026-08-06T08:06:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('OPEN');
  });

  it('honours each switch on its own', async () => {
    await automation({ close: false });
    const round = await aRound();

    await runDueAutomation(db, new Date('2026-08-12T18:00:00Z'));
    // Opened and distributed, but left open because closing is switched off.
    expect((await getRound(db, round.id))?.status).toBe('OPEN');
  });

  it('lets a reopened round run its tail again', async () => {
    await automation();
    const round = await aRound();
    await runDueAutomation(db, new Date('2026-08-12T18:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('FINALISED');

    // Reopen: FINALISED -> CLOSED -> OPEN, as the UI does it.
    await setRoundStatus(db, round.id, 'CLOSED');
    await setRoundStatus(db, round.id, 'OPEN');
    const reopened = await getRound(db, round.id);
    expect(reopened?.status).toBe('OPEN');
    expect(reopened?.finalisedAt).toBeNull();

    // The cut-off is long past, so the next tick closes and finalises it again
    // rather than leaving it open forever.
    await runDueAutomation(db, new Date('2026-08-13T09:00:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('FINALISED');
  });
});

describe('creating rounds', () => {
  it('creates one round for the coming week and then leaves it alone', async () => {
    await automation({ createRounds: true, importFromJira: false });

    await runDueAutomation(db, new Date('2026-08-05T10:00:00Z'));
    const after = await listRounds(db);
    expect(after).toHaveLength(1);
    expect(after[0].weekLabel).toBe('Week commencing 06 Aug 2026');
    expect(after[0].opensAt).toBe('2026-08-06T08:00:00.000Z');
    expect(after[0].cutOffAt).toBe('2026-08-11T16:00:00.000Z');

    // A second tick must not create a second round for the same week.
    await runDueAutomation(db, new Date('2026-08-05T10:01:00Z'));
    expect(await listRounds(db)).toHaveLength(1);
  });

  it('does not create a round while one is still running', async () => {
    await automation({ createRounds: true, importFromJira: false });
    await aRound();

    await runDueAutomation(db, new Date('2026-08-07T10:00:00Z'));
    expect(await listRounds(db)).toHaveLength(1);
  });
});

describe('holding back a weak card from an automated distribution', () => {
  async function roundWithTwoTickets() {
    const round = await createRound(db, { weekLabel: 'Week commencing 03 Aug 2026', cutOffAt: CUT_OFF, opensAt: OPENS_AT });
    const good = await upsertTicket(db, {
      jiraId: 'ECOM-GOOD',
      title: 'A properly drafted ticket',
      execSummary: 'Something a buyer would care about',
      panelCurrent: 'How it works today',
    });
    // Nothing drafted at all - the case cardBlocksAutomatedDistribution() exists for.
    const blank = await upsertTicket(db, { jiraId: 'ECOM-BLANK', title: 'Nobody has looked at this yet' });
    await addTicketToRound(db, round.id, good.id);
    await addTicketToRound(db, round.id, blank.id);
    return { round, good, blank };
  }

  it('opens on time with the ready tickets and holds the blank one back', async () => {
    await automation();
    const { round, blank } = await roundWithTwoTickets();

    await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('OPEN');

    const tickets = await listRoundTickets(db, round.id);
    expect(tickets.find((t) => t.id === blank.id)?.held).toBe(true);
    expect(tickets.find((t) => t.jiraId === 'ECOM-GOOD')?.held).toBe(false);
  });

  it('does not open at all while every ticket is held', async () => {
    await automation();
    const round = await createRound(db, { weekLabel: 'Week commencing 03 Aug 2026', cutOffAt: CUT_OFF, opensAt: OPENS_AT });
    const blank = await upsertTicket(db, { jiraId: 'ECOM-BLANK', title: 'Nobody has looked at this yet' });
    await addTicketToRound(db, round.id, blank.id);

    await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('DRAFT');

    // Not stuck: a coordinator finishing the card lets the next tick send it.
    await upsertTicket(db, { jiraId: 'ECOM-BLANK', title: 'Nobody has looked at this yet', execSummary: 'Now it is written up' });
    await runDueAutomation(db, new Date('2026-08-06T08:06:00Z'));
    expect((await getRound(db, round.id))?.status).toBe('OPEN');
  });
});

describe('a round finalised by hand', () => {
  it('still gets its scores written to JIRA by automation', async () => {
    // Finalising yourself is an override of one step, not an instruction to
    // stop automating the rest. Write-back used to hang off the finalise step,
    // so doing it by hand quietly cancelled the JIRA push.
    await automation();
    const round = await aRound();
    await runDueAutomation(db, new Date('2026-08-06T08:05:00Z'));

    await setRoundStatus(db, round.id, 'CLOSED');
    await setRoundStatus(db, round.id, 'FINALISED');

    await runDueAutomation(db, new Date('2026-08-11T20:00:00Z'));

    const actions = (await listAutomationLog(db, round.id)).map((e) => e.action);
    expect(actions).toContain('writeback');
    expect(actions).not.toContain('finalise');
  });
});

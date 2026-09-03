import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';

/**
 * `listStuckAutomationSteps` and `alertOnStuckFailures` (PLAN-4), kept apart
 * from automationCycle.test.ts on purpose: that file exercises the real
 * cycle against an unconfigured mail provider (it asserts on the "no SMTP
 * configured, so sends are suppressed" path), and mocking `sendMail` at the
 * file level here would silently change what those tests are checking.
 */

const sendMail = vi.fn();

vi.mock('../integrations/mail.js', () => ({
  sendMail,
}));

const { ensureDefaultConfig, ensureSeedCategories } = await import('./configService.js');
const { saveMember } = await import('./memberService.js');
const { createRound } = await import('./roundService.js');
const { listStuckAutomationSteps, alertOnStuckFailures } = await import('./automationService.js');

let db: Db;

const CUT_OFF = '2026-08-11T16:00:00.000Z';
const OPENS_AT = '2026-08-06T08:00:00.000Z';

async function aRound() {
  return createRound(db, { weekLabel: 'Week commencing 03 Aug 2026', cutOffAt: CUT_OFF, opensAt: OPENS_AT });
}

async function stuckLog(roundId: string, id: string, ranAt: string, attempts = 2) {
  await db.run(
    `INSERT INTO round_automation_log (id, round_id, action, ran_at, outcome, attempts)
     VALUES (?, ?, 'writeback', ?, 'Failed: no field id configured (retries exhausted — run this step by hand)', ?)`,
    [id, roundId, ranAt, attempts],
  );
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

describe('listStuckAutomationSteps', () => {
  it('is empty when there is no failure at all', async () => {
    await aRound();
    expect(await listStuckAutomationSteps(db)).toHaveLength(0);
  });

  it('ignores a step that has failed once and is still within its retry cooldown', async () => {
    const round = await aRound();
    await stuckLog(round.id, 'log-stuck-1', '2026-08-11T16:20:00.000Z', 1);
    expect(await listStuckAutomationSteps(db)).toHaveLength(0);
  });

  it('returns a step once its retries are used up', async () => {
    const round = await aRound();
    await stuckLog(round.id, 'log-stuck-2', '2026-08-11T16:20:00.000Z', 2);
    const stuck = await listStuckAutomationSteps(db);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ roundId: round.id, action: 'writeback', weekLabel: round.weekLabel });
  });
});

describe('alertOnStuckFailures', () => {
  it('emails every active admin once, and does not repeat on an unchanged occurrence', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    const round = await aRound();
    await stuckLog(round.id, 'log-alert-1', '2026-08-11T16:20:00.000Z');

    await alertOnStuckFailures(db);
    await alertOnStuckFailures(db);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [message] = sendMail.mock.calls[0];
    expect(message.to).toEqual(['admin@example.com']);
  });

  it('sends a second email when the same round and action fail again later', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    const round = await aRound();
    await stuckLog(round.id, 'log-alert-2', '2026-08-11T16:20:00.000Z');
    await alertOnStuckFailures(db);
    expect(sendMail).toHaveBeenCalledTimes(1);

    // Retried by hand, then failed again later - a new ran_at on the same row.
    await db.run(`UPDATE round_automation_log SET ran_at = ?, attempts = 2 WHERE id = 'log-alert-2'`, [
      '2026-08-18T16:20:00.000Z',
    ]);
    await alertOnStuckFailures(db);

    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('does not throw when there are no active admins', async () => {
    const round = await aRound();
    await stuckLog(round.id, 'log-alert-3', '2026-08-11T16:20:00.000Z');

    await expect(alertOnStuckFailures(db)).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does nothing, and sends no email, when nothing is stuck', async () => {
    await saveMember(db, { name: 'Admin', email: 'admin@example.com', team: 'Ops', role: 'ADMIN' });
    await aRound();
    await alertOnStuckFailures(db);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

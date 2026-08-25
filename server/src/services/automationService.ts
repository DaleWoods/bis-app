import { Db } from '../db/index.js';
import { env } from '../config/env.js';
import { AppConfig, AutomationConfig, CadenceConfig } from '../domain/types.js';
import { cardBlocksAutomatedDistribution, type CardCheckInput } from '../domain/card.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/time.js';
import { audit, AuditActor } from './auditService.js';
import { getAppConfig } from './configService.js';
import { sendDistribution, sendReminders } from './emailService.js';
import { importQueue, writeBackRound } from './jiraService.js';
import { listActiveScorers } from './memberService.js';
import { packFilenameSlug, packInput } from './packService.js';
import { buildPptx } from '../pack/pptx.js';
import { roundResults, snapshotRoundResults } from './resultService.js';
import {
  Round,
  addTicketToRound,
  createRound,
  getRound,
  listRounds,
  listRoundTickets,
  markDistributed,
  setRoundStatus,
  setTicketHeld,
} from './roundService.js';
import { outstandingTicketsByMember } from './submissionService.js';
import type { Ticket } from './ticketService.js';

/** cardWarnings() needs to know about an unused image; listRoundTickets already carries the attachment list. */
function withHasUnusedImage(ticket: Ticket): CardCheckInput {
  return { ...ticket, hasUnusedImage: ticket.attachments.some((a) => a.isImage) };
}

/**
 * The weekly cycle, run by the app (§11, §12.2).
 *
 * Three rules hold the whole thing together:
 *
 *   1. **Every step is recorded before it is trusted.** `round_automation_log`
 *      has a unique key on (round, action), so a step that has run cannot run
 *      again - whatever the clock does, however often the tick fires, and
 *      across a restart mid-cycle.
 *   2. **Doing something by hand is not a conflict.** Each step re-reads the
 *      round and does nothing if a coordinator has already done it. Closing a
 *      round early is not an error; it just means the close step finds it
 *      closed.
 *   3. **Automation never invents a decision.** It runs the same service
 *      functions the buttons run, with the same guards. It cannot write a score
 *      the minimum-responses gate would reject, or finalise a round that has no
 *      results.
 *
 * The actor on every audit row is "automation", so the log always distinguishes
 * what the app did from what a person did.
 */

export const AUTOMATION_ACTOR: AuditActor = { id: 'automation', email: 'automation@bis.local' };

export interface AutomationStep {
  roundId: string;
  weekLabel: string;
  action: string;
  outcome: string;
}

export interface AutomationRun {
  ranAt: string;
  steps: AutomationStep[];
  /** Set when automation is off, so a caller can say why nothing happened. */
  skipped?: string;
}

/**
 * A transient failure - a JIRA blip, a mail server timeout - deserves one
 * automatic second try before it becomes a person's problem. Long enough that
 * retrying is not just hitting the same outage again a minute later.
 */
const RETRY_COOLDOWN_MS = 30 * 60_000;
const MAX_ATTEMPTS = 2;

/**
 * Records that a step ran, and reports whether this call is the one that got to
 * run it. The unique index does the work: two concurrent ticks race, one
 * inserts, the other is told no.
 *
 * A row that failed is not necessarily done: up to `MAX_ATTEMPTS`, a claim on
 * it succeeds again once `RETRY_COOLDOWN_MS` has passed, so the next tick gets
 * one more go. Past that it behaves as it always has - claimed for good, the
 * matching manual button the only way back.
 */
async function claim(db: Db, roundId: string, action: string, now: Date = new Date()): Promise<boolean> {
  const existing = await db.get<{ id: string; outcome: string; attempts: number; ran_at: string }>(
    'SELECT id, outcome, attempts, ran_at FROM round_automation_log WHERE round_id = ? AND action = ?',
    [roundId, action],
  );
  if (existing) {
    const failed = existing.outcome.startsWith('Failed:');
    const dueForRetry =
      failed &&
      Number(existing.attempts) < MAX_ATTEMPTS &&
      now.getTime() - new Date(existing.ran_at).getTime() >= RETRY_COOLDOWN_MS;
    if (!dueForRetry) return false;
    await db.run('UPDATE round_automation_log SET attempts = attempts + 1, ran_at = ?, outcome = ?, detail = ? WHERE id = ?', [
      nowIso(),
      '',
      '',
      existing.id,
    ]);
    return true;
  }
  try {
    await db.run('INSERT INTO round_automation_log (id, round_id, action, ran_at, attempts) VALUES (?, ?, ?, ?, 1)', [
      newId(),
      roundId,
      action,
      nowIso(),
    ]);
    return true;
  } catch {
    // Lost the race to another tick. Not an error - the step is being handled.
    return false;
  }
}

async function record(db: Db, roundId: string, action: string, outcome: string, detail = ''): Promise<void> {
  await db.run('UPDATE round_automation_log SET outcome = ?, detail = ? WHERE round_id = ? AND action = ?', [
    outcome.slice(0, 200),
    detail.slice(0, 2000),
    roundId,
    action,
  ]);
}

/** Undo a claim whose step turned out not to be due after all. */
async function release(db: Db, roundId: string, action: string): Promise<void> {
  await db.run('DELETE FROM round_automation_log WHERE round_id = ? AND action = ?', [roundId, action]);
}

export interface AutomationLogEntry {
  action: string;
  ranAt: string;
  outcome: string;
  detail: string;
}

export async function listAutomationLog(db: Db, roundId: string): Promise<AutomationLogEntry[]> {
  const rows = await db.all<{ action: string; ran_at: string; outcome: string; detail: string }>(
    'SELECT action, ran_at, outcome, detail FROM round_automation_log WHERE round_id = ? ORDER BY ran_at ASC',
    [roundId],
  );
  return rows.map((row) => ({ action: row.action, ranAt: row.ran_at, outcome: row.outcome, detail: row.detail }));
}

// --- Cadence arithmetic ----------------------------------------------------

/**
 * The next time this day-of-week, hour and minute occurs at or after `from`.
 *
 * Deliberately arithmetic on UTC rather than a timezone library: the app has no
 * dependency on one, and the cadence is a weekly rhythm, not a scheduling
 * product. The practical cost is that a cadence set in the summer runs an hour
 * out over a British winter - which is why `timezoneOffsetMinutes` exists and
 * why the Settings screen says what it means.
 */
export function nextOccurrence(
  from: Date,
  dayOfWeek: number,
  hour: number,
  minute = 0,
  offsetMinutes = 0,
): Date {
  const local = new Date(from.getTime() + offsetMinutes * 60_000);
  const result = new Date(local);
  result.setUTCHours(hour, minute, 0, 0);

  let delta = (dayOfWeek - result.getUTCDay() + 7) % 7;
  if (delta === 0 && result.getTime() <= local.getTime()) delta = 7;
  result.setUTCDate(result.getUTCDate() + delta);

  return new Date(result.getTime() - offsetMinutes * 60_000);
}

/** Minutes to add to UTC for the configured timezone, as of `at`. */
export function timezoneOffsetMinutes(timezone: string, at: Date = new Date()): number {
  try {
    // Intl is the only timezone database available without a dependency, and it
    // is enough to ask "what does the wall clock say there right now".
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/** The window the next round should run over, from the cadence settings. */
export function nextRoundWindow(cadence: CadenceConfig, from: Date = new Date()): { opensAt: Date; cutOffAt: Date } {
  const offset = timezoneOffsetMinutes(cadence.timezone, from);
  const opensAt = nextOccurrence(
    from,
    cadence.distributionDayOfWeek,
    cadence.distributionHour,
    cadence.distributionMinute,
    offset,
  );
  const cutOffAt = nextOccurrence(opensAt, cadence.cutOffDayOfWeek, cadence.cutOffHour, cadence.cutOffMinute, offset);
  return { opensAt, cutOffAt };
}

/**
 * "Week commencing 07 Aug 2026", matching what a coordinator would type.
 *
 * Formatted in the cadence timezone rather than the server's. A Monday-morning
 * opening in British Summer Time is Sunday evening in UTC - which is what
 * Render runs on - so the server clock would otherwise label the round with the
 * wrong week.
 */
export function weekLabelFor(date: Date, timezone = 'Europe/London'): string {
  const label = date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  });
  return `Week commencing ${label}`;
}

// --- The cycle -------------------------------------------------------------

/**
 * Run whatever is due. Safe to call as often as you like: every step is guarded
 * by its own claim, its own clock check and the state of the round itself.
 */
export async function runDueAutomation(db: Db, now: Date = new Date()): Promise<AutomationRun> {
  const config = await getAppConfig(db);
  const steps: AutomationStep[] = [];

  if (!config.automation.enabled) return { ranAt: nowIso(), steps, skipped: 'Automation is switched off' };

  const rounds = await listRounds(db);
  const created = await maybeCreateNextRound(db, config, rounds, now, steps);

  // Finalised rounds are still visited, because write-back is a step in its own
  // right: a coordinator who finalises by hand should still get the scores
  // pushed to JIRA. The claim row stops it running twice, so revisiting a
  // settled round costs one indexed lookup.
  for (const round of created ? [created, ...rounds] : rounds) {
    if (round.automationPaused) continue;
    await runRound(db, round, config, now, steps);
  }

  return { ranAt: nowIso(), steps };
}

async function maybeCreateNextRound(
  db: Db,
  config: AppConfig,
  rounds: Round[],
  now: Date,
  steps: AutomationStep[],
): Promise<Round | null> {
  if (!config.automation.createRounds) return null;

  // One round in flight at a time. A round that has not yet reached its cut-off
  // is the round people are working on, so there is nothing to create.
  const live = rounds.find((r) => r.status !== 'FINALISED' && new Date(r.cutOffAt).getTime() > now.getTime());
  if (live) return null;

  const { opensAt, cutOffAt } = nextRoundWindow(config.cadence, now);
  const weekLabel = weekLabelFor(opensAt, config.cadence.timezone);
  if (rounds.some((r) => r.weekLabel === weekLabel)) return null;

  const round = await createRound(db, {
    weekLabel,
    cutOffAt: cutOffAt.toISOString(),
    opensAt: opensAt.toISOString(),
    notes: 'Created automatically from the cadence settings.',
    createdBy: AUTOMATION_ACTOR.id ?? 'automation',
  });
  await audit(db, AUTOMATION_ACTOR, 'round.create', 'round', round.id, { weekLabel, automated: true });
  steps.push({ roundId: round.id, weekLabel, action: 'create', outcome: `Created ${weekLabel}` });

  const detail: string[] = [];

  if (config.automation.rollOverUnscored) {
    const carried = await rollOverUnscored(db, rounds, round, config);
    if (carried) detail.push(`${carried} ticket(s) rolled over`);
  }

  if (config.automation.importFromJira && env.jira.configured) {
    try {
      const result = await importQueue(db, AUTOMATION_ACTOR, { roundId: round.id });
      detail.push(`${result.imported.length} imported from JIRA`);
    } catch (err) {
      detail.push(`JIRA import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (detail.length) {
    steps.push({ roundId: round.id, weekLabel, action: 'fill', outcome: detail.join('; ') });
  }

  return round;
}

/**
 * Tickets that finalised without enough responses "roll over" (§10.3) - which
 * until now was a phrase in a status label rather than something the app did.
 */
async function rollOverUnscored(db: Db, rounds: Round[], target: Round, config: AppConfig): Promise<number> {
  const previous = rounds.filter((r) => r.status === 'FINALISED').sort((a, b) => b.cutOffAt.localeCompare(a.cutOffAt))[0];
  if (!previous) return 0;

  const results = await roundResults(db, previous, { config: config.scoring });
  let carried = 0;
  for (const { ticket, aggregate } of results) {
    if (aggregate.minSubmissionsMet || aggregate.toClose) continue;
    await addTicketToRound(db, target.id, ticket.id);
    carried += 1;
  }
  if (carried) {
    await audit(db, AUTOMATION_ACTOR, 'round.rollover', 'round', target.id, { from: previous.id, tickets: carried });
  }
  return carried;
}

/**
 * Walk one round through whatever is due.
 *
 * `state` is re-read after every transition rather than trusting the round as
 * it was loaded. That is what lets a single pass carry a round the whole way:
 * a service that was down over the cut-off comes back and closes, finalises and
 * writes back on its first tick, instead of taking one step per minute for
 * three minutes. It also means a step sees a status a coordinator changed while
 * the tick was mid-flight.
 */
async function runRound(db: Db, round: Round, config: AppConfig, now: Date, steps: AutomationStep[]): Promise<void> {
  const automation = config.automation;
  const push = (action: string, outcome: string) =>
    steps.push({ roundId: round.id, weekLabel: round.weekLabel, action, outcome });

  const cutOff = new Date(round.cutOffAt).getTime();
  const opensAt = round.opensAt ? new Date(round.opensAt).getTime() : null;
  let state: Round = round;
  const reload = async () => {
    state = (await getRound(db, round.id)) ?? state;
  };

  // --- Open and distribute ------------------------------------------------
  if (automation.distribute && state.status === 'DRAFT' && opensAt !== null && now.getTime() >= opensAt) {
    if (await claim(db, round.id, 'distribute', now)) {
      try {
        const tickets = await listRoundTickets(db, round.id);
        // A ticket cardBlocksAutomatedDistribution() flags - nothing drafted
        // at all, or jargon leaking through - is not safe to send unattended.
        // Held back rather than dropped, so a coordinator finds it sitting on
        // the round rather than missing from it.
        const flagged = new Map(tickets.map((t) => [t.id, cardBlocksAutomatedDistribution(withHasUnusedImage(t))]));
        const ready = tickets.filter((t) => !flagged.get(t.id)?.length);

        if (!ready.length) {
          // Nothing safe to send yet - same as an empty round: wait for a
          // ticket, or for a coordinator to fix what's here.
          await release(db, round.id, 'distribute');
        } else {
          for (const ticket of tickets) {
            const warnings = flagged.get(ticket.id) ?? [];
            if (warnings.length) await setTicketHeld(db, round.id, ticket.id, true, warnings.join('; '));
          }
          const held = tickets.length - ready.length;

          const opened = await setRoundStatus(db, round.id, 'OPEN');
          const members = await listActiveScorers(db);

          // Matches manual "Distribute to committee", which always attaches
          // the pack - the app has no download button for it any more, so the
          // email is the only place anyone sees it.
          let attachment;
          if (env.email.canSend) {
            const input = await packInput(round.id);
            if (input) {
              const buffer = await buildPptx(input);
              attachment = {
                name: `bis-${packFilenameSlug(opened.weekLabel)}-pack.pptx`,
                contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                contentBytes: buffer.toString('base64'),
              };
            }
          }

          const results = await sendDistribution(db, opened, ready, members, attachment);
          const sent = results.filter((r) => r.status === 'SENT').length;
          // Only a real send counts as distribution. With email off the
          // messages are composed and logged, and the round should not claim
          // the committee has been told.
          if (sent > 0) await markDistributed(db, round.id);
          const outcome = `Opened and emailed ${sent} of ${results.length} member(s), ${ready.length} ticket(s)${
            held ? ` — ${held} held back for a card that needs a look` : ''
          }`;
          await record(db, round.id, 'distribute', outcome);
          await audit(db, AUTOMATION_ACTOR, 'round.distribute', 'round', round.id, { sent, held, automated: true });
          push('distribute', outcome);
        }
      } catch (err) {
        await failed(db, round, 'distribute', err, push);
      }
      await reload();
    }
  }

  // --- Reminders ----------------------------------------------------------
  if (automation.remind && state.status === 'OPEN') {
    // The escalation hour is a reminder point like any other, just later and
    // sharper-worded - so it runs through the same claim/send/record path
    // rather than a separate one that could drift from it.
    const points: Array<{ hours: number; escalation: boolean }> = [
      ...config.cadence.reminderHoursBeforeCutOff.map((hours) => ({ hours, escalation: false })),
      ...(config.cadence.escalationHoursBeforeCutOff !== null
        ? [{ hours: config.cadence.escalationHoursBeforeCutOff, escalation: true }]
        : []),
    ].sort((a, b) => b.hours - a.hours);

    for (const { hours, escalation } of points) {
      const due = cutOff - hours * 60 * 60 * 1000;
      if (now.getTime() < due || now.getTime() >= cutOff) continue;
      const action = escalation ? `escalate:${hours}` : `remind:${hours}`;
      if (!(await claim(db, round.id, action, now))) continue;
      try {
        const scorers = await listActiveScorers(db);
        const tickets = await listRoundTickets(db, round.id);
        const outstandingTickets = await outstandingTicketsByMember(db, round.id, scorers, tickets);
        const targets = scorers
          .map((member) => ({ member, outstandingTickets: outstandingTickets.get(member.id) ?? [] }))
          .filter((t) => t.outstandingTickets.length > 0);
        if (!targets.length) {
          await record(db, round.id, action, 'Everyone had already scored');
          continue;
        }
        const results = await sendReminders(db, round, targets, escalation);
        const sent = results.filter((r) => r.status === 'SENT').length;
        const outcome = `Chased ${sent} of ${targets.length} outstanding member(s)`;
        await record(db, round.id, action, outcome);
        await audit(db, AUTOMATION_ACTOR, escalation ? 'round.escalate' : 'round.remind', 'round', round.id, {
          hours,
          sent,
          automated: true,
        });
        push(action, outcome);
      } catch (err) {
        await failed(db, round, action, err, push);
      }
    }
  }

  // --- Close --------------------------------------------------------------
  if (automation.close && state.status === 'OPEN' && now.getTime() >= cutOff) {
    if (await claim(db, round.id, 'close', now)) {
      try {
        await setRoundStatus(db, round.id, 'CLOSED');
        await record(db, round.id, 'close', 'Scoring closed at the cut-off');
        await audit(db, AUTOMATION_ACTOR, 'round.closed', 'round', round.id, { automated: true });
        push('close', 'Scoring closed at the cut-off');
      } catch (err) {
        await failed(db, round, 'close', err, push);
      }
      await reload();
    }
  }

  // --- Finalise -----------------------------------------------------------
  const finaliseAt = cutOff + automation.finaliseDelayHours * 60 * 60 * 1000;
  await reload();
  if (automation.finalise && state.status === 'CLOSED' && now.getTime() >= finaliseAt) {
    if (await claim(db, round.id, 'finalise', now)) {
      try {
        const finalised = await setRoundStatus(db, round.id, 'FINALISED');
        const results = await snapshotRoundResults(db, finalised);
        const scored = results.filter((r) => r.aggregate.businessScore !== null).length;
        const outcome = `Finalised — ${scored} of ${results.length} ticket(s) scored`;
        await record(db, round.id, 'finalise', outcome);
        await audit(db, AUTOMATION_ACTOR, 'round.finalise', 'round', round.id, {
          tickets: results.length,
          scored,
          automated: true,
        });
        push('finalise', outcome);
      } catch (err) {
        await failed(db, round, 'finalise', err, push);
      }
      await reload();
    }
  }

  // --- Write back ---------------------------------------------------------
  // Deliberately keyed on the round being finalised rather than on automation
  // having been the one to finalise it. Finalising by hand is a manual
  // override of one step, not an instruction to stop automating the rest.
  if (automation.writeBack && state.status === 'FINALISED') {
    await runWriteBack(db, state, now, push);
  }
}

async function runWriteBack(db: Db, round: Round, now: Date, push: (action: string, outcome: string) => void): Promise<void> {
  if (!env.jira.configured) {
    await claim(db, round.id, 'writeback', now);
    await record(db, round.id, 'writeback', 'Skipped — JIRA is not configured');
    push('writeback', 'Skipped — JIRA is not configured');
    return;
  }
  if (!(await claim(db, round.id, 'writeback', now))) return;

  try {
    const entries = await writeBackRound(db, AUTOMATION_ACTOR, round);
    const written = entries.filter((e) => e.status === 'SUCCESS').length;
    const skipped = entries.filter((e) => e.status === 'SKIPPED');
    const failures = entries.filter((e) => e.status === 'FAILED');
    const outcome = `${written} written, ${skipped.length} skipped, ${failures.length} failed`;
    // The reasons are the useful part: "1 skipped" on its own tells a
    // coordinator nothing, which is exactly the complaint that started this.
    const detail = [...skipped, ...failures].map((e) => `${e.jiraId}: ${e.reason ?? ''}`).join('\n');
    await record(db, round.id, 'writeback', outcome, detail);
    push('writeback', outcome);
  } catch (err) {
    await failed(db, round, 'writeback', err, push);
  }
}

/**
 * A failed step stays claimed rather than being retried every minute. It is
 * visible on the round page with its error, and the matching manual button
 * re-runs it - a loop that retries a bad JIRA token every 60 seconds helps
 * nobody and fills the audit log.
 */
async function failed(
  db: Db,
  round: Round,
  action: string,
  err: unknown,
  push: (action: string, outcome: string) => void,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // A transient blip and a genuinely broken step read identically to a
  // coordinator unless the message says which one this is - so it says.
  const row = await db.get<{ attempts: number }>(
    'SELECT attempts FROM round_automation_log WHERE round_id = ? AND action = ?',
    [round.id, action],
  );
  const attempts = Number(row?.attempts ?? MAX_ATTEMPTS);
  const tail = attempts < MAX_ATTEMPTS ? ' (will retry automatically)' : ' (retries exhausted — run this step by hand)';
  const outcome = `Failed: ${message}${tail}`;
  await record(db, round.id, action, outcome);
  await audit(db, AUTOMATION_ACTOR, `automation.${action}.failed`, 'round', round.id, { error: message, attempts });
  console.warn(`[bis] automation ${action} failed for ${round.weekLabel}: ${message}`);
  push(action, outcome);
}

/**
 * What automation will do to this round next, in the coordinator's words. Shown
 * on the round page so the cycle is never a surprise.
 */
export function describeNext(
  round: Round,
  automation: AutomationConfig,
  now: Date = new Date(),
  timezone = 'Europe/London',
): string {
  if (!automation.enabled) return 'Automation is off — run each step yourself from Round actions.';
  if (round.automationPaused) return 'Automation is paused for this round. Every step is yours to run.';

  const cutOff = new Date(round.cutOffAt);
  // In the cadence timezone, so a coordinator who set 09:00 is told 09:00.
  // Without this the times are rendered in the server's zone, which on Render
  // is UTC - an hour out from the configured cadence for half the year.
  const when = (date: Date) =>
    date.toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    });

  if (round.status === 'DRAFT') {
    if (!automation.distribute) return 'Opening and distributing is switched off — do it from Round actions.';
    if (!round.opensAt) return 'No opening time set, so this round will not distribute on its own.';
    const opens = new Date(round.opensAt);
    return opens.getTime() > now.getTime()
      ? `Opens and goes to the committee at ${when(opens)}.`
      : 'Due to open now — add at least one ticket and it will go out on the next check.';
  }

  if (round.status === 'OPEN') {
    if (!automation.close) return `Scoring closes at ${when(cutOff)}, but closing it is switched off.`;
    return `Scoring closes automatically at ${when(cutOff)}.`;
  }

  if (round.status === 'CLOSED') {
    if (!automation.finalise) return 'Closed. Finalising is switched off — finalise it from Round actions.';
    const finaliseAt = new Date(cutOff.getTime() + automation.finaliseDelayHours * 3600_000);
    const tail = automation.writeBack ? ', then the scores go to JIRA' : '';
    return finaliseAt.getTime() > now.getTime()
      ? `Finalises at ${when(finaliseAt)}${tail}.`
      : `Due to finalise now${tail}.`;
  }

  return 'Finalised. Nothing further is automated.';
}

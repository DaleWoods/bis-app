import { getDb } from '../db/index.js';
import { env } from '../config/env.js';
import { alertOnStuckFailures, runDueAutomation } from './automationService.js';
import { runDailyBackupIfDue } from './backupService.js';
import { alertOnUnresolvedDiscussions } from './discussionService.js';

/**
 * The clock behind the automated cycle (§11, §12.2).
 *
 * An interval inside the web service rather than a separate cron service: it
 * needs no extra Render component, no scheduler to configure, and no second
 * deployment to keep in step. Reversing decision D2, which assumed the hosting
 * choice should stay open - it has been made, and the app is the only thing
 * that knows the cadence.
 *
 * Two things follow from that choice, and both are handled rather than assumed
 * away:
 *
 * - **One instance.** Every automated step claims a row in
 *   `round_automation_log` before running, so even if a second instance did
 *   appear, a step would run once. The tick is cheap either way: with
 *   automation off it is a single config read.
 * - **A missed window is not a skipped step.** The scheduler asks "what is
 *   due", never "what is due right now". A service asleep at the cut-off closes
 *   the round on the next tick after it wakes, an hour late rather than never.
 */

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  // A long JIRA import must not overlap the next tick and double up work that
  // the claim rows would then have to sort out.
  if (running) return;
  running = true;
  try {
    const db = await getDb();
    const run = await runDueAutomation(db);
    for (const step of run.steps) {
      console.log(`[bis] automation ${step.action} — ${step.weekLabel}: ${step.outcome}`);
    }
    await alertOnStuckFailures(db);
  } catch (err) {
    // A failing tick must never take the web service down with it.
    console.error('[bis] automation tick failed:', err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

let alwaysOnTimer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  // These two run regardless of SCHEDULER_ENABLED - that flag is about the
  // weekly round cycle, not about whether the only copy of the data gets
  // backed up or whether anyone finds out a ticket needs a decision. A round
  // scored entirely by hand, with automation fully off, can still produce a
  // split ticket nobody notices unless they go looking - the same problem
  // the flag exists to solve for automation's own failures, just with a
  // different trigger.
  if (!alwaysOnTimer) {
    alwaysOnTimer = setInterval(() => {
      getDb()
        .then(async (db) => {
          await runDailyBackupIfDue(db);
          await alertOnUnresolvedDiscussions(db);
        })
        .catch((err) => console.error('[bis] background tick failed:', err instanceof Error ? err.message : err));
    }, TICK_MS);
    alwaysOnTimer.unref?.();
  }

  if (timer) return;
  if (!env.schedulerEnabled) {
    console.log('[bis] scheduler disabled (SCHEDULER_ENABLED=false) — every step stays manual.');
    return;
  }

  // unref so the timer never holds the process open during a shutdown.
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  console.log(`[bis] scheduler running every ${TICK_MS / 1000}s. Automation itself is switched on in Settings.`);

  // One tick shortly after boot, so a restart picks up anything that fell due
  // while the service was down without waiting for the first interval.
  setTimeout(() => void tick(), 5_000).unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (alwaysOnTimer) clearInterval(alwaysOnTimer);
  alwaysOnTimer = null;
}

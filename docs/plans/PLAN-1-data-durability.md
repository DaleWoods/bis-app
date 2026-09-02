# PLAN 1 — Stop the database from being able to disappear

**Leverage rank: 1 of 5 (do this first).**

## Why this is the highest-leverage thing in the repo

Two facts, read together, describe a real risk of losing every round this
committee has ever scored, permanently, with no way back:

1. `render.yaml` provisions the production database on Render's **free**
   Postgres plan:

   ```yaml
   databases:
     - name: bis-db
       databaseName: bis
       user: bis
       plan: free
   ```

   Render deletes free databases **30 days** after creation. This is not a
   hypothetical — it is stated in the file's own comment two lines above:
   `# free lets you trial it at no cost, but Render deletes free databases
   after 30 days. Move to basic-256mb before this holds scoring data you
   need.` If the live service is still on this plan, the clock is already
   running.

2. There is **no backup mechanism anywhere in this codebase.** Searching the
   whole repo for `backup` returns nothing outside this plan. The only
   export capability that exists is a per-round CSV
   (`GET /api/rounds/:id/results.csv`) — useful for one round's scores, not
   a way to reconstruct the database (it has no members, config, tickets,
   discussions, email log, write-back history, or audit trail).

`docs/requirements-traceability.md` §3 calls this app the **"single system
of record"** for the whole scoring process, replacing a spreadsheet. If the
database is deleted or corrupted, everything it replaced is also gone,
because nothing else holds the data any more.

This plan has two parts. **Part A is one manual action a human must take —
a coding agent cannot do it.** Part B is the code this repo needs so that,
even if Part A is forgotten or Render's own backups fail, a independent copy
of the data exists somewhere else.

Do not skip Part A because Part B looks like it solves the problem — Part B
is a safety net under Part A, not a replacement for it.

---

## Part A — Manual action (tell the human, do not attempt to script this)

If you are an AI agent executing this plan: **stop and tell the user** to do
this before or alongside your work on Part B. You cannot log into the
Render dashboard.

1. Open the Render dashboard → the `bis-db` database.
2. Check its current plan. If it says **Free**, upgrade it to at least
   **Basic 256mb** (or higher, if the committee/ticket volume has grown).
   Paid Render Postgres plans include Render-managed automated daily
   backups with point-in-time recovery — this is the primary defence, and
   it is a dashboard click, not a code change.
3. Confirm in the dashboard that automated backups are showing as enabled
   after the upgrade.
4. Update `render.yaml` (see Part B, step 1) so a future redeploy of the
   Blueprint does not describe `free` as the intended plan — the file
   should always describe the plan actually in use, since it is what the
   next person reads to understand the deployment.

---

## Part B — Code: an independent backup, decoupled from Render

### Goal

Add a full-database export that:

- Can be triggered on demand by an admin from Settings (`Export a backup
  now`).
- Runs automatically once a day and emails the export to every active
  `ADMIN`, as an attachment — reusing the SMTP integration that is already
  configured and already sends distribution/reminder mail, so this needs
  no new external service, no new credentials, and no new Render
  component.
- Is a plain JSON file (optionally gzip-compressed) containing every row of
  every table, restorable by hand if it is ever needed — not a Postgres-
  specific `pg_dump` binary format, so it works the same way whether the
  installation is on SQLite (local/dev) or Postgres (production), and
  because the goal here is "Dale can still see every historic score if
  Render vanishes tomorrow", not "this can be piped straight back into
  `psql`".

### Exact files to touch

| File | Change |
|---|---|
| `render.yaml` | Update the `plan: free` comment/value (see step 1). |
| `server/src/services/backupService.ts` | **New file.** The export + email logic. |
| `server/src/services/backupService.test.ts` | **New file.** Tests. |
| `server/src/routes/backup.ts` | **New file.** The on-demand export route. |
| `server/src/index.ts` | Register the new route; nothing else changes here. |
| `server/src/services/scheduler.ts` | Add a second, independent daily check inside `tick()` (or its own tiny interval) that runs the backup once every 24h. |
| `web/src/api.ts` | Add `api.exportBackupNow()` and the `BackupSummary` type (or reuse a simple `{ ok: boolean }`). |
| `web/src/pages/SettingsPage.tsx` | Add an "Export a backup now" button in a new "Data" section. |
| `web/src/pages/GuidePage.tsx` | One paragraph, in the coordinator half of the guide, saying backups exist and where. |

### Step-by-step

**Step 1 — Fix `render.yaml`.**

Change:

```yaml
databases:
  - name: bis-db
    databaseName: bis
    user: bis
    # free lets you trial it at no cost, but Render deletes free databases after
    # 30 days. Move to basic-256mb before this holds scoring data you need.
    plan: free
```

to:

```yaml
databases:
  - name: bis-db
    databaseName: bis
    user: bis
    # basic-256mb (not free): Render deletes free-tier databases after 30
    # days and free tier carries no automated backups. This holds the only
    # copy of every round the committee has ever scored - see
    # docs/plans/PLAN-1-data-durability.md for the full reasoning, and the
    # nightly emailed export in backupService.ts as the independent
    # second copy.
    plan: basic-256mb
```

Do not just change the value without the comment — the next person to read
this file needs to know *why* free is wrong, not just that it is.

**Step 2 — Write `server/src/services/backupService.ts`.**

Model it on the existing services in `server/src/services/` — same style of
doc comment explaining the *why*, same `Db` parameter pattern used
everywhere else (e.g. `auditService.ts`, `emailService.ts`).

```ts
import { Db } from '../db/index.js';
import { audit } from './auditService.js';
import { listMembers } from './memberService.js';
import { sendMail, type MailAttachment } from '../integrations/mail.js';
import { nowIso } from '../util/time.js';

/**
 * Every table in the schema, in an order that is safe to re-insert in (a
 * table only appears after anything it has a foreign key to). Update this
 * list in the same commit as any migration that adds or renames a table -
 * a table missing from here is a table silently left out of every future
 * backup, which defeats the entire point and would not be noticed until
 * someone needed the missing data.
 */
const TABLES = [
  'app_config',
  'categories',
  'members',
  'tickets',
  'rounds',
  'round_tickets',
  'submissions',
  'submission_scores',
  'ticket_results',
  'ticket_discussions',
  'email_log',
  'jira_writebacks',
  'round_automation_log',
  'audit_log',
] as const;

export interface BackupExport {
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/** Read every row of every table into one plain object. Read-only - never mutates anything. */
export async function buildBackupExport(db: Db): Promise<BackupExport> {
  const tables: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    tables[table] = await db.all(`SELECT * FROM ${table}`);
  }
  return { exportedAt: nowIso(), tables };
}

function toAttachment(data: BackupExport): MailAttachment {
  const json = JSON.stringify(data);
  return {
    name: `bis-backup-${data.exportedAt.slice(0, 10)}.json`,
    contentType: 'application/json',
    contentBytes: Buffer.from(json, 'utf8').toString('base64'),
  };
}

/**
 * Build the export and email it to every active admin. This is the
 * independent second copy of the data - it does not depend on Render's own
 * backups, the database driver, or anyone remembering to click a button.
 *
 * Failure here must never throw into the scheduler tick or the request
 * handler that triggered it; a failed backup attempt is worth logging, not
 * worth taking the app down over.
 */
export async function runBackupAndEmail(
  db: Db,
  actor: { id?: string | null; email?: string | null },
): Promise<{ ok: boolean; recipients: number; error?: string }> {
  try {
    const data = await buildBackupExport(db);
    const admins = (await listMembers(db, false)).filter((m) => m.role === 'ADMIN');
    if (!admins.length) {
      await audit(db, actor, 'backup.export', 'system', '', { recipients: 0, reason: 'no active admins' });
      return { ok: false, recipients: 0, error: 'No active admin to send the backup to' };
    }
    const attachment = toAttachment(data);
    const tableCounts = Object.fromEntries(TABLES.map((t) => [t, data.tables[t].length]));
    const outcome = await sendMail({
      to: admins.map((a) => a.email),
      subject: `BIS database backup — ${data.exportedAt.slice(0, 10)}`,
      html: `<p>Attached: a full export of the Business Impact Scoring database, taken ${data.exportedAt}.</p>
<p>Row counts: ${Object.entries(tableCounts).map(([t, n]) => `${t}: ${n}`).join(', ')}.</p>
<p>Keep this somewhere outside Render - a shared drive, an email folder that is itself backed up. This is the independent copy, not a substitute for Render's own database backups.</p>`,
      attachments: [attachment],
    });
    await audit(db, actor, 'backup.export', 'system', '', {
      recipients: admins.length,
      status: outcome.status,
      error: outcome.error,
      tableCounts,
    });
    return { ok: outcome.status === 'SENT', recipients: admins.length, error: outcome.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(db, actor, 'backup.export.failed', 'system', '', { error: message });
    return { ok: false, recipients: 0, error: message };
  }
}

const AUTOMATION_ACTOR = { id: null, email: 'automation@bis' };

/**
 * True once in every rolling 24h window. Reads the most recent successful
 * `backup.export` audit entry rather than keeping its own clock, so a
 * restart never causes two backups in one day and a long outage never
 * causes zero - the very next tick after the gap sends one.
 */
export async function backupDueToday(db: Db): Promise<boolean> {
  const last = await db.get<{ at: string }>(
    `SELECT at FROM audit_log WHERE action = 'backup.export' ORDER BY at DESC LIMIT 1`,
  );
  if (!last) return true;
  const hoursSince = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
  return hoursSince >= 24;
}

export async function runDailyBackupIfDue(db: Db): Promise<void> {
  if (!(await backupDueToday(db))) return;
  await runBackupAndEmail(db, AUTOMATION_ACTOR);
}
```

**Edge cases a weaker model would miss here:**

- **Do not use `SELECT * FROM tickets` etc. with string interpolation of
  anything except the fixed `TABLES` list above.** The table names are a
  hardcoded constant, never user input, so this is safe — but do not
  generalise this into something that takes a table name from a request,
  ever.
- **`sendMail`'s `attachments` field expects base64 in `contentBytes`**, not
  raw bytes and not a data URL — see `server/src/integrations/mail.ts`.
  Getting this wrong produces an email that "sends" successfully but has a
  corrupt or missing attachment, which is worse than an obvious failure
  because nobody notices until they need the backup.
- **`listMembers(db, false)` returns only active members** — the boolean
  parameter is `includeInactive`, so `false` excludes inactive ones. Filter
  additionally by `role === 'ADMIN'`. Do not send this to `COMMITTEE`
  members — the export includes every audit log entry and every
  submission's raw data across the whole company process; it is
  administrative data, not something to broadcast to the whole committee.
- **Never let a backup failure throw uncaught.** Both `runBackupAndEmail`
  and its caller in the scheduler must catch everything. A backup routine
  that can crash the process it is meant to be protecting is a net
  negative.
- **The "due today" check must not use an in-memory variable.** A service
  restarts on every deploy (which, given this session's history, is
  often). Use the durable `audit_log` table as done above, not a module-
  level `let lastBackupAt`, or a redeploy resets the clock and could cause
  either duplicate same-day emails or (worse, silently) no reliable
  cadence at all.

**Step 3 — Wire the daily check into the scheduler.**

In `server/src/services/scheduler.ts`, inside `tick()`, after the existing
`runDueAutomation(db)` call, add:

```ts
import { runDailyBackupIfDue } from './backupService.js';
```

and inside the `try` block of `tick()`:

```ts
    const run = await runDueAutomation(db);
    for (const step of run.steps) {
      console.log(`[bis] automation ${step.action} — ${step.weekLabel}: ${step.outcome}`);
    }
    await runDailyBackupIfDue(db);
```

Do not create a second `setInterval`. The existing tick already runs every
60 seconds regardless of `SCHEDULER_ENABLED` state for automation — check:
`startScheduler()` returns early if `!env.schedulerEnabled` and never
starts the timer at all in that case, which means the backup would never
run on an instance with automation switched off entirely. **This is
almost certainly not what is wanted** — backups should run independently
of whether round automation is enabled, since scoring can still happen by
hand with automation off. Therefore: move the daily-backup check so it
runs even when `SCHEDULER_ENABLED=false`, by giving it its own always-on
interval rather than nesting it inside the automation-gated one. Concretely,
in `startScheduler()`:

```ts
export function startScheduler(): void {
  // The daily backup runs regardless of SCHEDULER_ENABLED - that flag is
  // about the weekly round cycle, not about whether the only copy of the
  // data gets backed up.
  const backupTimer = setInterval(() => {
    getDb().then((db) => runDailyBackupIfDue(db)).catch((err) => console.error('[bis] backup tick failed:', err));
  }, TICK_MS);
  backupTimer.unref?.();

  if (timer) return;
  if (!env.schedulerEnabled) {
    console.log('[bis] scheduler disabled (SCHEDULER_ENABLED=false) — every step stays manual.');
    return;
  }
  ...
```

(Import `getDb` from `../db/index.js` at the top if not already imported in
this file — check first, it likely already is via the existing `tick()`.)

**Step 4 — The on-demand route.**

`server/src/routes/backup.ts`:

```ts
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireCoordinator } from '../auth/middleware.js';
import { runBackupAndEmail } from '../services/backupService.js';
import { actorOf, asyncHandler } from './helpers.js';

const router = Router();

/** On-demand full-database export, emailed to every active admin (§14). */
router.post(
  '/backup/export',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const db = await getDb();
    const result = await runBackupAndEmail(db, actorOf(req));
    res.json(result);
  }),
);

export default router;
```

Check `server/src/routes/helpers.ts` for the exact shape of `actorOf` and
`asyncHandler` before writing this — every other route file in
`server/src/routes/` imports both from `./helpers.js`, follow the same
pattern exactly.

**Step 5 — Register the route.**

In `server/src/index.ts`, alongside the other route imports (look for
`import queueRoutes from './routes/queue.js';` as the most recent example
and copy its shape):

```ts
import backupRoutes from './routes/backup.js';
```

and alongside `app.use('/api', queueRoutes);`:

```ts
app.use('/api', backupRoutes);
```

**Step 6 — Client API + Settings button.**

In `web/src/api.ts`, add near the other admin-only actions:

```ts
exportBackupNow: () =>
  request<{ ok: boolean; recipients: number; error?: string }>('/api/backup/export', { method: 'POST' }),
```

In `web/src/pages/SettingsPage.tsx`, add a new `<section className="card">`
(follow the exact structure of the existing "The queue" section added
earlier in this file — a heading, an explanatory `<p className="hint">`,
and a button with local `busy`/`message`/`error` state matching the
patterns already used throughout this component for every other button —
read the file first and copy an existing button's state-handling exactly
rather than inventing a new pattern):

```tsx
<section className="card">
  <h2 style={{ marginTop: 0 }}>Data</h2>
  <p className="hint">
    A full export of everything in this app - every round, ticket, score and
    the audit trail - is emailed to every admin automatically once a day, and
    logged in the audit log. Use this to send one right now, before making a
    change you might want to undo.
  </p>
  <button
    type="button"
    className="secondary"
    disabled={exporting}
    onClick={async () => {
      setExporting(true);
      setError('');
      setMessage('');
      try {
        const result = await api.exportBackupNow();
        setMessage(
          result.ok
            ? `Backup sent to ${result.recipients} admin${result.recipients === 1 ? '' : 's'}.`
            : `Backup was not sent: ${result.error ?? 'unknown error'}`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not export a backup');
      } finally {
        setExporting(false);
      }
    }}
  >
    {exporting ? 'Exporting…' : 'Export a backup now'}
  </button>
</section>
```

Add the `exporting` state near the top of the component alongside the
other `useState` calls already there
(`const [exporting, setExporting] = useState(false);`). Reuse the existing
`message`/`error` state already in this component if present — check first
rather than adding duplicate state variables.

**Step 7 — Guide.**

Per this repo's `CLAUDE.md` rule ("update the guide in the same commit as
the change"), add one paragraph to the coordinator section of
`web/src/pages/GuidePage.tsx` (near the Settings section, `id="settings"`):

```
A full backup of the database - every round, ticket, score and the audit
trail - is emailed to every admin automatically once a day, and can be sent
on demand from Settings → Data → "Export a backup now".
```

### Tests

`server/src/services/backupService.test.ts` — follow the exact test setup
pattern used in every other service test file in this repo (e.g.
`server/src/services/participationHistory.test.ts` or
`server/src/services/writeBack.test.ts` — read one of these first and copy
its `beforeEach`/`afterEach`/`createDb`/`migrate` boilerplate exactly).

Mock `sendMail` the same way `writeBack.test.ts` mocks
`integrations/jira.js` — with `vi.mock('../integrations/mail.js', () => ({
sendMail: vi.fn().mockResolvedValue({ status: 'SENT' }) }))` at the top of
the file, before the dynamic imports.

Required test cases:

1. `buildBackupExport` returns every table in `TABLES`, each as an array
   (even when empty).
2. `runBackupAndEmail` sends to every active admin's email and no
   `COMMITTEE` member's email — assert on the `to` array passed to the
   mocked `sendMail`.
3. `runBackupAndEmail` returns `{ ok: false }` and does not throw when
   there are no active admins.
4. `runBackupAndEmail` returns `{ ok: false }` and does not throw when
   `sendMail` itself throws (simulate with
   `sendMail.mockRejectedValueOnce(new Error('smtp down'))`).
5. `backupDueToday` returns `true` when there is no prior `backup.export`
   audit entry, and `false` immediately after `runBackupAndEmail` has
   logged one, and `true` again once the logged entry's `at` is more than
   24 hours in the past (insert a row into `audit_log` directly with a
   backdated `at` value to test this, rather than waiting).
6. Every entry in `runBackupAndEmail`'s outcome is written to `audit_log`
   with action `backup.export` (success) or `backup.export.failed`
   (exception) — assert this with `listAudit` from `auditService.js`.

### Acceptance criteria (verify by hand)

1. `npm run typecheck` and `npm run test` both pass from the repo root.
2. `npm run build` succeeds.
3. Start the server locally with SMTP configured against a test inbox
   (Mailtrap, or any real address you control) and `SEED_ON_BOOT=demo`.
   Sign in as the admin, go to Settings → Data, click "Export a backup
   now". Confirm an email arrives with a `.json` attachment, and that the
   attachment, opened in a text editor, contains a `tables` object with at
   least `members`, `rounds`, `tickets` as keys, each populated by the
   demo seed data.
4. Restart the server. Wait just over a minute (past one scheduler tick).
   Confirm in the server logs that the daily backup did **not** fire again
   (since one was just sent by hand) — the `backupDueToday` check should
   have suppressed it. Then manually backdate the latest `backup.export`
   audit row's `at` column by more than 24 hours (via a direct SQL
   `UPDATE`) and wait for the next tick; confirm a second backup email
   arrives automatically this time.
5. Confirm `render.yaml`'s `bis-db` plan is no longer `free` in the
   committed file, and that the Render dashboard (Part A) shows a paid
   plan with automated backups enabled.
6. Confirm the Guide page (Settings section, as a coordinator) mentions
   the backup.

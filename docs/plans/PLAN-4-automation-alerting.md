# PLAN 4 — Alert an admin when unattended automation gets permanently stuck

**Leverage rank: 4 of 5.**

## Why this is high-leverage

`docs/decisions.md` D6 describes this app's core operating model:

> The app runs the weekly cycle itself... create next week's round, fill it
> from the JIRA queue, roll over tickets that missed the minimum, open and
> distribute it, chase non-responders, close at the cut-off, finalise after
> a grace period, write the scores to JIRA and transition the ticket.

D6 also documents that a step which fails twice (`MAX_ATTEMPTS = 2` in
`server/src/services/automationService.ts`) stops retrying and "stays
claimed with its error on the round page" — deliberately, so a bad JIRA
token does not get retried forever.

Checked directly: when a step gets permanently stuck like this, the *only*
place it is visible is `console.error`/`console.log` in the server's
stdout (Render's log viewer), and the automation log table on that one
specific round's detail page — which nobody opens unless they already
suspect something is wrong. There is no banner, no email, no anything
else. `grep -rn "automation.*fail" web/src/pages/*.tsx` finds nothing.

This directly undermines the thing D6 is for. An app that runs itself
unattended and then fails unattended, with the failure visible only to
someone who happens to open exactly the right page, is not meaningfully
different from an app that silently stops working. A JIRA token expiring,
an SMTP credential being rotated, or a genuine bug in a future change could
each mean rounds stop being created, distributed, or finalised for weeks —
and the first anyone would know is a committee member asking why they
never got this week's tickets.

## Goal

1. **An email**, sent once per distinct failure, to every active admin,
   the first time an automation step becomes permanently stuck (has failed
   and used up its retries) — using the SMTP integration that already
   sends every other email this app sends, so no new external dependency.
2. **A banner**, visible to any signed-in admin on every page of the app,
   listing every round with an unresolved stuck step and linking straight
   to it, so an admin who does open the app cannot miss it even without
   reading the email.
3. Both clear themselves automatically once the step is retried
   successfully (by hand, via the round page's existing retry button) or
   the round is reopened — no separate "dismiss" action to remember.

## Exact files to touch

| File | Change |
|---|---|
| `server/src/services/automationService.ts` | Add `listStuckAutomationSteps` and `alertOnStuckFailures`. |
| `server/src/services/automationService.test.ts` or `automation.test.ts` | Add tests (check which file name already exists in `server/src/services/` and add to it — do not create a duplicate). |
| `server/src/routes/automation.ts` or `server/src/routes/rounds.ts` | Add `GET /api/automation/failures` (check which file already registers `/api/automation/run` and add the new route next to it, rather than guessing a new file). |
| `server/src/services/scheduler.ts` | Call `alertOnStuckFailures` once per tick. |
| `web/src/api.ts` | Add `api.automationFailures()` and its response type. |
| `web/src/App.tsx` | Fetch and render the banner. |
| `web/src/styles.css` | Style for the banner, if `.notice.warn` (already used elsewhere) is not sufficient on its own. |
| `web/src/pages/GuidePage.tsx` | One paragraph in the coordinator section. |

## Facts you must not get wrong

- **A step counts as "permanently stuck", not merely mid-retry**, only
  when its `outcome` in `round_automation_log` starts with the literal
  string `'Failed:'` **and** `attempts >= MAX_ATTEMPTS` (currently `2`).
  A step that has failed once and is still waiting out its 30-minute retry
  cooldown (`RETRY_COOLDOWN_MS` in the same file) is not yet stuck — do
  not alert on it, or every transient JIRA hiccup would fire an email.
  Read `claim()` in `server/src/services/automationService.ts` (around
  line 88) before writing the query — it is the only place that decides
  what "stuck" actually means, and this plan's query must agree with it
  exactly rather than re-deriving the rule independently.
- **The alert must be idempotent per actual failure occurrence, not per
  round+action forever.** `ran_at` in `round_automation_log` is updated by
  `claim()` on every genuine retry attempt (`UPDATE round_automation_log
  SET attempts = attempts + 1, ran_at = ?, ...`), so `round_id + action +
  ran_at` uniquely identifies one specific failure occurrence — a step
  that fails, gets manually retried, and fails again later has a new
  `ran_at` and is correctly treated as a new occurrence worth a fresh
  alert. Using only `round_id + action` as the dedupe key would be wrong:
  once alerted, a genuinely new failure on the same round and action,
  weeks later, would never be alerted on again.
- **Do not build a new table for alert history.** This app already has an
  append-only `audit_log` for exactly this kind of "did we already do this
  once" check (see how `backupService.ts` in PLAN-1 uses it, if that plan
  has already been done — the same pattern applies here). Record each sent
  alert as an `audit_log` row with `action = 'automation.failure.alerted'`
  and `entity_id = '<roundId>:<action>:<ranAt>'`; before sending, check
  whether that exact `entity_id` already has such a row.

## Step-by-step

**Step 1 — `listStuckAutomationSteps` in `automationService.ts`.**

Add near `listAutomationLog` (reuse its exact query style):

```ts
export interface StuckAutomationStep {
  roundId: string;
  weekLabel: string;
  action: string;
  outcome: string;
  detail: string;
  ranAt: string;
}

/**
 * Every automated step, across every round, that has failed and used up its
 * retries - `claim()`'s own definition of "not coming back on its own",
 * kept in one place so this never drifts from what actually decides whether
 * a step retries.
 */
export async function listStuckAutomationSteps(db: Db): Promise<StuckAutomationStep[]> {
  const rows = await db.all<{
    round_id: string;
    week_label: string;
    action: string;
    outcome: string;
    detail: string;
    ran_at: string;
  }>(
    `SELECT l.round_id, r.week_label, l.action, l.outcome, l.detail, l.ran_at
     FROM round_automation_log l
     JOIN rounds r ON r.id = l.round_id
     WHERE l.outcome LIKE 'Failed:%' AND l.attempts >= ?
     ORDER BY l.ran_at DESC`,
    [MAX_ATTEMPTS],
  );
  return rows.map((row) => ({
    roundId: row.round_id,
    weekLabel: row.week_label,
    action: row.action,
    outcome: row.outcome,
    detail: row.detail,
    ranAt: row.ran_at,
  }));
}
```

(`MAX_ATTEMPTS` is already a module-level constant in this file — reuse it
directly, do not redefine or hardcode `2` again.)

**Step 2 — `alertOnStuckFailures` in the same file.**

```ts
import { sendMail } from '../integrations/mail.js';
import { audit } from './auditService.js';
import { listMembers } from './memberService.js';

const AUTOMATION_ACTOR = { id: null, email: 'automation@bis' };

/**
 * Emails every active admin about a stuck step the first time it is seen,
 * and never again for that exact occurrence - see PLAN-4 in
 * docs/plans/ for why `roundId:action:ranAt` is the right key. Safe to call
 * on every scheduler tick: with nothing stuck, this is one cheap query.
 */
export async function alertOnStuckFailures(db: Db): Promise<void> {
  const stuck = await listStuckAutomationSteps(db);
  if (!stuck.length) return;

  for (const step of stuck) {
    const key = `${step.roundId}:${step.action}:${step.ranAt}`;
    const already = await db.get<{ id: string }>(
      `SELECT id FROM audit_log WHERE action = 'automation.failure.alerted' AND entity_id = ?`,
      [key],
    );
    if (already) continue;

    const admins = (await listMembers(db, false)).filter((m) => m.role === 'ADMIN');
    if (admins.length) {
      await sendMail({
        to: admins.map((a) => a.email),
        subject: `BIS automation stuck: ${step.weekLabel} — ${step.action}`,
        html: `<p><strong>${step.action}</strong> on <strong>${step.weekLabel}</strong> has failed and stopped retrying.</p>
<p>${step.outcome}</p>
<p>${step.detail ? `Detail: ${step.detail}</p><p>` : ''}Open the round to see the full automation log and retry the matching action by hand.</p>`,
      });
    }
    // Recorded even if there were no active admins to send to, so a stuck
    // step with nobody to tell does not get re-checked forever - the same
    // stuck step will still show on the in-app banner regardless.
    await audit(db, AUTOMATION_ACTOR, 'automation.failure.alerted', 'round', step.roundId, { key, action: step.action });
  }
}
```

**Edge case:** this function must never throw out of a scheduler tick.
Wrap its call site (Step 4) the same way `runDueAutomation` already is —
inside the existing `try`/`catch` in `tick()`, not a new unguarded call.

**Step 3 — the route.**

First, check `server/src/routes/rounds.ts` for where `POST
/automation/run` is already registered (search for `'/automation/run'`) —
add the new route immediately after it, in the same file, using the same
`requireCoordinator` middleware:

```ts
router.get(
  '/automation/failures',
  requireCoordinator,
  asyncHandler(async (_req, res) => {
    const db = await getDb();
    res.json({ failures: await listStuckAutomationSteps(db) });
  }),
);
```

Add `listStuckAutomationSteps` to that file's existing import from
`../services/automationService.js`.

**Step 4 — wire into the scheduler.**

In `server/src/services/scheduler.ts`, inside `tick()`'s existing `try`
block, after the `runDueAutomation` loop:

```ts
    await alertOnStuckFailures(db);
```

Add `alertOnStuckFailures` to the existing import from
`./automationService.js`. Unlike PLAN-1's backup check, this one belongs
**inside** the automation-gated part of the scheduler (it runs only when
`SCHEDULER_ENABLED` is true) — if the scheduler is off, no automated steps
are running at all, so there is nothing new to alert on.

**Step 5 — client API.**

In `web/src/api.ts`:

```ts
export interface StuckAutomationStep {
  roundId: string;
  weekLabel: string;
  action: string;
  outcome: string;
  detail: string;
  ranAt: string;
}

// alongside the other api methods:
automationFailures: () => request<{ failures: StuckAutomationStep[] }>('/api/automation/failures'),
```

**Step 6 — the banner in `App.tsx`.**

Read the current `App.tsx` first (it has changed shape several times this
session — do not assume line numbers). Add state and a fetch, gated on
`coordinator`, and render the banner inside `<main id="main">`, above
`<Routes .../>`:

```tsx
const [stuckSteps, setStuckSteps] = useState<StuckAutomationStep[]>([]);

useEffect(() => {
  if (!member || !isCoordinator(member.role)) return;
  api.automationFailures().then(({ failures }) => setStuckSteps(failures)).catch(() => {});
}, [member]);
```

(Import `type { StuckAutomationStep }` from `./api`.)

```tsx
<main id="main">
  {coordinator && stuckSteps.length ? (
    <div className="notice warn" role="alert" style={{ marginBottom: '1rem' }}>
      <strong>
        {stuckSteps.length === 1 ? 'One automated step is' : `${stuckSteps.length} automated steps are`} stuck and
        needs attention:
      </strong>
      <ul style={{ margin: '0.4rem 0 0' }}>
        {stuckSteps.map((step) => (
          <li key={`${step.roundId}-${step.action}-${step.ranAt}`}>
            <Link to={`/rounds/${step.roundId}`}>{step.weekLabel}</Link> — {step.action}: {step.outcome}
          </li>
        ))}
      </ul>
    </div>
  ) : null}
  <Routes path={path} member={member} coordinator={coordinator} scorer={scorer} />
</main>
```

**Edge case:** this `useEffect` fetches once per page load, not on a
timer. That is intentional and sufficient for this plan — the email
(Step 2) is the actual proactive alert; this banner exists for "an admin
who is already in the app should not be able to miss it," not as its own
polling mechanism. Do not add a `setInterval` here; it would add
complexity for no real benefit given the email already covers the
"nobody has the app open" case.

**Step 7 — Guide.**

One paragraph, coordinator section, near where automation is already
documented:

```
If an automated step fails twice, it stops retrying and stays that way
until it is retried by hand. You will get an email the first time this
happens, and a banner stays on every page until it is resolved.
```

## Tests

Add to the existing automation test file (check
`server/src/services/automation.test.ts` and
`server/src/services/automationCycle.test.ts` — read both first, and add
these to whichever already covers `claim`/retry behaviour, so the new
tests sit next to the logic they depend on):

1. `listStuckAutomationSteps` returns nothing when a step has failed once
   (`attempts = 1`) and nothing when there is no failure at all.
2. `listStuckAutomationSteps` returns a step once `attempts >= 2` and its
   outcome starts with `'Failed:'`.
3. `alertOnStuckFailures` sends exactly one email (mock `sendMail` the
   same way `writeBack.test.ts` does) the first time it is called with a
   stuck step present, and sends **no** email on a second call with the
   same step still stuck and unchanged — assert
   `sendMail).toHaveBeenCalledTimes(1)` across both calls together.
4. `alertOnStuckFailures` sends a **second** email if the same round and
   action fail again later with a different `ran_at` (simulate by
   inserting a second `round_automation_log` row update with a later
   `ran_at`, mirroring what a manual retry followed by a fresh failure
   would produce).
5. `alertOnStuckFailures` does not throw when there are no active admins.

## Acceptance criteria (verify by hand)

1. `npm run typecheck`, `npm run test`, `npm run build` all pass.
2. Locally, with SMTP configured against a test inbox: create a round,
   misconfigure something that makes a step fail twice in a row (the
   simplest reliable way — set `jira.businessScoreFieldId` to empty after
   finalising a round with automated write-back on, so the write-back step
   fails with a clear "No JIRA Business Score field id configured" error;
   trigger two ticks, or call `POST /api/automation/run` twice more than 30
   minutes apart, or reduce `RETRY_COOLDOWN_MS` temporarily while testing
   only — revert any such temporary change before finishing).
3. Confirm exactly one alert email arrives, addressed to every active
   admin.
4. Sign in as an admin in the browser. Confirm the banner appears on every
   page (not just the round's own page), names the round and the action,
   and its link opens that round's detail page.
5. Fix the misconfiguration and retry the step by hand from the round
   page. Confirm the banner disappears on the next page load and no
   further email arrives for that occurrence.

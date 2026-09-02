# PLAN 5 — Let a coordinator see what a JQL actually matches before relying on it

**Leverage rank: 5 of 5.**

## Why this is high-leverage

This is not a hypothetical risk — it already happened once, this session.
The Queue tab's hopper is defined by a JQL string in Settings
(`queue.hopperJql`), and the very first version of its default value only
listed two of the four statuses a real ticket can actually be in:

> "Rdy FE Dev" and "Rdy BE Dev" — but a ticket needing *both* kinds of work
> carries a different status entirely ("Rdy Development" / "Ready For
> Development"), which the JQL didn't select at all. That ticket did not
> land in the wrong queue. It silently vanished from the hopper — nothing
> on screen said anything was missing, because there was nothing to
> compare against.

That bug was only caught because the person who configured it happened to
already know, from a completely separate tool, exactly which ticket should
have appeared and noticed it did not. The next time this JQL is wrong —
after a JIRA workflow is renamed, after a new status is added for a new
kind of work, after a typo in Settings — there is no reason to expect
anyone will notice as quickly, because there is currently no way to see
what a JQL matches without first switching the whole feature on and
comparing its output against memory.

This plan adds a "Preview" action next to the JQL field: type or edit it,
click Preview, and see the actual tickets it currently matches — key,
status, and whether each one has a business score and an effort value — a
live answer, not a re-derived config change. Ranked lowest of the five not
because it matters less than the others, but because its blast radius is
narrower (it protects one feature, where the other four protect the whole
application's data, safety net, and unattended operation) — do the other
four first.

## Goal

In Settings, next to the Queue section's JQL field:

1. A "Preview this JQL" button that runs the **exact text currently in the
   field** (not the last-saved value) against JIRA and shows every ticket
   it matches, with its status, business score (or "—" if missing) and
   both effort values.
2. A summary line: how many tickets matched, how many have a business
   score, and — of those — how many would land in each queue and how many
   would land in neither (no effort on either side).
3. This works whether or not `queue.enabled` is currently `true` — the
   entire point is testing before switching it on, or after changing it,
   without waiting for a save.

## Exact files to touch

| File | Change |
|---|---|
| `server/src/routes/queue.ts` | Add `POST /api/queue/preview`. |
| `web/src/api.ts` | Add `api.previewQueueJql()` and its response type. |
| `web/src/pages/SettingsPage.tsx` | Add the preview button, state, and result table to the existing "The queue" section. |
| `web/src/styles.css` | Reuse existing table/notice classes — check first whether any new class is genuinely needed before adding one. |
| `web/src/pages/GuidePage.tsx` | One sentence, in the paragraph that already explains the queue's JQL. |

## Facts you must not get wrong

- **`searchHopper` already exists and already does exactly the fetch this
  plan needs** (`server/src/integrations/jira.ts`). Do not write a new
  JIRA search function. Its signature is:

  ```ts
  export async function searchHopper(
    jql: string,
    fieldIds: { businessScoreFieldId: string; backendFieldId: string; frontendFieldId: string },
  ): Promise<HopperIssue[]>
  ```

  where `HopperIssue` is `{ key, summary, status, businessScore:
  number | null, frontendEffort: number, backendEffort: number }`. The new
  route in this plan is a thin wrapper that calls this with an ad-hoc
  `jql` from the request body instead of the saved
  `config.queue.hopperJql` — the field ids still come from saved config
  (`config.jira.businessScoreFieldId`,
  `config.scoring.effort.backendFieldId`,
  `config.scoring.effort.frontendFieldId`), since those are a different,
  already-solved problem (Settings already has "Resolve field ids from
  JIRA" for them) and are not what this plan is about.
- **This must work regardless of `queue.enabled`.** Do not import or reuse
  `getQueueView` from `queueService.ts` for this — that function
  deliberately refuses to do anything when the queue is switched off
  (`if (!config.queue.enabled) return unavailable('DISABLED');`), which is
  correct for the tab everyone sees but wrong here, since previewing
  before switching it on is the entire purpose of this plan. Call
  `jira.searchHopper` directly in the new route instead.
- **This is read-only against JIRA and must never write anything.** Do not
  let it call `writeBusinessScore` or `transitionIssue` — it only reads.
- **If JIRA is not configured at all**, `searchHopper` (via the shared
  `jiraFetch` helper) throws `JiraNotConfiguredError`, which
  `server/src/routes/helpers.ts`'s `errorHandler` already converts to a
  clean `503` with a readable message — no special handling is needed in
  the new route for this case, but do confirm it (see acceptance criteria)
  rather than assuming.
- **A malformed JQL string** is rejected by JIRA's own API with a `400`,
  which `jiraFetch` turns into a thrown `JiraApiError`, which
  `errorHandler` converts to a `502` with JIRA's own error text. This is
  actually the single most useful case this whole plan exists for — a
  typo'd JQL should show the coordinator JIRA's own complaint about it,
  not a blank result that looks like "zero tickets currently qualify."
  Confirm this specific case works during verification; do not treat a
  `502` from this endpoint as a bug to swallow silently on the client.

## Step-by-step

**Step 1 — the route.**

In `server/src/routes/queue.ts` (read the existing file first — it
currently has one route, `GET /queue`; add the new one in the same file,
same style):

```ts
import { z } from 'zod';
import { getAppConfig } from '../services/configService.js';
import { searchHopper } from '../integrations/jira.js';

// alongside the existing router.get('/queue', ...):

const previewSchema = z.object({ jql: z.string().min(1) });

/**
 * Read-only: shows exactly what a JQL currently matches, without saving it
 * or requiring the queue to be switched on first. Exists because the
 * hopper JQL silently dropping a ticket is invisible until this exists -
 * see PLAN-5 in docs/plans/.
 */
router.post(
  '/queue/preview',
  requireCoordinator,
  asyncHandler(async (req, res) => {
    const { jql } = previewSchema.parse(req.body ?? {});
    const config = await getAppConfig(await getDb());
    const issues = await searchHopper(jql, {
      businessScoreFieldId: config.jira.businessScoreFieldId,
      backendFieldId: config.scoring.effort.backendFieldId,
      frontendFieldId: config.scoring.effort.frontendFieldId,
    });
    res.json({ issues });
  }),
);
```

Check the top of the existing `queue.ts` for which middleware (`requireAuth`
vs `requireCoordinator`) and helper imports are already present — the
existing `GET /queue` route uses `requireAuth` because every signed-in
member can see the queue tab, but **this new route must use
`requireCoordinator`** instead: it is a Settings tool for whoever configures
the JQL, not something every committee member needs, and it is one more
live JIRA API call each time it is pressed — no reason to expose that more
broadly than necessary.

**Step 2 — client API.**

In `web/src/api.ts`:

```ts
export interface QueuePreviewIssue {
  key: string;
  summary: string;
  status: string;
  businessScore: number | null;
  frontendEffort: number;
  backendEffort: number;
}

// alongside the other api methods:
previewQueueJql: (jql: string) =>
  request<{ issues: QueuePreviewIssue[] }>('/api/queue/preview', {
    method: 'POST',
    body: JSON.stringify({ jql }),
  }),
```

**Step 3 — Settings UI.**

Read the existing "The queue" section in `web/src/pages/SettingsPage.tsx`
first (added in an earlier piece of work — it has a `hopperJql` text input
inside a `<form>` with a `queueEnabled` checkbox). Add preview state near
the top of the component, alongside `cadenceForm` and the other
`useState` calls already there:

```ts
const [hopperJqlPreview, setHopperJqlPreview] = useState('');
const [previewResults, setPreviewResults] = useState<QueuePreviewIssue[] | null>(null);
const [previewing, setPreviewing] = useState(false);
const [previewError, setPreviewError] = useState('');
```

Initialise `hopperJqlPreview` from the saved config the same way
`cadenceForm` is initialised, in a `useEffect`:

```ts
useEffect(() => {
  if (config) setHopperJqlPreview(config.queue.hopperJql);
}, [config]);
```

**Critically:** the existing `hopperJql` text `<input>` in the queue
section currently uses `defaultValue={config.queue.hopperJql}` (an
uncontrolled input, read only via `FormData` on submit) — this is fine for
saving, but the preview needs to know what is currently *typed*, live.
Change that one input from `defaultValue` to a controlled pattern:

```tsx
<input
  id="hopperJql"
  name="hopperJql"
  type="text"
  value={hopperJqlPreview}
  onChange={(e) => setHopperJqlPreview(e.target.value)}
/>
```

The existing form's `onSubmit` reads this field via
`String(form.get('hopperJql'))` from a `FormData` — a controlled `<input>`
with `name="hopperJql"` still participates in `FormData` normally, so
**no change is needed to the save logic**, only to how the input's value
is sourced. Verify this assumption by re-reading the exact `onSubmit`
handler for this form before changing anything — do not guess.

Add the preview button and results directly below the `hopperJql` field,
still inside the same `<div className="field">`:

```tsx
<div className="row" style={{ marginTop: '0.5rem' }}>
  <button
    type="button"
    className="secondary"
    disabled={previewing || !hopperJqlPreview.trim()}
    onClick={async () => {
      setPreviewing(true);
      setPreviewError('');
      setPreviewResults(null);
      try {
        const { issues } = await api.previewQueueJql(hopperJqlPreview);
        setPreviewResults(issues);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : 'Could not preview this JQL');
      } finally {
        setPreviewing(false);
      }
    }}
  >
    {previewing ? 'Checking…' : 'Preview this JQL'}
  </button>
  <span className="hint">Runs against JIRA now, without saving anything.</span>
</div>

{previewError ? <p className="status error">{previewError}</p> : null}

{previewResults ? (
  <div style={{ marginTop: '0.6rem' }}>
    {previewResults.length === 0 ? (
      <p className="hint">Matches nothing right now. If you expected tickets here, check the statuses and project key.</p>
    ) : (
      <>
        {(() => {
          const scored = previewResults.filter((i) => i.businessScore !== null);
          const frontend = scored.filter((i) => i.frontendEffort > 0).length;
          const backend = scored.filter((i) => i.backendEffort > 0).length;
          const neither = scored.filter((i) => i.frontendEffort <= 0 && i.backendEffort <= 0).length;
          return (
            <p className="hint">
              {previewResults.length} matched, {scored.length} with a business score — {frontend} would be in the
              Frontend queue, {backend} in the Backend queue, {neither} in neither.
            </p>
          );
        })()}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Score</th>
                <th scope="col" className="num">FE</th>
                <th scope="col" className="num">BE</th>
              </tr>
            </thead>
            <tbody>
              {previewResults.map((issue) => (
                <tr key={issue.key}>
                  <th scope="row" className="plain">
                    <span className="jira-id">{issue.key}</span> {issue.summary}
                  </th>
                  <td>{issue.status}</td>
                  <td className="num">{issue.businessScore ?? '—'}</td>
                  <td className="num">{issue.frontendEffort}</td>
                  <td className="num">{issue.backendEffort}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    )}
  </div>
) : null}
```

**Edge case:** `th.plain` — check `web/src/styles.css` / other tables in
this same file for the exact class already used to make a row-header `th`
render like a normal left-aligned cell instead of the bold-uppercase
default `th` styling (used elsewhere in this file and in
`RoundDetailPage.tsx`'s write-back table) — reuse that exact class name,
do not invent a new one.

**Step 4 — Guide.**

In the existing paragraph explaining the queue's JQL requirement
(`web/src/pages/GuidePage.tsx`, added alongside the Queue tab
documentation), add one sentence:

```
"Preview this JQL" in Settings shows exactly which tickets it currently
matches, before you save it or switch the tab on - use it whenever a
workflow status changes.
```

## Tests

No new server-side test file is strictly required — `searchHopper` itself
is exercised indirectly by the existing queue tests once PLAN-3's
`queue.spec.ts` (if built) or manual verification calls the new route. If
adding a unit test, add it to wherever `jira.ts`'s existing behaviour is
tested (check whether one already exists before creating a new file) and
cover: the route returns `searchHopper`'s result verbatim for a valid JQL,
and returns a `503` when JIRA is not configured (mock `env.jira.configured
= false` the same way other tests in this codebase mock `env`).

## Acceptance criteria (verify by hand)

1. `npm run typecheck`, `npm run test`, `npm run build` all pass.
2. Without JIRA configured (`JIRA_BASE_URL` unset), click "Preview this
   JQL" in Settings. Confirm a clear error appears
   ("JIRA is not configured...") rather than a blank result or a raw
   stack trace.
3. With a local JIRA stub or real JIRA credentials configured, type a
   deliberately malformed JQL (e.g. unbalanced quotes) and click preview.
   Confirm JIRA's own error message is shown to the coordinator, not a
   generic "something went wrong".
4. Type a valid JQL that matches several tickets, at least one with no
   business score and at least one with effort on only one side. Click
   preview. Confirm: the summary counts are correct, the table lists every
   matched ticket with its real status, and a ticket with no business
   score shows "—" rather than `0` or `null`.
5. Change the JQL text without clicking "Save the queue settings" — reload
   the page — confirm the unsaved change did **not** persist (the field
   shows the previously saved value again), proving the preview genuinely
   operates on unsaved text and never silently saves anything on its own.
6. Reproduce the original bug this plan targets: preview a JQL that omits
   a status a real ticket is actually in (e.g. remove "Rdy Development"
   from an otherwise-correct list while a ticket sits in that exact
   status). Confirm that ticket is absent from the preview results —
   proving this tool would have caught the original bug before it ever
   reached the committee.

# PLAN 3 — A persisted Playwright e2e suite, wired into CI

**Leverage rank: 3 of 5. Depends on PLAN-2 (CI) already being done — if
`.github/workflows/ci.yml` does not exist yet, do PLAN-2 first.**

## Why this is high-leverage

Search the repo: there is no `e2e/` directory, no `playwright.config.ts`,
no `@playwright/test` dependency anywhere in `package.json`,
`server/package.json` or `web/package.json`. There is no web-side test of
any kind — `find web/src -iname "*.test.*"` returns nothing. The only
frontend/integration testing that exists is the server's Vitest suite
(pure domain logic and service-layer tests, no browser, no UI).

Every UI-level verification of this application — sign-in, scoring a
round, the progress rail, the write-back flow, the queue rankings — has
been done by hand, repeatedly, using throwaway Playwright scripts written
fresh and deleted after each check. That approach has already caught real
bugs (a scroll target hidden behind a sticky nav bar, a write-back button
that silently did nothing, a queue ranking bug from a missing JIRA status)
— which proves the UI genuinely needs this kind of testing, and that a
person clicking through it by memory is not reliable enough to catch
everything on its own. None of those checks are saved anywhere. The exact
same class of bug can be silently reintroduced next month and nothing
would catch it before a real user does.

This plan turns that one-off manual practice into a permanent, repeatable
suite that runs on every push.

## Goal

1. A new `e2e` npm workspace containing Playwright tests for five golden
   paths:
   - Signing in (both as an admin and as a committee member).
   - A committee member scoring every ticket in a round, using the
     progress rail and the "jump to next unscored" button, seeing the
     completion panel.
   - An admin running a round through its full lifecycle by hand: create,
     add a ticket, open, close, finalise, and confirm the anonymised
     feedback view shows data.
   - JIRA write-back's three-state flow: skipped for too few responses →
     written after an explicit override → skipped again as "already
     written" → force re-written. (Uses a local stub HTTP server standing
     in for JIRA — there is no real JIRA in CI.)
   - The Queue tab: ranking, ties, the "Where's my ticket?" lookup.
2. A `playwright.config.ts` that starts the built app (and the JIRA stub,
   for the tests that need it) automatically, against a disposable SQLite
   database, so the whole suite runs with one command and no manual setup.
3. A new job in `.github/workflows/ci.yml` that installs a browser and
   runs this suite on every push and pull request, alongside the existing
   typecheck/test/build job.

## Exact files to touch

| File | Change |
|---|---|
| `package.json` (root) | Add `"e2e"` to `workspaces`; add an `"e2e"` script. |
| `e2e/package.json` | **New file.** |
| `e2e/playwright.config.ts` | **New file.** |
| `e2e/scripts/start-app.sh` | **New file.** Resets the disposable DB and starts the built server. |
| `e2e/fixtures/jira-stub.ts` | **New file.** A minimal fake JIRA HTTP server. |
| `e2e/tests/auth.setup.ts` | **New file.** Signs in once per role, saves session state. |
| `e2e/tests/scoring.spec.ts` | **New file.** |
| `e2e/tests/round-lifecycle.spec.ts` | **New file.** |
| `e2e/tests/writeback.spec.ts` | **New file.** |
| `e2e/tests/queue.spec.ts` | **New file.** |
| `.github/workflows/ci.yml` | Add an `e2e` job. |
| `.gitignore` | Add `e2e/.auth/`, `e2e/.tmp/`, `e2e/playwright-report/`, `e2e/test-results/`. |

## Facts you must not get wrong (read before writing any code)

These are the exact conventions this app already uses, taken directly from
the source — do not guess at any of them.

- **The server can serve the whole app from one origin.** In
  `server/src/index.ts`, if `web/dist` exists on disk, the server serves it
  as static files and falls back to `index.html` for any non-API route.
  This means the e2e suite does **not** need a separate Vite dev server or
  `API_ORIGIN` — build both workspaces first, start the server alone, and
  Playwright drives that single port. This is simpler and closer to
  production than the two-server setup used for manual testing during
  development.
- **Environment variables that configure a throwaway instance** (all read
  in `server/src/config/env.ts`):
  - `DB_DRIVER=sqlite`
  - `SQLITE_FILE=<path>` — an absolute path to a scratch `.db` file.
  - `AUTH_MODE=email` — the name/email picker, not Entra SSO.
  - `SEED_ON_BOOT=demo` — seeds one demo round with real-looking tickets.
    **Important:** the demo seed pre-scores every default committee member
    on the seeded round. Any test that needs an *unscored* ticket must add
    a brand-new committee member first (`POST /api/members`) and use that
    member — do not assume any seeded member has anything left to score.
  - `BOOTSTRAP_ADMIN_EMAIL=<email>` — creates that address as an `ADMIN` on
    first boot.
  - `PORT=<port>`
  - `PUBLIC_WEB_ORIGIN=http://localhost:<port>`
  - `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` — point these at the
    local stub server (see below), not real JIRA.
- **Sign-in is a click, not a form, for an existing member.** In
  `AUTH_MODE=email`, the login page (`web/src/pages/LoginPage.tsx`) shows a
  list of existing members as clickable rows, each rendering the member's
  name immediately followed by their team with no space between them (two
  adjacent `<span>` elements) — e.g. a member named "Fix Tester" on team
  "QA" renders as the text `Fix TesterQA`. To sign in as a specific member
  in a test, locate that concatenated text and click it:
  `page.getByText('Fix TesterQA', { exact: false }).click()`. The bootstrap
  admin appears in the same list under their email address, e.g.
  `page.getByText('e2e-admin@example.com', { exact: false }).click()`.
- **`/auth` is rate-limited to 20 requests per rolling 60-second window**
  (`server/src/index.ts`: `rateLimit({ windowMs: 60_000, max: 20 })`
  applied to the whole `/auth` router). **Do not sign in inside every
  test.** Use Playwright's `storageState` pattern: sign in exactly once
  per role in `auth.setup.ts`, save the authenticated cookie state to a
  file, and have every other test start already signed in by loading that
  state. This is not an optimisation here, it is a correctness
  requirement — a suite that re-signs-in per test will eventually start
  failing intermittently in CI as the suite grows, for a reason that will
  look nothing like what actually caused it.
- **A member is created via `POST /api/members`** with a JSON body of
  `{ name, email, team, role, active }` (`role` is `'ADMIN'` or
  `'COMMITTEE'`) — this is an admin-only route, call it using the admin's
  authenticated `page.request` context, not the public sign-up flow.
- **A round's ticket is scored via `PUT
  /api/rounds/:roundId/tickets/:ticketId/submission`** with a body of
  `{ relevance: 'YES', scores: { <categoryId>: <n>, ... } }`. Category ids
  for the currently active categories come from `GET /api/scoring-model`,
  whose response includes a `categories` array of `{ id, scaleMin,
  scaleMax, ... }`.
- **The scoring UI's number buttons** are `button` elements with class
  `score-btn` inside a `.score-buttons` container — one container per
  category, in category order, on each ticket card. To click "5" for the
  first category on the first ticket on the page:
  `page.locator('.score-buttons').first().getByRole('button', { name: '5', exact: true }).click()`.
- **A ticket's card heading has the DOM id `ticket-<ticketId>`.** The
  progress rail's per-ticket badges have class `progress-badge` (and
  `progress-badge done` once scored); the "jump to next unscored" button's
  accessible name matches `/Jump to next unscored/`.
- **The completion panel**, shown once every ticket in a round is scored,
  has class `round-done`.
- **A round moves through its lifecycle via these admin routes** (all
  under `/api`, all requiring the admin's authenticated request context):
  - `POST /rounds` with `{ weekLabel, cutOffAt }` creates a `DRAFT` round.
  - `POST /rounds/:id/tickets` with `{ ticketId }` (singular — **not**
    `ticketIds`, and only one ticket per call) adds a ticket to it.
  - `POST /rounds/:id/status` with `{ status: 'OPEN' | 'CLOSED' }` moves
    it.
  - `POST /rounds/:id/finalise` with `{}` finalises it.
  - `GET /tickets` lists tickets already known to the app (the demo seed
    creates several) — reuse one of these rather than importing from JIRA
    in a test, to avoid depending on the JIRA stub for tests that are not
    specifically about JIRA.
- **The write-back UI** lives on the round detail page
  (`/rounds/:id`) once a round is `FINALISED`. The "Write scores to JIRA"
  button has that exact accessible name. The results table that appears
  afterward has one row per ticket with a `Result` badge reading
  "Written", "Skipped" or "Failed", and a `Why` cell with the reason.
  Two conditional override buttons can appear below the table:
  "Write the skipped scores anyway" (only when a skip is genuinely due to
  too few responses) and "Force re-write" (only when a skip is because the
  same score was already written). Clicking either triggers a
  `window.confirm()` dialog — handle it with
  `page.once('dialog', (d) => d.accept())` **before** clicking the button,
  not after.
- **The Queue tab** (`/queue`) needs `queue.enabled = true` and
  `jira.businessScoreFieldId` / `scoring.effort.backendFieldId` /
  `scoring.effort.frontendFieldId` all set in config before it shows
  anything — set these via `PUT /api/config/queue` and
  `PUT /api/config/jira` / `PUT /api/config/scoring` from the admin
  context before visiting the page. The lookup input has id
  `ticket-lookup`; its submit button's accessible name is "Look up".

## Step-by-step

### Step 1 — Root workspace and scripts

In the root `package.json`, change:

```json
"workspaces": ["server", "web"]
```

to:

```json
"workspaces": ["server", "web", "e2e"]
```

and add one script alongside the existing ones:

```json
"e2e": "npm run build --workspace server && npm run build --workspace web && npm run test --workspace e2e"
```

### Step 2 — `e2e/package.json`

```json
{
  "name": "@bis/e2e",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0"
  }
}
```

Then from the repo root, run `npm install` once (not `npm ci` — this is
the step that actually adds the new dependency to the lockfile).

### Step 3 — `e2e/scripts/start-app.sh`

This resets the scratch database on every run, so tests never see
leftover state from a previous run, and starts the built server. Make it
executable (`chmod +x e2e/scripts/start-app.sh`).

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DB_FILE="e2e/.tmp/e2e.db"
mkdir -p e2e/.tmp
rm -f "$DB_FILE" "$DB_FILE-shm" "$DB_FILE-wal"

export DB_DRIVER=sqlite
export SQLITE_FILE="$DB_FILE"
export AUTH_MODE=email
export SEED_ON_BOOT=demo
export BOOTSTRAP_ADMIN_EMAIL="e2e-admin@example.com"
export PORT=4400
export PUBLIC_WEB_ORIGIN="http://localhost:4400"
export JIRA_BASE_URL="http://localhost:4610"
export JIRA_EMAIL="stub@example.com"
export JIRA_API_TOKEN="stub-token"

exec node server/dist/index.js
```

**Edge case:** the `cd` at the top resolves paths relative to the script's
own location so this works whether Playwright invokes it from the repo
root or from `e2e/` — do not hardcode an absolute path.

### Step 4 — `e2e/fixtures/jira-stub.ts`

A minimal fake JIRA that answers exactly the requests this app makes,
closely modelled on the throwaway stubs used for manual verification
earlier in this project's history — but persisted, and returning data the
write-back and queue tests actually need.

```ts
import { createServer, type Server } from 'node:http';

interface StubIssue {
  key: string;
  fields: Record<string, unknown>;
}

/**
 * Stands in for JIRA Cloud for the write-back and queue tests. Answers only
 * the endpoints this app actually calls: field discovery, the paginated
 * search used by the queue, business-score writes, and transitions. Nothing
 * here needs to be a faithful JIRA clone - it needs to be enough for this
 * app's own client code to complete a full round trip.
 */
export function startJiraStub(port: number, issues: StubIssue[] = []): Server {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');

      if (req.url === '/rest/api/3/field' && req.method === 'GET') {
        res.end(
          JSON.stringify([
            { id: 'customfield_101', name: 'Business Score', custom: true },
            { id: 'customfield_102', name: 'Backend Poker Score', custom: true },
            { id: 'customfield_103', name: 'Frontend Poker Score', custom: true },
          ]),
        );
        return;
      }

      if (req.url === '/rest/api/3/search/jql' && req.method === 'POST') {
        res.end(JSON.stringify({ issues, isLast: true }));
        return;
      }

      if (req.url?.includes('/transitions') && req.method === 'GET') {
        res.end(JSON.stringify({ transitions: [{ id: '1', name: 'Rdy Estimation' }] }));
        return;
      }

      // Business-score writes, transitions, and anything else this app PUTs
      // or POSTs to a specific issue - a bare 200 with an empty body is a
      // valid, successful JIRA response for all of these.
      res.end(JSON.stringify({}));
    });
  });
  server.listen(port);
  return server;
}
```

### Step 5 — `e2e/playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 4400;
const BASE_URL = `http://localhost:${APP_PORT}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bash scripts/start-app.sh',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
```

**Edge case:** `reuseExistingServer: !process.env.CI` means a developer
running the suite locally with the server already up (from `npm run dev`)
does not get a second instance started against it — but in CI it is always
started fresh. This mirrors the project's existing convention of always
starting clean scratch instances for verification.

The JIRA stub is **not** started by `webServer` — it is started and
stopped inside the two spec files that need it (`writeback.spec.ts`,
`queue.spec.ts`), in their own `test.beforeAll` / `test.afterAll`, so tests
that do not touch JIRA never pay for it and never depend on it.

### Step 6 — `e2e/tests/auth.setup.ts`

```ts
import { test as setup } from '@playwright/test';

const ADMIN_FILE = 'e2e/.auth/admin.json';
const MEMBER_FILE = 'e2e/.auth/member.json';

setup('sign in as admin', async ({ page }) => {
  await page.goto('/');
  await page.getByText('e2e-admin@example.com', { exact: false }).click();
  await page.waitForURL('**/');
  await page.context().storageState({ path: ADMIN_FILE });
});

setup('create and sign in as a committee member', async ({ browser }) => {
  // A fresh member for every run, via the admin's own session, so this
  // suite never depends on a specific person already existing in the demo
  // seed - and never collides with the demo seed's own pre-scored members.
  const adminContext = await browser.newContext({ storageState: ADMIN_FILE });
  const adminPage = await adminContext.newPage();
  await adminPage.request.post('/api/members', {
    data: { name: 'E2E Member', email: 'e2e-member@example.com', team: 'QA', role: 'COMMITTEE', active: true },
  });
  await adminContext.close();

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await memberPage.goto('/');
  await memberPage.getByText('E2E MemberQA', { exact: false }).click();
  await memberPage.waitForURL('**/');
  await memberContext.storageState({ path: MEMBER_FILE });
  await memberContext.close();
});
```

**Edge case:** the second `setup()` call creates its own context for the
admin API call rather than reusing a `page` fixture with `storageState`
already loaded implicitly, because the `chromium` project (which loads
`storageState` per-project, see below) does not apply inside a `setup`
project test unless a context is explicitly created with it — being
explicit here avoids a subtle "works by accident" dependency on project
configuration order.

Every other spec file must declare which saved session it wants at the top
of the file:

```ts
test.use({ storageState: 'e2e/.auth/admin.json' }); // or member.json
```

### Step 7 — `e2e/tests/scoring.spec.ts`

Covers: a committee member scoring every ticket in the demo round using
the progress rail, the jump-to-next-unscored button, and reaching the
completion panel.

```ts
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/member.json' });

test('scores every ticket in the open round and reaches the completion panel', async ({ page }) => {
  await page.goto('/score');
  const ticketCount = await page.locator('.ticket-card').count();
  expect(ticketCount).toBeGreaterThan(0);

  // Jump to the first unscored ticket via the rail, confirm the heading
  // lands clear of the sticky rail rather than hidden underneath it.
  const jumpButton = page.getByRole('button', { name: /Jump to next unscored/ });
  if (await jumpButton.count()) {
    await jumpButton.click();
    const { railBottom, headingTop } = await page.evaluate(() => {
      const rail = document.querySelector('.progress-rail')!;
      const heading = [...document.querySelectorAll('h3[id^="ticket-"]')].reduce((best, h) => {
        const top = h.getBoundingClientRect().top;
        return !best || Math.abs(top) < Math.abs(best.top) ? { top } : best;
      }, null as { top: number } | null)!;
      return { railBottom: rail.getBoundingClientRect().bottom, headingTop: heading.top };
    });
    expect(headingTop).toBeGreaterThanOrEqual(railBottom - 2);
  }

  const model = await (await page.request.get('/api/scoring-model')).json();
  const categoryIds: string[] = model.categories.map((c: { id: string }) => c.id);

  for (let i = 0; i < ticketCount; i += 1) {
    const submit = page.getByRole('button', { name: 'Submit my score' }).first();
    if (!(await submit.count())) break;
    for (let c = 0; c < categoryIds.length; c += 1) {
      await page.locator('.score-buttons').nth(c).getByRole('button', { name: '5', exact: true }).click();
    }
    await submit.click();
    await page.waitForTimeout(300);
  }

  await expect(page.locator('.round-done')).toBeVisible();
});
```

**Edge case:** this test uses `page.locator('.score-buttons').nth(c)` on
the **first visible ticket card**, scoring whichever ticket the loop's
current submit button belongs to — after each submission the just-scored
ticket's form becomes read-only and the *next* ticket's `.score-buttons`
groups become the first ones still interactive, but Playwright's `.nth(c)`
always counts from the top of the whole page, across every ticket. Because
already-submitted forms render their categories as disabled `<fieldset>`
content rather than being removed from the DOM, `.score-buttons` groups
from already-scored tickets **remain in the DOM** ahead of the current
one. A weaker model copying this pattern naively across multiple tickets
will click the wrong ticket's (disabled) buttons. **The safe pattern**,
already proven in this project's own manual verification scripts, is
different from what is written above and must be corrected before use:
scope every `.score-buttons` lookup to the specific ticket card that
contains the current `submit` button, e.g.:

```ts
const card = submit.locator('xpath=ancestor::article[contains(@class, "ticket-card")]');
const groups = card.locator('.score-buttons');
const groupCount = await groups.count();
for (let c = 0; c < groupCount; c += 1) {
  await groups.nth(c).getByRole('button', { name: '5', exact: true }).click();
}
```

Use this corrected version, not the simplified one above — it is included
in the earlier snippet only to show what the plan means and why the fix is
necessary; write the final test file with the `card`/`groups` scoping.

### Step 8 — `e2e/tests/round-lifecycle.spec.ts`

```ts
import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('a round moves from draft through to a readable feedback view', async ({ page }) => {
  const tickets = (await (await page.request.get('/api/tickets')).json()).tickets;
  expect(tickets.length).toBeGreaterThan(0);

  const created = await page.request.post('/api/rounds', {
    data: { weekLabel: 'E2E lifecycle round', cutOffAt: '2099-01-01T00:00:00.000Z' },
  });
  const round = (await created.json()).round;

  await page.request.post(`/api/rounds/${round.id}/tickets`, { data: { ticketId: tickets[0].id } });
  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'OPEN' } });
  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'CLOSED' } });
  await page.request.post(`/api/rounds/${round.id}/finalise`, { data: {} });

  await page.goto(`/feedback/${round.id}`);
  await expect(page.getByRole('heading', { name: /How the committee scored/ })).toBeVisible();
});
```

### Step 9 — `e2e/tests/writeback.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import { startJiraStub } from '../fixtures/jira-stub.js';
import type { Server } from 'node:http';

test.use({ storageState: 'e2e/.auth/admin.json' });

let stub: Server;
test.beforeAll(() => {
  stub = startJiraStub(4610);
});
test.afterAll(() => {
  stub.close();
});

test('below-minimum skip, override, already-written skip, then force re-write', async ({ page }) => {
  const cfg = (await (await page.request.get('/api/config')).json()).config;
  await page.request.put('/api/config/jira', {
    data: { ...cfg.jira, businessScoreFieldId: 'customfield_101', transitionOnFinalise: true, transitionName: 'Rdy Estimation' },
  });
  await page.request.put('/api/config/scoring', { data: { ...cfg.scoring, minSubmissions: 2 } });

  const tickets = (await (await page.request.get('/api/tickets')).json()).tickets;
  const created = await page.request.post('/api/rounds', {
    data: { weekLabel: 'E2E write-back round', cutOffAt: '2099-01-01T00:00:00.000Z' },
  });
  const round = (await created.json()).round;
  await page.request.post(`/api/rounds/${round.id}/tickets`, { data: { ticketId: tickets[0].id } });
  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'OPEN' } });

  const model = await (await page.request.get('/api/scoring-model')).json();
  const scores = Object.fromEntries(model.categories.map((c: { id: string }) => [c.id, 5]));
  await page.request.put(`/api/rounds/${round.id}/tickets/${tickets[0].id}/submission`, {
    data: { relevance: 'YES', scores },
  });

  await page.request.post(`/api/rounds/${round.id}/status`, { data: { status: 'CLOSED' } });
  await page.request.post(`/api/rounds/${round.id}/finalise`, { data: {} });

  await page.goto(`/rounds/${round.id}`);

  await page.getByRole('button', { name: 'Write scores to JIRA' }).click();
  await expect(page.getByRole('button', { name: 'Write the skipped scores anyway' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Force re-write' })).toHaveCount(0);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Write the skipped scores anyway' }).click();
  await expect(page.locator('table tbody tr td .badge').first()).toHaveText('Written');

  await page.getByRole('button', { name: 'Write scores to JIRA' }).click();
  await expect(page.getByRole('button', { name: 'Force re-write' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write the skipped scores anyway' })).toHaveCount(0);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Force re-write' }).click();
  await expect(page.locator('table tbody tr td .badge').first()).toHaveText('Written');
});
```

**Edge case:** the `page.once('dialog', ...)` handler must be attached
**before** the click that triggers `window.confirm()` — Playwright's
dialog listener has to be registered before the dialog fires, or the
dialog stays open and the click's `await` never resolves, hanging the
test until it times out.

### Step 10 — `e2e/tests/queue.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import { startJiraStub } from '../fixtures/jira-stub.js';
import type { Server } from 'node:http';

test.use({ storageState: 'e2e/.auth/admin.json' });

let stub: Server;
test.beforeAll(() => {
  stub = startJiraStub(4610, [
    { key: 'ECOM-9001', fields: { summary: 'Stub ticket one', status: { name: 'Rdy FE Dev' }, customfield_101: 60, customfield_103: 3, customfield_102: 0 } },
    { key: 'ECOM-9002', fields: { summary: 'Stub ticket two', status: { name: 'Rdy BE Dev' }, customfield_101: 40, customfield_103: 0, customfield_102: 2 } },
  ]);
});
test.afterAll(() => {
  stub.close();
});

test('ranks the hopper and finds a ticket by key', async ({ page }) => {
  const cfg = (await (await page.request.get('/api/config')).json()).config;
  await page.request.put('/api/config/jira', { data: { ...cfg.jira, businessScoreFieldId: 'customfield_101' } });
  await page.request.put('/api/config/scoring', {
    data: { ...cfg.scoring, effort: { ...cfg.scoring.effort, backendFieldId: 'customfield_102', frontendFieldId: 'customfield_103' } },
  });
  await page.request.put('/api/config/queue', {
    data: { hopperJql: 'project = "ECOM"', enabled: true },
  });

  await page.goto('/queue');
  await expect(page.getByText('ECOM-9001')).toBeVisible();
  await expect(page.getByText('ECOM-9002')).toBeVisible();

  await page.locator('#ticket-lookup').fill('ECOM-9001');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/Currently 1st in the Frontend queue/)).toBeVisible();
});
```

### Step 11 — `.gitignore`

Add:

```
e2e/.auth/
e2e/.tmp/
e2e/playwright-report/
e2e/test-results/
```

The saved sign-in sessions in `.auth/` must never be committed — they are
live authentication cookies for a running instance, generated fresh on
every run.

### Step 12 — Extend `.github/workflows/ci.yml`

Add a second job to the file PLAN-2 created (or write the whole file fresh
if PLAN-2 has not run yet — the two jobs are independent and can run in
parallel):

```yaml
  e2e:
    name: End-to-end tests
    runs-on: ubuntu-latest
    steps:
      - name: Check out the repo
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
        working-directory: e2e

      - name: Build
        run: npm run build

      - name: Run e2e tests
        run: npm run test --workspace e2e
        env:
          CI: "true"

      - name: Upload Playwright report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: e2e/playwright-report/
          retention-days: 14
```

**Edge case:** `npx playwright install --with-deps chromium` must run
inside `e2e/` (`working-directory: e2e`) so it resolves the
`@playwright/test` version installed for that workspace, not fail looking
for it at the repo root.

## Acceptance criteria (verify by hand)

1. From the repo root: `npm install` (picks up the new `e2e` workspace),
   then `npm run e2e`. All tests pass, with no test signing in more than
   once per role across the whole run (check the server's stdout log for
   `POST /auth/sign-in` calls — there should be exactly two: the admin
   setup, and the one committee-member setup).
2. Run `npm run e2e` a second time immediately after the first, with no
   manual cleanup in between. It passes again — proving `start-app.sh`'s
   database reset actually works and no test leaves state that breaks a
   fresh run.
3. Temporarily reintroduce the exact scroll-anchor bug this project fixed
   earlier (in `web/src/pages/ScorePage.tsx`, change `scrollToTicket` to
   use plain `document.getElementById(...)?.scrollIntoView({ block:
   'start' })` again) and confirm `scoring.spec.ts` fails. Then revert the
   change and confirm it passes again — this proves the suite would have
   caught that regression.
4. Push to a branch and open a PR. Confirm both the `build-and-test` and
   `e2e` jobs run and pass in the Actions tab, and that a failed
   Playwright run uploads its HTML report as a downloadable artifact
   (check this by deliberately breaking one assertion, pushing, watching
   it fail, and downloading the artifact).
5. Confirm `e2e/.auth/`, `e2e/.tmp/`, `e2e/playwright-report/` and
   `e2e/test-results/` never appear in `git status` after a local run.

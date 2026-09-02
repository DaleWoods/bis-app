# PLAN 2 — Add a CI pipeline (there is currently none)

**Leverage rank: 2 of 5.**

## Why this is high-leverage

Checked directly: `.github/workflows/` does not exist in this repository.
`gh`/GitHub confirms zero workflows, zero open issues, zero open pull
requests. Every commit in this repo's history — including a large number
made across a single long session, some fixing real bugs shipped in earlier
commits of that same session — has gone straight to `main` with nothing
automated checking it. The only thing standing between a broken commit and
production has been whoever was typing `npm run typecheck && npm run test
&& npm run build` by hand before pushing.

This is the single cheapest, most leveraged change available: a few dozen
lines of YAML that make `npm run typecheck`, `npm run test` and
`npm run build` (all three already exist, already pass, already fast — the
full suite runs in under 3 seconds) run automatically on every push and
every pull request, and fail loudly if any of them fail.

This plan should be done **second**, immediately after PLAN-1 — not because
it is more urgent than the data-loss risk, but because every plan after
this one (PLAN-3, 4, 5) is safer to execute once this exists: a mistake
introduced while building any of them gets caught by CI before it reaches
`main`, rather than by the next person to notice something is broken.

## Goal

A GitHub Actions workflow that:

1. Runs on every push to `main` and every pull request targeting `main`.
2. Installs dependencies once, using the committed `package-lock.json` at
   the repo root (there is only one lockfile — this is an npm workspaces
   monorepo, `server/` and `web/` do not have their own).
3. Runs, in order, and fails the whole workflow if any step fails:
   - `npm run typecheck` (checks both `server` and `web`)
   - `npm run test` (server-side Vitest suite — 231 tests as of this
     writing)
   - `npm run build` (checks both `server` and `web` build cleanly)
4. Uses Node 22, matching `render.yaml`'s `NODE_VERSION: "22"` and this
   repo's `"engines": { "node": ">=20" }` — pin to the same major version
   actually deployed so CI cannot pass on a Node version production does
   not use.
5. Caches `npm` downloads between runs so it stays fast.

## Exact files to touch

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | **New file.** The entire workflow. |

That is the only file this plan touches. Do not modify any application
code as part of this plan — if `npm run typecheck`, `npm run test` or
`npm run build` fail when you first add this workflow, that is a
pre-existing problem to report, not something to silently work around by
weakening the CI checks (e.g. do not add `continue-on-error: true`, do not
remove a failing step, do not add `|| true` to a command).

## Step-by-step

**Step 1 — Confirm the baseline passes locally first.**

Before writing any YAML, run this exact sequence from the repo root and
confirm it succeeds:

```bash
npm ci
npm run typecheck
npm run test
npm run build
```

If any of these fail, stop and fix that first — do not write a CI config
around a currently-broken build. (As of the plan being written, all three
pass cleanly.)

**Step 2 — Create the workflow file.**

Create `.github/workflows/ci.yml` with exactly this content:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    name: Typecheck, test, build
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

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm run test

      - name: Build
        run: npm run build
```

**Edge cases a weaker model would miss:**

- **Do not use `npm install`.** Use `npm ci`. `npm install` can silently
  update the lockfile and mask a dependency drift that `npm ci` would
  catch by failing instead — and `render.yaml`'s own `buildCommand` uses
  `npm ci --include=dev`, so CI should install the same way production
  does. (The `--include=dev` flag is not needed here because
  `NODE_ENV` is not set to `production` in the CI environment, so dev
  dependencies install by default — but it does no harm to add it for
  parity with `render.yaml` if you prefer; either is correct.)
- **`cache: npm` in `actions/setup-node` needs a lockfile to hash.** Since
  there is exactly one `package-lock.json` at the repo root (confirmed —
  `server/` and `web/` have none of their own), the default cache
  behaviour works with no extra `cache-dependency-path` configuration.
  Do not add one; it is unnecessary and a wrong path would silently
  disable caching rather than error.
- **Do not split this into three separate jobs (typecheck/test/build each
  in their own job).** Doing so would re-run `npm ci` three times,
  tripling install time for no benefit — these three checks are fast
  (seconds), sequential in a single job is correct here. If this ever
  becomes slow enough to matter, that is a reason to revisit, not a
  reason to over-engineer now.
- **Do not add a `permissions:` block, a `concurrency:` block, or branch
  protection rules as part of this plan.** Branch protection (requiring
  this check to pass before merging) is a GitHub repository *setting*, not
  a file in the repo — it cannot be set by editing YAML, and it should
  only be turned on once this workflow has been observed passing on a real
  push, not blindly enabled sight-unseen. Flag it as the next manual step
  (see Acceptance criteria) rather than attempting to script it.
- **Do not add a test-matrix across multiple Node or OS versions.** This
  app deploys to exactly one environment (Render, Node 22, Linux). A matrix
  adds cost and noise without protecting anything real here.

**Step 3 — Commit and push.**

Commit only `.github/workflows/ci.yml`. Push directly to `main` (per this
repo's established practice this session of pushing straight to `main`
rather than working through PRs) unless the user has since told you to use
pull requests — if unsure, ask, since this is the one place in this
specific plan where the right answer depends on a preference this plan
cannot know in advance.

## Acceptance criteria (verify by hand)

1. After pushing, open the repository's **Actions** tab on GitHub. A
   workflow run named "CI" should appear for the push, and complete
   successfully (green) within a few minutes.
2. Open the workflow run's logs and confirm all four steps
   (`checkout`, `setup-node`, `npm ci`, `typecheck`, `test`, `build`) ran
   and none were skipped.
3. Deliberately break something in a scratch branch to prove the gate
   works — for example, comment out one assertion in any `*.test.ts` file,
   push that branch, and open a pull request against `main`. Confirm the
   CI check shows as **failed** on the PR. Then revert the change (do not
   merge the broken PR) and close it.
4. Tell the user, in your final summary, that branch protection
   ("Require status checks to pass before merging", with this workflow
   selected) is a one-time manual setting in the GitHub repository's
   Settings → Branches, and that you cannot enable it yourself — recommend
   they do, once they have seen this workflow pass on a real push.

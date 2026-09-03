# Next work, ranked by leverage

**Status: all five complete and merged to `main`**, in the order below. Kept here as the record of
*why* these five and not something else — read a plan file for the full build detail and acceptance
criteria it shipped against.

Five independent plans, produced by exploring the whole codebase, the
decisions log (`docs/decisions.md`), the requirements traceability doc, and
the actual state of the GitHub repository (zero open issues, zero pull
requests, zero CI workflows, as of when this was written). Each plan is
self-contained and can be handed to a fresh coding session with no other
context — read the plan file, follow it in order, verify against its own
acceptance criteria.

## Do them in this order

| # | Plan | One line |
|---|---|---|
| 1 | [`PLAN-1-data-durability.md`](./PLAN-1-data-durability.md) | The production database is on Render's free Postgres tier, which Render deletes after 30 days, and there is no backup anywhere. This is the only one of the five that can destroy everything the app holds, permanently. |
| 2 | [`PLAN-2-ci-pipeline.md`](./PLAN-2-ci-pipeline.md) | Zero CI exists — every commit reaches `main` unchecked. Cheapest, fastest plan here, and it makes every plan after it safer to execute. |
| 3 | [`PLAN-3-e2e-tests.md`](./PLAN-3-e2e-tests.md) | Zero persisted browser tests exist — every UI verification this project has ever had was a throwaway script, deleted after use. Depends on #2. |
| 4 | [`PLAN-4-automation-alerting.md`](./PLAN-4-automation-alerting.md) | The app runs its weekly cycle unattended by design (`docs/decisions.md` D6), and a permanently failed step is currently visible nowhere except server logs and the one round's own page. |
| 5 | [`PLAN-5-jira-config-selfcheck.md`](./PLAN-5-jira-config-selfcheck.md) | A misconfigured queue JQL already silently dropped a real ticket once this session. Adds a live preview so that class of bug is visible before it ships, not after. |

## Why this order

1 is first because it is the only item on this list with an unrecoverable
failure mode — everything else is a missing safety net for problems that
are bad but fixable after the fact; a deleted database with no backup is
not. 2 comes second not because it is more urgent than 1, but because it
is a prerequisite that makes doing 1, 3, 4 and 5 safer — a mistake in any
of them gets caught before `main` once CI exists. 3 depends directly on 2
existing to have any teeth. 4 and 5 are both real, evidenced gaps, but
each protects one feature rather than the whole application or its
history, which is why they rank below the first three.

## What is deliberately not on this list

Explored and set aside, with reasons — so nobody re-discovers these and
wonders why they were skipped:

- **A broad security audit.** Checked directly: no `dangerouslySetInnerHTML`
  anywhere in the frontend, a real Content-Security-Policy with no
  `unsafe-inline` on scripts, httpOnly/secure/SameSite session cookies,
  server-side RBAC on every route, an append-only audit log, and
  parameterised SQL throughout. This codebase already takes security
  seriously; a generic audit would not be as high-leverage as the five
  concrete, evidenced gaps above.
- **The IDM stream.** `docs/requirements-traceability.md` calls it "a
  configuration switch, not a rewrite," but nothing in `web/src` actually
  exercises it — no plan was written for it because there is no evidence
  it is in active use yet. Worth a plan the day it is.
- **Upgrading dependencies.** Checked with `npm outdated` — nothing
  urgent or vulnerable-looking, mostly minor-version drift. Not worth its
  own plan right now.
- **Rate limiting beyond `/auth`.** Only the sign-in route is throttled.
  Given this is a small, trusted internal committee (not a public-facing
  product), the leverage here is lower than the five above — worth
  revisiting if the tool's audience ever grows past "people who know each
  other," per the same reasoning `docs/decisions.md` D1 already gives for
  revisiting self-asserted identity.

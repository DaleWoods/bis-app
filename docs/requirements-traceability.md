# Requirements traceability — BIS App Requirements v0.2

Section-by-section: what was built, where it lives, and where a judgement call was made.

## §3 Goals

| Goal | Status | Notes |
|---|---|---|
| Single system of record | Done | `schema.sql` — rounds, tickets, committee, submissions, results, audit |
| Native in-app scoring | Done | Replaces the Microsoft Form entirely (`ScoreForm.tsx`) |
| Aggregation matching the spreadsheet | Done | `domain/scoring.ts`, 33 tests incl. the §10.5 examples |
| Automated distribution + reminders | Done | Graph adapter + endpoints; scheduling left to a timer trigger (see below) |
| Read from / write to JIRA | Done | `integrations/jira.ts`, idempotent write-back |
| Coordinator dashboard + feedback view | Done | `RoundDetailPage.tsx`, `FeedbackPage.tsx` |

Non-goals (RA estimation tooling, AI summaries, cross-round trends, native mobile) are not built.

## §4 Users & roles

Four roles: `ADMIN`, `COORDINATOR`, `COMMITTEE`, `VIEWER`. Enforced by `requireRole` /
`requireCoordinator` middleware on every route. The signed-in member's role is re-read from the
database on each request, so revoking or downgrading someone takes effect immediately rather than
when their session token expires.

Sign-in is name/email by decision (D1 in `decisions.md`): the committee picks their name from a list.
Entra ID SSO is implemented and available - an OIDC authorisation-code flow with PKCE
(`auth/entra.ts`) verifying the id_token against the tenant JWKS - and is a configuration switch away.
Identity is therefore self-asserted today: the RBAC rules below still hold, but against a claimed
identity rather than one Microsoft vouched for.

## §5 Domain model

All entities present. Computed values (`business_score`, `std_dev`, `discussion_required`, `effort`,
`priority_ratio`, `priority_band`, `status_label`) are derived on read from live submissions, and
snapshotted into `ticket_results` at finalisation so a finalised round cannot drift and Phase 3 has
clean history.

## §6 Categories

Seeded as seven rows in `categories` with description, zero/max labels, weight and scale. Everything
about them is editable in Settings. Retiring a category deactivates it rather than deleting it, so
historic rounds keep their maths.

## §7 Distribution pack

The in-app ticket card is the primary scoring surface, and `GET /api/rounds/:id/pack.pptx` (and
`.pdf`) generates the circulating pack from the same fields: title slide, a how-to-score slide, one
slide per ticket (header with type chip, executive summary + optional screenshot, the four labelled
panels, metadata strip), closing thank-you slide.

Population is JIRA-field mapping plus coordinator authoring in `TicketEditor.tsx`. A JIRA re-sync
refreshes the JIRA-owned fields but never overwrites an authored summary or panel.

## §8 Relevance & closure

The four answers are enumerated exactly as specified. Server-side rules:

- `YES` requires a whole-number score within scale for every active category.
- `UNSURE` stores no scores and flags the ticket for clarification.
- `NO_CLOSE` requires a reason from the configured list (Postponed / Fixed via other means /
  No Longer Required) and flags "To Close?".
- `NO_NOT_RELEVANT_TODAY` is rejected with 403 unless the submitter's email matches the ticket's
  original requestor.

## §9 Impartiality

While a round is open, `/api/my/round` and `/api/rounds/:id/my-submissions` are scoped to the caller;
the full results and submissions endpoints are coordinator-only. `/api/rounds/:id/feedback` opens to
the whole committee at finalisation and returns averages, spread and unattributed totals — no member
identifiers in the payload at all, not merely hidden in the UI.

## §10 Calculation

Implemented verbatim; see the README for the rules and the test file for the boundaries covered.
Two clarifications that the spec left implicit:

- **Sample std dev below two responses.** Excel's STDEV.S is an error there. We return `null`, and
  `discussion_required` is false — a single response cannot disagree with anything.
- **Priority ratio when effort is 0.** Treated as "effort not present" rather than dividing by zero.

## §11 Cadence

Distribution day/hour, cut-off day/hour, reminder offsets and the escalation offset are configuration,
defaulting to a Tuesday 17:00 cut-off. No weekday is hard-coded.

**Deliberate gap:** the app exposes distribution and reminders as endpoints (and the round page drives
them), but does not run its own scheduler process. On Azure, point a timer trigger / WebJob at those
endpoints; the cadence settings tell it when. That is a wiring decision for your environment, so it is
left explicit rather than assumed.

## §12 Integrations

- **JIRA** — queue read via JQL, field-id discovery through `GET /rest/api/3/field`, business-score
  write, optional transition. Credentials are service-account API tokens from configuration.
- **Graph** — client-credentials token, `sendMail` as a shared mailbox, every attempt logged with
  status so failures are visible and re-triggerable.
- **Streams** — `stream` is on tickets and rounds and the calculation is stream-agnostic, so IDM is a
  configuration switch, not a rewrite. The foundation targets ECOM/WOSG.
- **Microsoft Forms** — replaced. No historic import.

## §13 Residual questions

| Question | How it is handled |
|---|---|
| Effort: Backend + Frontend or one field? | Setting, defaulting to the combined total; per-ticket manual override available |
| Transition on write-back? | Off by default; toggle plus target status name in Settings |
| Category weighting? | Unweighted by default; weights stored per category and switchable |

## §14 Non-functional

- **Auditability** — append-only `audit_log` covering logins, submissions, config changes, round
  transitions, finalisation, exports, emails and write-backs.
- **RBAC** — server-side, per route.
- **Config-driven** — 16, 5, 6, 1.8, the categories, the cadence and the effort mapping are all data.
- **Idempotent JIRA writes** — round + ticket + score idempotency key in `jira_writebacks`.
- **Retention** — finalised rounds snapshotted for the Phase 3 trend work.
- **Accessibility** — semantic landmarks and headings, a skip link, every control labelled,
  fieldset/legend grouping for the relevance question and the score set, `output` elements bound to
  their sliders, `aria-live` status messaging, table captions and scoped headers, visible focus rings,
  and a layout that reflows to one column on small screens.

## §17 Acceptance criteria

| Criterion | Verified by |
|---|---|
| Coordinator creates a round, adds tickets, generates the pack, opens the round | UI walkthrough; `pack.pptx` (152 KB) and `pack.pdf` (6 pages) generated from the demo round |
| Committee signs in, scores 0–10 across seven categories, answers relevance, adds notes, sees only their own | UI walkthrough as a committee member; RBAC responses checked against the API |
| Correct `responses_count`, `business_score`, `std_dev`, `discussion_required`, `priority_ratio`, band and status label | `scoring.test.ts` (33 tests) and the seeded round reproducing §10.5 end to end |
| < 5 valid submissions shows "Awaiting WOSG Responses"; Unsure/No excluded; "can be closed" flags "To Close?" | Tests plus API checks |
| Anonymised feedback view after finalisation | UI walkthrough; payload asserted to contain no member names |
| CSV export before JIRA write-back exists | `GET /api/rounds/:id/results.csv` |
| All actions audit-logged; access role-enforced | `/api/audit`; 401/403 responses verified per role |

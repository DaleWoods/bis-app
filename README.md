# Business Impact Scoring (BIS)

An application that replaces the manual WOSG weekly scoring process: it holds the scoring queue,
distributes tickets to the committee, collects scores natively (no more Microsoft Form), aggregates
them **exactly as the current spreadsheet does**, and writes the business score back to JIRA.

Built to `BIS App Requirements v0.2` (kept in [`docs/`](docs/) alongside the code). This repository
contains **Phase 1 (Foundation)** plus the Phase 2 JIRA and Microsoft Graph adapters, coded against
the real APIs.

The database plan in `render.yaml` is `free` so it can be trialled at no cost — Render deletes free
databases after 30 days, so move it to `basic-256mb` before it holds scoring data you need to keep.

---

## Running it at a URL

In the Render dashboard: **New → Blueprint → this repository**. Render reads `render.yaml`, creates a
managed PostgreSQL database and the web service, and prompts for a handful of values.

**Only one value is required:** `BOOTSTRAP_ADMIN_EMAIL`. Set it to your work email address — the app
creates you as an admin on first boot, because a fresh database has no members and sign-in needs one.
Everything else can be left blank and filled in later from the Settings screen.

That gives you the whole application on a real database: create a round, write ticket cards, open it
for scoring, watch submissions land, see the aggregation, generate the pack, export CSV, finalise, and
open the anonymised feedback view.

### Signing in

The committee picks their name from a list — the app is internal and everyone knows who they are.
The coordinator manages that list in Settings; `ALLOW_SELF_REGISTRATION=true` lets people add
themselves instead, and is off by default because a new scorer's submissions count toward the average
and the minimum-responses gate.

This is a deliberate departure from §4 of the requirements (Entra ID SSO) — recorded, with what it
does and does not change, in [`docs/decisions.md`](docs/decisions.md). Moving to SSO later is
configuration: set `AUTH_MODE=entra` and supply the app registration. The OIDC flow is implemented,
and a production build refuses to start on `AUTH_MODE=entra` with an incomplete registration, so a
half-finished switch fails at deploy rather than at someone's login.

### JIRA and email, when you are ready

Neither blocks the deployment, and neither needs a code change:

| | Until it is configured | To switch it on |
|---|---|---|
| **JIRA import / write-back** | Add tickets manually or by CSV; export results as CSV. | Add `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` (service account, not a personal login), then Settings → JIRA → "Resolve field ids from JIRA". |
| **Distribution / reminder email** | Messages are composed and logged, never sent, so the cadence can be rehearsed. | Set the five `SMTP_*` / `EMAIL_FROM` variables — see below. |

### Turning on email

Distribution and reminders go out over **SMTP**, which needs no approval from anyone: sign up with a
provider, verify the single address you will send from, and set five environment variables.

| Provider | Host | Free allowance |
|---|---|---|
| Brevo | `smtp-relay.brevo.com` | 300 emails/day |
| SendGrid | `smtp.sendgrid.net` | 100 emails/day |
| Gmail (app password) | `smtp.gmail.com` | fine for a committee |

```
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<your login>
SMTP_PASS=<api key or app password>
EMAIL_FROM=<the address you verified with the provider>
EMAIL_REPLY_TO=<coordinator address, so replies come back to a person>
```

Then **Settings → Email → "Send a test email to me"** proves it before you mail the committee.
`EMAIL_SEND_ENABLED=false` composes and logs without sending, for rehearsing the cadence.

Two honest limits:

- **Sending as your company domain** needs SPF/DKIM DNS records on that domain, which is a DNS
  change only IT can make. Send from an address you control instead and set `EMAIL_REPLY_TO`.
- **Deliverability.** Mail from an unfamiliar external domain can land in Junk on a corporate tenant
  the first time. Ask the committee to mark the first one as safe.

Microsoft Graph remains supported as an alternative — set the `GRAPH_*` variables and it switches
provider automatically. SMTP takes precedence when both are configured.

### Sample data

The instance starts clean, as agreed. If you want a pre-filled round for a walkthrough — one whose
numbers reproduce the worked examples in the requirements — set `SEED_ON_BOOT=demo`, deploy once, then
remove it. It only ever seeds a database that has no rounds in it, so it can never disturb live work.

### Locally

```bash
npm install
npm run seed --workspace server -- --demo
npm run dev:server     # API on :4000
npm run dev:web        # UI on :5173  →  open http://localhost:5173
```

Or run the built app on one port, the way it is deployed:

```bash
npm run build
NODE_ENV=production AUTH_MODE=email ALLOW_SQLITE=true \
  DB_DRIVER=sqlite SQLITE_FILE=./data/bis.db SESSION_SECRET=anything \
  BOOTSTRAP_ADMIN_EMAIL=you@example.com PORT=4000 npm start
```

### The production guards

A production build refuses to start when it would be unsafe, and each refusal names its escape hatch:

- **No `SESSION_SECRET`** — always fatal. Nothing overrides it.
- **SQLite** — fatal unless `ALLOW_SQLITE=true`.
- **`AUTH_MODE=entra` without a registration** — always fatal, so SSO never half-works.

Sign-in mode, database and sample data are independent choices, so any combination is available
without touching code.

### Sample data locally

`npm run seed --workspace server -- --demo` fills a local database with a committee and a round whose
numbers reproduce the worked examples from the requirements: ECOM-1466 at 43 / 12.8 / ratio 2.69
(Medium), ECOM-1422 at 13 / ratio 1.00 (Low), ECOM-915 with std dev 18.4 (Pending discussion). Useful
for seeing the maths without scoring four tickets by hand first.

### Tests

```bash
npm test --workspace server        # 33 tests over the §10 calculation module
npm run typecheck                  # server + web
```

### Production build

```bash
npm run build                      # compiles the API and the React app
npm start                          # API serves the built UI from the same origin
```

---

## How it maps to the requirements

| Requirement | Where it lives |
|---|---|
| §5 domain model | `server/src/db/schema.sql`, `server/src/services/*` |
| §6 seven categories, stored as data | `categories` table, seeded from `domain/types.ts`, editable in Settings |
| §7 ticket card / distribution pack | `web/src/components/TicketCard.tsx`, `server/src/pack/pptx.ts`, `pack/pdf.ts` |
| §8 relevance & closure rules | `services/submissionService.ts` (server-enforced) |
| §9 impartiality & feedback view | `routes/rounds.ts`, `services/resultService.ts`, `web/src/pages/FeedbackPage.tsx` |
| §10 the maths | `server/src/domain/scoring.ts` + `scoring.test.ts` |
| §11 cadence | `app_config.cadence`, Settings → Cadence |
| §12.1 JIRA | `integrations/jira.ts`, `services/jiraService.ts` |
| §12.2 Graph mail | `integrations/graph.ts`, `services/emailService.ts` |
| §12.3 auth / hosting | `auth/entra.ts`, `auth/session.ts`, `render.yaml`, `docker-compose.yml` (see D1 in `docs/decisions.md`) |
| §14 audit, RBAC, config-driven, idempotent writes | `services/auditService.ts`, `auth/middleware.ts`, `app_config`, `jira_writebacks` |

A section-by-section trace, including the deliberate decisions, is in
[`docs/requirements-traceability.md`](docs/requirements-traceability.md).

---

## The calculation (§10)

`server/src/domain/scoring.ts` is a pure module - no database, no clock, no I/O - and is the only
place the maths lives. Every threshold is configuration, not a literal.

- `bis_total` = sum of the seven category scores (0–70). A `0`, including Commercial "N/A",
  counts as 0; it is never excluded.
- A submission counts only when `relevance = Yes` and it is not archived. `Unsure` and both `No`
  answers are stored and reported, but never scored.
- `business_score` = `ROUND(AVERAGE(valid totals), 0)` - Excel's half-away-from-zero rounding, with
  binary-noise correction. This integer is what goes to JIRA.
- `std_dev` = sample standard deviation (STDEV.S); `null` below two responses, as in Excel.
- `discussion_required` = `std_dev > 16`.
- `priority_ratio` = `business_score ÷ effort`, computed **only** when discussion is not required and
  effort is present; bands at ≥ 6 High, ≥ 1.8 Medium, else Low.
- The status label reproduces the spreadsheet's precedence exactly:
  no responses → blank; under 5 → "Awaiting WOSG Responses"; any "can be closed" vote → "To Close?";
  no effort → "Awaiting RA effort"; discussion → "Pending discussion"; otherwise the priority band.
- ≥ 5 responses with no discussion required is flagged **Send for Est**.

The tests assert all three worked examples from §10.5, plus the boundary cases (exactly 5 responses,
ratio exactly 6 and exactly 1.8, threshold exactly 16, single response, N/A as zero).

### Effort mapping (residual question 1)

Whether "RA Effort" is Backend + Frontend or a single poker field was still open. It is a setting:
`Settings → Scoring → Effort mapping`, with `BACKEND_PLUS_FRONTEND` as the default (ECOM-1775 = 13 + 8
= 21). Switch it to `BACKEND_ONLY`, `FRONTEND_ONLY` or `MANUAL` when RA confirms - no code change.
A coordinator can also set a per-ticket manual override, which always wins.

### Status transition on write-back (residual question 2)

Default is **write the score only**. `Settings → JIRA → Transition on finalise` turns on the optional
transition and lets you name the target status.

### Category weighting (residual question 3)

Unweighted straight sum, as today. Each category carries a `weight`, and
`Settings → Scoring → Apply category weights` switches weighting on when wanted.

---

## Impartiality (§9)

- While a round is open, a committee member's API calls can only ever return their own submissions.
  Coordinators see everything, including who scored what, because they have to chase non-responders.
- After finalisation the whole committee can open the feedback view: per-category averages, the total,
  the spread and the discussion flag, plus the unattributed list of individual totals. No names.
- "This ticket isn't relevant today" is rejected server-side unless the submitter is the ticket's
  original requestor.
- Everything is written to an append-only audit log with who and when.

Role checks are middleware on the routes, not conditions in the UI - hiding a nav link is a courtesy,
the server is the enforcement.

---

## Configuration

Copy `.env.example` to `.env`. Business rules are **not** in there - they live in the database and are
edited in Settings (thresholds, categories, cadence, effort mapping, JIRA field ids, pack branding).

### Database

Production targets Azure Database for PostgreSQL. Local development defaults to a SQLite file so the
app runs with nothing installed. The schema is one SQL file valid on both dialects; both paths are
exercised by the same migration and seed scripts.

```bash
docker compose up -d                     # local Postgres on :5432
DB_DRIVER=postgres DATABASE_URL=postgres://bis:bis@localhost:5432/bis npm run migrate --workspace server
```

### JIRA

Use a service account and an API token. To resolve the real `customfield_XXXXX` ids, open
`Settings → JIRA → Resolve field ids from JIRA`; it calls `GET /rest/api/3/field` and reports the ids
for Business Score, Backend/Frontend Poker Score, Site Affected, Original Testing Environment and
Ticket Phase. Paste them into the settings form - they are stored as config, never hard-coded.

Write-back is idempotent: the key is round + ticket + score, so re-running after a partial failure
retries only what did not land, and re-running after success is a no-op. Failures are visible on the
round page and re-triggerable. Tickets below the minimum response count are skipped, not written -
they roll over.

### Email

Microsoft Graph with an app registration (`Mail.Send` application permission) sending as a shared
mailbox or the coordinator. With `GRAPH_SEND_ENABLED=false` messages are rendered and logged but not
sent, so the cadence can be rehearsed before go-live. Every send attempt lands in `email_log` with its
status.

---

## Deployment (Azure)

Build once and run the API - it serves the React bundle from the same origin, so one App Service is
enough.

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `AUTH_MODE` | `entra` (the server refuses `dev` in production) |
| `DB_DRIVER` / `DATABASE_URL` | `postgres` / your Azure Database for PostgreSQL connection string |
| `DATABASE_SSL` | `true` |
| `SESSION_SECRET` | long random string |
| `SESSION_COOKIE_SECURE` | `true` |
| `ENTRA_*` | app registration, with `ENTRA_REDIRECT_URI` = `https://<host>/auth/callback` |

Migrations run on boot and are idempotent. Members are provisioned by a coordinator; an Entra user who
is not on the committee is refused rather than silently admitted.

---

## What is deliberately not here

- **AI-drafted ticket summaries** (Phase 2). The coordinator writes the executive summary and the four
  panels; the JIRA description is imported alongside them as raw material.
- **Cross-round trend analytics** (Phase 3). Finalised rounds are snapshotted into `ticket_results`
  precisely so that work has clean data to build on.
- **Historic import.** The process starts clean, as agreed.
- **RA's estimation tooling.** Effort is read from JIRA or entered by the coordinator.
- **A scheduler process.** Distribution and reminders are exposed as endpoints and driven from the
  round page; the cadence settings say when they should fire. Wiring them to Azure WebJobs / a timer
  trigger is a small, deliberate next step rather than an assumption baked into the app.

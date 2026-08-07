# Decisions that depart from the requirements

Deliberate, agreed changes to `BIS App Requirements v0.2`. Recorded here so they read as decisions
rather than drift, and so they can be revisited without archaeology.

---

## D1 — Sign-in is name/email, not Entra ID SSO

**Requirement:** §4 — "Auth: Microsoft 365 / Entra ID (Azure AD) SSO — no separate login."

**Decision (Dale, owner):** the app is internal, the committee is a known group of colleagues, and
there is no expectation of anyone misrepresenting themselves. Sign-in is therefore a name picker:
you choose yourself from the committee list, or enter your email address.

**Rationale:** SSO would need an Entra app registration from IT before anyone could use the tool at
all. For an internal weekly process among a handful of managers, that cost outweighs the benefit.

**What this changes in practice**

- Identity is *self-asserted*. The RBAC rules of §9 still hold — a committee member's API calls
  return only their own submissions, coordinator screens are refused — but they are enforced against
  the identity someone claims, not one Microsoft vouched for.
- The audit log (§14) records who the session says it is. "Dale scored 8" is accurate as long as the
  person at the keyboard picked their own name. The realistic failure is a shared screen or a session
  left open on a hot desk, not deceit.
- The impartiality design intent of §2 — a cross-functional committee so requestors cannot inflate
  their own tickets — depends on convention here rather than enforcement. Nothing stops someone
  signing in as a colleague and looking at, or changing, their scores.

**Mitigations kept in place**

- The sign-in picker returns names and teams only, never email addresses, so an internal URL does not
  hand out a staff directory.
- Self-registration is **off** by default: a new scorer's submissions count toward the average and the
  minimum-responses gate, so who is on the committee stays a coordinator's decision.
- Sessions expire after `SESSION_TTL_HOURS` (12 by default).
- Every sign-in is audit-logged with its method.

**Reversing it** is configuration, not a rewrite. The Entra OIDC flow is implemented and tested:
set `AUTH_MODE=entra`, supply the three `ENTRA_*` values and the redirect URI, and the app switches.
A production build refuses to start on `AUTH_MODE=entra` with an incomplete registration, so a
half-finished switch fails at deploy rather than at someone's login.

**Revisit if:** the tool starts holding commercially sensitive scoring, the committee grows beyond
people who know each other, or the score becomes an input to something with money attached.

---

## D1b — Coordinators and admins do not score

**Requirement:** §4 lists Dale under both Coordinator/Admin and the committee, so the spec allows one
person to do both.

**Decision (Dale, owner):** they are separate jobs. Only `COMMITTEE` members score. Coordinators run
rounds and can see every submission; viewers are read-only.

**Rationale:** an app that showed a coordinator both the whole round's submissions *and* a scoring
form for themselves was confusing to use. It also sits better with §2 — scoring is done by a
cross-functional panel, not by the people administering the process.

**What changes**

- A `COORDINATOR`/`ADMIN`/`VIEWER` submission is refused server-side, not merely hidden.
- Distribution, reminders and the progress table cover active committee members only, so a
  coordinator is no longer chased for scores they cannot give.
- Coordinators land on the rounds dashboard; the Score tab is not shown to them. They can still read
  the ticket cards exactly as the committee sees them.

**Watch the minimum-responses gate.** `MIN_SUBMISSIONS` is 5, and removing coordinators from the pool
shrinks the committee. If tickets start sitting at "Awaiting WOSG Responses", either add committee
members or lower the threshold in Settings — the number is configuration, not a rule of the maths.

**Recovering earlier data:** scores recorded by a coordinator before this change still count. A
coordinator can exclude any submission from the round page ("Who scored what" → Exclude), which marks
it archived so it stops counting without deleting it or its audit trail.

## D2 — No scheduler process; distribution and reminders are triggered

> **Superseded by D6.** The app now runs the cycle itself. The endpoints below
> still exist and every manual button still works — D6 added a clock in front of
> them, it did not replace them.


**Requirement:** §11 cadence, §12.2 automated distribution and reminders.

**Decision:** the app exposes distribution and reminder endpoints, driven from the round page, and
stores the cadence as configuration. It does not run its own timer.

**Rationale:** how a scheduled job is hosted is an environment decision (Azure WebJob, Render cron,
GitHub Action). Baking one in would be an assumption; the endpoints are the stable part.

**To close the gap:** point a scheduled job at `POST /api/rounds/:id/distribute` and
`POST /api/rounds/:id/remind` on the days the cadence settings describe.

---

## D3 — Effort defaults to Backend + Frontend poker

**Requirement:** §10.4 / §13.1 — left open pending confirmation from RA.

**Decision:** default to the combined total (ECOM-1775 = 13 + 8 = 21), exposed as a setting with
`BACKEND_ONLY`, `FRONTEND_ONLY` and `MANUAL` alternatives, plus a per-ticket manual override.

**Revisit when:** RA confirms. It is a dropdown in Settings, not a code change.

---

## D4 — Cards are drafted by AI when a key is configured, by heading parsing otherwise

**Requirement:** §7 card content; the requirements put AI-assisted drafting in Phase 2.

**Decision:** `draftCardFor()` calls the Anthropic API with the ticket's own text and falls back to
the existing heading parser when no `ANTHROPIC_API_KEY` is set, when the call fails, or when the
response will not parse. The parser is unchanged and still fully tested.

**Rationale:** the heading parser only works on tickets written in sections, and most are not — it
was matching on titles and producing cards too thin to score. Reading the whole ticket is the
difference between "SAP integration error" and "gift wrap orders stall on their way to the warehouse,
and someone corrects about twenty every morning", which is the language the committee scores in.

**Constraints held:** only ticket text is sent — never scores, committee names or round data. Every
draft lands in the editor for a coordinator to check; nothing is published automatically. A failure
degrades one ticket to the parser rather than failing an import.

**Cost:** pennies per card, on a self-service console with card payment — the same shape as the SMTP
decision, and needing nobody's approval. `AI_DRAFT_ENABLED=false` turns it off without removing the
key.

---

## D5 — The slide is structured by what kind of ticket it is, not by four fixed panels

**Requirement:** §7 card content — Current / Impacts / Future / Benefits.

**Decision:** the ticket slide carries a kind chip (problem / improvement / new capability), a
headline set large, **three** narrative sections whose labels follow that kind, a captioned
screenshot beside quantified impact chips, an "if we fix it" line, and a metadata strip. The full
JIRA description goes into the speaker notes.

**Rationale:** the four-column deck was reported as telling committee members nothing about what a
ticket actually was. Two causes, and both are structural rather than editorial:

- **The labels asked the wrong question.** "What's happening now" reads fine for a defect and makes
  no sense for something that does not exist yet. A scorer looking at a new capability needs to be
  asked "what can't we do today". One table, three readings, no new fields.
- **The picture was a thumbnail and the figures were buried.** A screenshot of a broken carousel
  explains it faster than any three bullets, and a scorer weighs "20 orders corrected by hand every
  morning" differently from "operations are impacted". Both now have their own space, and the
  screenshot carries a caption saying what to look at — without one it is decoration.

Three sections rather than four because Benefits was never a list: it is the single reason to
prioritise the thing, and it reads better as one line along the foot of the slide.

**Where the length went:** nowhere. The earlier complaint that the decks were too wordy still holds,
and every field is still clipped — the answer to "it does not tell me enough" is more structure and a
bigger picture, not longer paragraphs. Detail that genuinely does not fit is in the speaker notes.

**Migration:** `002_slide_card.sql`. Existing cards keep their content and render under the problem
wording until someone redrafts or edits them; nothing is lost and nothing needs re-entering.

---

## D6 — The app runs the weekly cycle itself, and every step can still be done by hand

**Requirement:** §11 cadence, §12.2 automated distribution and reminders. Supersedes D2.

**Decision:** an interval inside the web service asks "what is due" once a minute and runs it:
create next week's round, fill it from the JIRA queue, roll over tickets that missed the minimum,
open and distribute it, chase non-responders, close at the cut-off, finalise after a grace period,
write the scores to JIRA and transition the ticket. Each step is separately switchable, off by
default, and none of them removes a button.

**Why in-process rather than a cron service:** it needs no extra Render component, no scheduler to
configure and no second deployment to keep in step with the app — the same reasoning that made SMTP
the right answer for email. D2 kept the hosting choice open; it has now been made.

**What makes it safe to run every minute:**

- **Exactly once.** Every step claims a row in `round_automation_log`, which has a unique key on
  (round, action). A step that has run cannot run again — however often the tick fires, and across a
  restart mid-cycle.
- **Late, never skipped.** The scheduler asks what is *due*, not what is due *right now*. A service
  asleep over the cut-off closes, finalises and writes back on its first tick after it wakes, in one
  pass rather than one step per minute.
- **Manual is not a conflict.** Every step re-reads the round first. Closing a round early is not an
  error; the close step simply finds it closed.
- **No new authority.** Automation calls the same service functions the buttons call, with the same
  guards. It cannot write a score the minimum-responses gate would reject.
- **Failures stop, they do not loop.** A failed step stays claimed with its error on the round page.
  Retrying a bad JIRA token every 60 seconds helps nobody; the matching manual button re-runs it.

**The overrides, because automation without a way out is not trustworthy:**

| Want to | Do this |
|---|---|
| Stop the app touching one round | "Pause automation for this round" |
| Close scoring early | "Close scoring" — automation finds it closed |
| Reopen a round that finalised wrongly | "Reopen for scoring" |
| Run what is due now, not in a minute | `POST /api/automation/run` |
| Turn it all off | The master switch in Settings |

**Reopening a finalised round** is new. It used to be a dead end on the reasoning that finalised
results are frozen — but that is exactly why a way back is needed when a round finalises with the
wrong scores in it, and with the app finalising rounds unattended it stopped being hypothetical.
Reopening clears the finalised stamp and the close/finalise/write-back log entries so the tail of the
cycle can run again. Anything already in JIRA stays there until a fresh write-back replaces it, and
the confirmation dialog says so.

**The honest limits:**

- **One instance.** The claim rows mean a second instance could not double-run a step, but the
  design assumes one. `SCHEDULER_ENABLED=false` takes an instance out of the rotation.
- **Timezones are arithmetic, not a library.** The cadence hour is read as wall-clock time in the
  configured timezone using `Intl`, recalculated per round. Good enough for a weekly rhythm; it is
  not a scheduling product.
- **A round with no tickets is never distributed.** It waits rather than emailing the committee an
  empty deck, and goes out on the next tick once a ticket lands.

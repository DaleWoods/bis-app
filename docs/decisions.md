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

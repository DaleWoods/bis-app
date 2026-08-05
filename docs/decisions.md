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

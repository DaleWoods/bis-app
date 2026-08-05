# Business Impact Scoring (BIS) Application — Requirements Specification

**Version:** 0.2 (Foundation) · supersedes v0.1
**Owner:** Dale — Test Manager / Senior Test & Quality Lead, WOSG
**Purpose:** A build brief for Claude Code. Everything the previous version left open has now been resolved from the live scoring spreadsheet (`Business_Scoring_2.xlsx`) and a real JIRA ticket (ECOM-1775). §10 (the maths) and §12 (JIRA fields) are now definitive.

> **What changed since v0.1:** the scoring calculation, the standard-deviation threshold, the priority formula, N/A handling, and the JIRA custom fields are all confirmed (no longer assumptions). Added the committee **distribution pack / slides** as an explicit requirement (§7). Confirmed decisions folded in: native in-app scoring, Azure hosting, start clean, AI summaries deferred to Phase 2.

---

## 1. Overview

WOSG runs a weekly **Business Impact Scoring (BIS)** process. JIRA tickets awaiting prioritisation are reviewed by a cross-functional committee, who each score the ticket **0–10 across seven impact categories**. The scores are aggregated into a **business score** (0–70), which — combined with RA's effort estimate — drives the **priority** the development partner (RA) works to. Higher business score = higher priority = worked on sooner.

Today this is heavily manual: a coordinator hand-builds a slide deck (one slide per ticket), emails it with a Microsoft Form, chases responses, aggregates scores in a large spreadsheet, and manually updates JIRA. This application replaces that: it ingests tickets, distributes them for scoring, collects and aggregates scores, and writes results back to JIRA.

**Primary goal:** automate as much of the manual workflow as possible while preserving impartial, auditable scoring.

---

## 2. Background — the current ("as-is") process

1. **Ticket created** in JIRA (a stakeholder request, improvement, feature, or bug).
2. **Reviewed**, then moved into the **Business Scoring** queue (JIRA status `WOSG: Business Scoring`).
3. The **coordinator** (Nikita) selects the tickets due, and builds a **slide deck** — one slide per ticket — summarising each at a glance (§7).
4. The deck + a **Microsoft Form** is **emailed to the committee**.
5. Each **committee member** independently scores each ticket 0–10 on seven categories (§6) via the form, entering the JIRA ID, a relevance answer, the scores, and optional notes.
6. Scores are aggregated (average, standard deviation), a discussion flag is set, RA effort is factored in, priority is derived, and **JIRA is updated** with the business score.
7. Cadence is weekly with a Tuesday cut-off; tickets clearing the bar progress to RA, others roll over or get flagged for discussion.

### Why a committee (design intent — must be preserved)
Impartiality. When tickets were scored by their own requestor, people over-scored their own requests. A cross-functional committee produces a balanced score. **Automation must not reintroduce requestor bias** (§9).

### Known pain points to design against
Bias when a ticket is first reported; unclear how to score categories; ticket dependencies not reflected; meetings not in diaries; stale tickets lingering in the queue.

---

## 3. Goals & non-goals

### Goals (foundation)
- Single system of record for the scoring queue, committee, rounds, submissions, and results.
- Native in-app scoring (replaces the Microsoft Form).
- Automated aggregation exactly matching the current spreadsheet maths (§10).
- Automated distribution + reminder/escalation emails to the committee.
- Read tickets from JIRA; write the business score back to JIRA.
- A coordinator dashboard (round status, submission progress) and a post-round feedback view for the committee (§9).

### Non-goals (foundation)
- Replacing RA's effort estimation / poker-planning tooling.
- AI-generated ticket summaries (Phase 2 — foundation uses JIRA-field mapping + coordinator editing).
- Cross-round trend analytics (Phase 3).
- Native mobile apps (responsive web is sufficient).

---

## 4. Users & roles

| Role | Who | Can do |
|------|-----|--------|
| **Coordinator / Admin** | Nikita (and Dale) | Create/manage rounds, select tickets, edit summaries, trigger distribution, chase non-responders, see all submissions incl. who scored what, finalise, trigger JIRA write-back, manage committee |
| **Committee member** | Ecommerce sub-team managers (e.g. Matt – UX, James – Digital Marketing, Saj – Merch Watches, a Merch Jewellery rep, Dale, and others) | See tickets in the active round, submit/edit their own scores until cut-off, add notes/queries, view the anonymised post-round feedback |
| **Viewer (optional)** | Leadership | Read-only dashboards/results |

- **Auth:** Microsoft 365 / Entra ID (Azure AD) SSO — no separate login.
- **RBAC enforced server-side.** A committee member must never see another member's individual scores while a round is open (§9).

---

## 5. Core domain model

- **Ticket** — `jira_id`, `title`, `type`, `jira_status`, `created_date`, `stakeholder`, `affects`, `impacts`, `workaround`, `site_affected`, `original_testing_environment`, `raw_description`, summary fields (§7), `original_requestor`, `stream` (ECOM/WOSG or IDM). Computed per round: `business_score`, `std_dev`, `discussion_required`, `effort`, `priority_ratio`, `priority_band`, `status_label`.
- **ScoringRound** — `id`, `week_label`, `cut_off_datetime`, `status` (Draft/Open/Closed/Finalised), `tickets[]`, `distribution_sent_at`, `reminders_sent[]`.
- **CommitteeMember** — `name`, `email`, `team`, `active`, `role`.
- **Submission** — `ticket_id`, `round_id`, `member_id`, `relevance` (enum, §8), `scores` (the 7 values), `closure_reason`, `closure_info`, `more_info`, `submitted_at`, `updated_at`.
- **TicketResult** (aggregate per ticket per round) — `responses_count`, per-category averages, `business_score`, `std_dev`, flags, `effort`, `priority_ratio`, `priority_band`, `status_label`.
- **Config** (editable, not hard-coded) — category set/weights, `MIN_SUBMISSIONS`, `STD_DEV_DISCUSSION_THRESHOLD`, `PRIORITY_HIGH`, `PRIORITY_MEDIUM`, cadence/cut-off, effort-field mapping.

---

## 6. Scoring model — the seven categories

Each scored **0–10** (whole numbers); `0 = Not Impacted` / `10 = Highly Impacted` (Commercial: `0 = N/A`).

| # | Category | Description shown to the scorer |
|---|----------|-------------------------------|
| 1 | **Commercial Impact** | Revenue generation or cost savings *(0 = N/A)* |
| 2 | **Operational Impact** | Reduces manual effort, speeds up workflows, automates repetitive tasks for system users / support colleagues |
| 3 | **Support Strain** | Reduces customer service or internal support demand |
| 4 | **Client / User Impact** | Improves UX/UI or end-user satisfaction, incl. accessibility initiatives |
| 5 | **Strategic Alignment** | Aligns with Objectives & Key Results, board priorities, or long-term business goals |
| 6 | **Data & Reporting Value** | Enhances analytics, attribution, or operational insights |
| 7 | **Reputational / Brand Risk** | Prevents reputational harm or enhances brand trust |

> Store categories **as data**, so they can be added/reworded/reweighted without a code change — the process is expected to evolve.

---

## 7. Committee distribution pack ("the slides")

Today the committee scores from a **PowerPoint deck — one slide per ticket** — instead of opening each JIRA ticket. The app must reproduce this effect. **Recommended approach:** the in-app **ticket card** is the primary scoring surface (the distribution email links to the round), **and** the app can generate a matching **PowerPoint/PDF pack** for circulation and archiving. Both are driven from the same ticket data, so they never drift.

**Each ticket card / slide contains (matching the current deck):**
- **Header:** `JIRA ID – Title`, with a small type icon.
- **Executive Summary:** 2–4 sentences — what the item is and the value of resolving it — with an optional screenshot/thumbnail.
- **Four labelled panels:**
  - **Current** — the present situation / problem.
  - **Impacts** — what the problem causes.
  - **Future** — the target/desired state.
  - **Benefits** — what resolving it delivers.
- **Metadata strip:** Created date · Type · Stakeholder · Affects · Impacts · Workaround.
- The pack also has a **title slide** (round name + date) and a **closing "thank you" slide** (as today).

**Population (foundation):** map from JIRA fields where they exist and let the coordinator author/edit the Executive Summary and the four panels in-app. **AI-assisted drafting of these from the raw ticket is Phase 2**, not foundation scope.

---

## 8. Relevance & closure rules

The scoring form's first question (mirrors the current form). Enumerate exactly:

- **`Yes – It aligns with Business Strategy`** → normal scoring; this submission counts.
- **`Unsure – I will skip scoring as I don't understand the request`** → recorded but **excluded** from all aggregates; ticket flagged for clarification.
- **`No – This ticket can be closed`** → no scores; capture **Reason for Closure** (seen values: *Postponed*, *Fixed via other means*, *No Longer Required*) + optional info. Any such vote flags the ticket **"To Close?"**.
- **`No – This ticket isn't relevant today`** → **only valid if the submitter is the original requestor**; capture reason + info; flags the ticket to be parked/removed.

Only `Yes` submissions feed the score.

---

## 9. Impartiality, anonymity & feedback view (confirmed)

- While a round is **open**: members see **only their own** submissions. The **coordinator can see everything**, including who scored what (needed to chase non-responders).
- After a round is **finalised**: provide a **feedback view visible to the whole committee** showing how each ticket scored overall — per-category averages, total business score, spread/standard deviation, and the discussion flag — **without attributing individual scores to named members** (show the distribution, not "Matt gave 3"). This satisfies the "everyone can see how a ticket was scored" ask while keeping individual scoring impartial.
- Full audit detail is retained server-side for the coordinator/admin.

---

## 10. Scoring calculation — DEFINITIVE (from the live spreadsheet)

These rules reproduce the current spreadsheet exactly. Implement them as a single, tested calculation module with the thresholds as config constants.

### 10.1 Per submission
- **`bis_total` = SUM of all seven category scores** → range **0–70**.
- A `0` (including Commercial "N/A") **counts as 0** — it is **not** excluded.
- A submission counts toward a ticket **only if** `relevance = "Yes – It aligns with Business Strategy"` and it is not an archived/legacy score. `Unsure` and both `No` variants are stored but excluded.

### 10.2 Per ticket, per round (aggregate over valid submissions)
- **`responses_count`** = number of valid `Yes` submissions for the ticket.
- **`business_score` = ROUND( AVERAGE( valid submissions' `bis_total` ), 0 )** → range **0–70**. **This integer is what gets written to the JIRA "Business Score" field.** (Confirmed against ECOM-1775 = 36.)
- **`std_dev`** = **sample** standard deviation (STDEV.S) of the valid submissions' `bis_total`.
- **`discussion_required`** = `std_dev > 16`  *(config: `STD_DEV_DISCUSSION_THRESHOLD = 16`)*.
- **`effort`** = RA poker effort for the ticket (see 10.4).
- **`priority_ratio`** = `business_score ÷ effort` — computed **only** when `discussion_required = false` and `effort` is present; otherwise blank.
- **`priority_band`:**
  - `priority_ratio ≥ 6` → **High priority**  *(config: `PRIORITY_HIGH = 6`)*
  - `priority_ratio ≥ 1.8` → **Medium priority**  *(config: `PRIORITY_MEDIUM = 1.8`)*
  - otherwise → **Low priority**

### 10.3 Status label (progress gate) — reproduce this precedence
```
if responses_count == 0            -> ""                       (nothing yet)
elif responses_count < 5           -> "Awaiting WOSG Responses" (min not met; rolls over)
else:  # >= 5 valid submissions  (config: MIN_SUBMISSIONS = 5)
    if any vote was "No – can be closed" -> "To Close?" / "To be Closed"
    elif effort is missing               -> "Awaiting RA effort"
    elif discussion_required             -> "Pending discussion"
    elif priority_ratio >= 6             -> "High priority"
    elif priority_ratio >= 1.8           -> "Medium priority"
    else                                 -> "Low priority"
```
- A ticket with **≥ 5 valid submissions and `discussion_required = false`** is marked **"Send for Est"** — ready to hand to RA for estimation.

### 10.4 Effort
- Effort is set by **RA during poker planning**. In JIRA the ticket carries **Backend Poker Score** and **Frontend Poker Score** (e.g. 13 and 8 on ECOM-1775). The spreadsheet uses a single **"RA Effort"** number per ticket.
- **Confirm (one residual question):** is `effort` the **Backend + Frontend** poker total, or one specific field? Make the effort-field mapping a **config setting** so it can be pointed at the right field(s) without a rewrite.
- Dale's intent is a **value-vs-effort** lens (low effort + reasonable score = quick win) — which is exactly what `business_score ÷ effort` already expresses.

### 10.5 Worked check (from live data)
- ECOM-1466: business_score 43, effort 16 → ratio 2.69 → **Medium**; std_dev 12.8 → no discussion. ✓
- ECOM-1422: business_score 13, effort 13 → ratio 1.0 → **Low**. ✓
- ECOM-915: std_dev 18.4 → **Pending discussion** (>16). ✓

---

## 11. Cadence (informs scheduling & reminders)

| Day | Actions |
|-----|---------|
| **Mon** | JIRA clarification; RA poker planning (effort) |
| **Tue** | WOSG/RA standup; **scoring cut-off (COP Tue)** |
| **Wed** | JIRA review with managers |
| **Thu** | JIRA clarification; finalise planned tickets |
| **Fri** | Scoring follow-up; ready for BAU pick-up |

Make distribution/reminder timing **configurable** around this cadence (don't hard-code weekdays). Reminders should target members who haven't submitted before the cut-off.

---

## 12. Integrations

### 12.1 JIRA (Cloud — confirmed)
- **Read:** tickets in `WOSG: Business Scoring` status, with the fields in §5/§7.
- **Write:** the computed `business_score` to the JIRA **Business Score** custom field; optionally transition status (e.g. → `RA: Ready for Estimation`) on finalisation.
- **Custom fields observed on a real ticket (ECOM-1775):** Business Score *(write target)*, Backend Poker Score, Frontend Poker Score *(effort inputs)*, Site Affected, Original Testing Environment, Ticket Phase, SAP Status ZY ZZ, Development Branch, Browser — plus standard summary/type/status/created/reporter.
- **Action for build:** resolve the real `customfield_XXXXX` IDs via the JIRA REST API (`GET /rest/api/3/field`) against the WOSG Cloud site, and store them in config. Use a **service account / API token** (or the Atlassian OAuth app) — do not hard-code personal credentials.

### 12.2 Email — Microsoft 365 / Microsoft Graph
- Send **distribution** emails (round opened, link to the in-app round + optional pack) and **reminder/escalation** emails to non-responders before cut-off, from the coordinator or a shared mailbox.

### 12.3 Auth & hosting
- **Entra ID (Azure AD) SSO** for all users.
- **Host on Azure** (App Service + Azure Database for PostgreSQL) to fit the existing M365 tenancy. Confirm any internal security constraints with IT.

### 12.4 Streams
- Two parallel streams exist with identical logic: **ECOM/WOSG** (ecommerce) and **IDM** (IT/internal). **Foundation targets ECOM/WOSG**; keep `stream` on the ticket and the calc stream-agnostic so IDM can be switched on later.

### 12.5 Microsoft Forms
- The app **replaces** the form with native in-app scoring. **Start clean — no historic import.**

---

## 13. Residual questions (small; don't block the build)

1. **Effort field:** Backend + Frontend poker combined, or one specific field? (§10.4) — set via config.
2. **Status transition on write-back:** should finalising also transition the JIRA status, or only write the score? (Default: write score only for the foundation.)
3. **Category weighting:** currently unweighted (straight sum). Keep unweighted for now, but the config supports weights when wanted.

---

## 14. Non-functional requirements

- **Auditability:** every submission, edit, calculation, and JIRA write-back logged with who/when.
- **RBAC** enforced server-side.
- **Config-driven:** categories, weights, thresholds (`16`, `5`, `6`, `1.8`), cadence, and the effort mapping are all settings.
- **Idempotent JIRA writes;** failed emails/write-backs are visible and re-triggerable.
- **Data retention:** keep finalised rounds for the Phase 3 trend work.
- **Accessibility:** the scoring UI should be accessible (the org runs accessibility initiatives).

---

## 15. Recommended tech stack (confirm, don't assume)

- **Frontend:** React + TypeScript (responsive web).
- **Backend:** Node.js/TypeScript **or** Python (FastAPI) — pick one.
- **Database:** PostgreSQL (Azure Database for PostgreSQL).
- **Auth:** Entra ID (MSAL / OpenID Connect).
- **Integrations:** JIRA REST API; Microsoft Graph (mail); a scheduler/queue for reminders and write-backs.
- **Deck generation:** a PPTX/PDF library driven from ticket data.
- **Hosting:** Azure App Service.

---

## 16. Phasing

**Phase 1 — Foundation (build first)**
- Domain model (§5); categories/thresholds as config (§6, §10).
- Committee management + Entra SSO + RBAC (§4).
- Rounds: create, add tickets (JIRA read; CSV/manual fallback), open/close.
- Ticket cards + coordinator-editable summaries; generate the distribution pack (§7).
- Native in-app scoring incl. the relevance question (§6, §8).
- Submission collection + the **exact** aggregation of §10 (average, sample std dev, discussion flag at >16, min-5 gate, priority ratio + bands, status labels).
- Coordinator dashboard (round status, submission progress) + finalised **feedback view** (§9).
- CSV export of results.

**Phase 2 — Automation & write-back**
- JIRA two-way sync: read the queue, write `business_score`, optional status transition.
- Automated distribution + reminder/escalation emails via Graph on the cadence.
- AI-assisted ticket-summary drafting from raw JIRA content.
- IDM stream switched on.

**Phase 3 — Insight**
- Cross-round trends, consensus analytics, category reporting.
- Effort/priority automation refinements.

---

## 17. Acceptance criteria — Foundation (Phase 1)

- A coordinator can create a round, add tickets with summary cards, generate the pack, and open the round.
- Committee members sign in with M365, score each ticket 0–10 across the seven categories, answer the relevance question, and add notes; they see only their own submissions while the round is open.
- The system computes, per ticket: `responses_count`, `business_score` = ROUND(AVERAGE of valid `Yes` submission totals, 0), sample `std_dev`, `discussion_required` (>16), `priority_ratio` (score ÷ effort) and band (≥6 High / ≥1.8 Medium / else Low), and the correct `status_label` — **matching the current spreadsheet on the same inputs.**
- Tickets with `< 5` valid submissions show "Awaiting WOSG Responses"; `Unsure`/`No` submissions are excluded from aggregates; a "No – can be closed" vote flags "To Close?".
- After finalisation, the committee can see the anonymised per-ticket feedback view.
- Results export to CSV even before JIRA write-back exists.
- All actions are audit-logged; access is role-enforced.

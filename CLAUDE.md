# Working on this repository

Business Impact Scoring (BIS). Node + TypeScript API in `server/`, React + Vite
UI in `web/`, one deployment. Built to `docs/BIS-App-Requirements-v0.2.md`;
every deliberate departure from it is recorded in `docs/decisions.md`.

## The user guide is part of the app, not documentation about it

`web/src/pages/GuidePage.tsx` is the **Guide** tab, and it is the only place the
committee and the coordinator are told how any of this works.

**Update it in the same commit as the change.** If a change alters anything a
user would notice — a new button, a renamed one, a rule that decides an outcome,
a setting, a message they will read, a step in the weekly cycle — the guide is
part of that change, not a follow-up. A guide that lags is worse than none: it
becomes a list of things that used to be true, and people stop believing the
parts that are still right.

Two habits keep it honest:

- **Say what it does, not what it is called.** "Below the minimum a ticket rolls
  over rather than being decided by two people" survives a rename; "press the
  Roll Over button" does not.
- **Derive from the code where you can.** The guide already reads `CARD_KINDS`
  and `labelsFor()` so the section labels cannot drift. Prefer that to retyping
  a list that will fall out of step.
- **Never type a configurable number into the prose.** The category count, the
  marks they run to, the minimum responses and the disagreement threshold are
  all editable in Settings, so "the seven categories" or "above 16" is a
  sentence that goes wrong the first time somebody edits them. The guide reads
  them from `api.scoringModel()` — which every signed-in member can call, unlike
  `api.config()`, which is coordinator-only and would show the committee the
  shipped defaults. Thread new ones through the same way.

The guide shows the scoring half to everyone and the running-it half only to
coordinators. Put new content in whichever half its reader belongs to.

## Conventions worth knowing before changing anything

- **Business rules are data, not literals.** Thresholds, categories, cadence and
  the automation switches live in `app_config` and are edited in Settings. If
  you find yourself typing `5` or `16`, it belongs in `domain/types.ts` as a
  default and in the config, per §5/§14 of the requirements.
- **Schema changes go in a migration**, never in `schema.sql`. The baseline is
  applied first and the migrations after it, so a column in both breaks a fresh
  database. See `db/migrations/`.
- **Zod strips what it does not declare.** Adding a field to a form means adding
  it to the route's schema too, or it is silently discarded on save. This has
  bitten once already — `routes/ticketSave.test.ts` guards it.
- **Automation never gets its own authority.** It calls the same service
  functions the buttons call. Doing a step by hand must never disable the next
  automated one; each step is claimed in `round_automation_log` so it runs
  exactly once.
- **Both SQL dialects.** Everything runs on PostgreSQL and SQLite. Use `?`
  placeholders; the driver rewrites them.
- **Comments explain why, not what.** The codebase is written to be read by
  someone deciding whether a change is safe.

## Before you say it works

- `npm run build` at the root — server and web.
- `npx vitest run` in `server/`.
- For anything a user touches, actually drive it: the app runs on SQLite with
  `DB_DRIVER=sqlite SQLITE_FILE=… SEED_ON_BOOT=demo AUTH_MODE=email`, and
  Playwright with `/opt/pw-browsers/chromium` will click through it.
- Report what you verified and what you did not. "Typechecks" is not "works".

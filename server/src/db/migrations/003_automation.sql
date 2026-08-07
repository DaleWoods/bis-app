-- §11/§12.2 run by the app instead of by a person.
--
-- opens_at gives a round a scoring window rather than just a deadline: the
-- committee can score between opens_at and cut_off_at. It is nullable, and a
-- round without one simply opens when someone opens it.
ALTER TABLE rounds ADD COLUMN opens_at TEXT;

-- A coordinator can freeze automation for one round - to hold a round open over
-- a bank holiday, say - without switching automation off for everything.
ALTER TABLE rounds ADD COLUMN automation_paused INTEGER NOT NULL DEFAULT 0;

-- Every automated step, recorded once. The unique key is what makes the
-- scheduler safe to run every minute: a step that has already run cannot run
-- again, whatever the clock does, and a restart mid-cycle resumes rather than
-- repeats. It doubles as the "what has the app done to this round" history.
CREATE TABLE IF NOT EXISTS round_automation_log (
  id          TEXT PRIMARY KEY,
  round_id    TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,          -- distribute | remind:48 | close | finalise | writeback
  ran_at      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS round_automation_log_once ON round_automation_log (round_id, action);

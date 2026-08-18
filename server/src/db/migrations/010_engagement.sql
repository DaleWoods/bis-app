-- A ticket automation is not confident enough to hand the committee yet -
-- cardWarnings() flagged it when automation was about to open the round. The
-- rest of the round still opens on time; this one waits for a coordinator.
ALTER TABLE round_tickets ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
ALTER TABLE round_tickets ADD COLUMN held_reason TEXT NOT NULL DEFAULT '';

-- How many times a step has been claimed, so a failure can be retried once
-- automatically before it is left for a person. 1 on the row's first claim,
-- so an already-running instance never looks like a fresh, untried step.
ALTER TABLE round_automation_log ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

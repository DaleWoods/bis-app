-- Rounds brought in from the manual spreadsheet. They were scored, decided and
-- written to JIRA by hand long before the app existed, so they are history
-- only: counted in Trends, the league table and streaks, but never acted on -
-- no write-back, no emails, no roll-over, no discussion alerts, no reopening.
ALTER TABLE rounds ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;

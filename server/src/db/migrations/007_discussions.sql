-- §10.4 discussion workflow.
--
-- When the committee's scores for a ticket are further apart than the spread
-- threshold, the app already refuses to send it for estimation and labels it
-- "Pending discussion". Until now that was the end of it: the coordinator ran
-- the meeting off-app and the app never learned what was decided, so the
-- score that went to JIRA was still the average of the two opinions nobody
-- agreed with.
--
-- One row per split ticket, holding what the meeting decided:
--   AGREED  - the committee talked and settled on a score. agreed_score is
--             what goes to JIRA (defaulting to the calculated average).
--   RESCORE - the ticket goes back to the committee in a later round. Nothing
--             is written to JIRA for it in this round.
--   CLOSE   - the committee decided it should not be done at all. No score.
-- An empty outcome means the meeting has not happened yet, which is what
-- holds the ticket back from write-back.
CREATE TABLE IF NOT EXISTS ticket_discussions (
  round_id     TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  meeting_at   TEXT,
  outcome      TEXT NOT NULL DEFAULT '',    -- '' | AGREED | RESCORE | CLOSE
  agreed_score INTEGER,
  note         TEXT NOT NULL DEFAULT '',
  opened_at    TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (round_id, ticket_id),
  FOREIGN KEY (round_id) REFERENCES rounds (id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_discussions_round ON ticket_discussions (round_id);

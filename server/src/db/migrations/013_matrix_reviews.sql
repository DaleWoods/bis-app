-- What was decided about a ticket singled out on the Value matrix, so the
-- same ticket is not questioned again every week. Keyed by JIRA key rather
-- than the app's ticket id: the matrix reads JIRA, and most of what it shows
-- was never in a round here. The score and effort are kept as they stood when
-- the decision was made, so a ticket that has since changed can come back.
CREATE TABLE IF NOT EXISTS matrix_reviews (
  id             TEXT PRIMARY KEY,
  ticket_key     TEXT NOT NULL,
  outcome        TEXT NOT NULL,            -- REQUESTED | KEPT | RESCORE | CLOSED
  note           TEXT NOT NULL DEFAULT '',
  business_score DOUBLE PRECISION,
  effort         DOUBLE PRECISION,
  actor_email    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matrix_reviews_key ON matrix_reviews (ticket_key);

-- One row a day of how many tickets sat in each box, so "is the backlog
-- getting healthier?" has an answer. The matrix itself is read live and never
-- stored; this is the only thing that remembers it.
CREATE TABLE IF NOT EXISTS matrix_snapshots (
  day          TEXT PRIMARY KEY,           -- YYYY-MM-DD
  source       TEXT NOT NULL,              -- jira | app
  value_split  DOUBLE PRECISION NOT NULL,
  effort_split DOUBLE PRECISION NOT NULL,
  counts       TEXT NOT NULL,              -- JSON {doNext, plan, fitIn, question, unestimated}
  effort_share TEXT NOT NULL DEFAULT '{}', -- JSON, share of total effort per box
  created_at   TEXT NOT NULL
);

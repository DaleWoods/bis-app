-- Business Impact Scoring (BIS) - core schema.
-- Written to be valid on both PostgreSQL (production, Azure) and SQLite (local dev).
-- Conventions: TEXT ids (uuid v4 strings), TEXT ISO-8601 timestamps, INTEGER 0/1 booleans.

CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,           -- JSON encoded
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

-- §6: categories are data, so they can be added/reworded/reweighted without a code change.
CREATE TABLE IF NOT EXISTS categories (
  id           TEXT PRIMARY KEY,
  position     INTEGER NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  zero_label   TEXT NOT NULL DEFAULT 'Not Impacted',
  max_label    TEXT NOT NULL DEFAULT 'Highly Impacted',
  weight       DOUBLE PRECISION NOT NULL DEFAULT 1,
  scale_min    INTEGER NOT NULL DEFAULT 0,
  scale_max    INTEGER NOT NULL DEFAULT 10,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  team          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'COMMITTEE',   -- ADMIN | COORDINATOR | COMMITTEE | VIEWER
  active        INTEGER NOT NULL DEFAULT 1,
  entra_oid     TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id                           TEXT PRIMARY KEY,
  jira_id                      TEXT NOT NULL UNIQUE,
  title                        TEXT NOT NULL,
  type                         TEXT NOT NULL DEFAULT '',
  jira_status                  TEXT NOT NULL DEFAULT '',
  created_date                 TEXT,
  stakeholder                  TEXT NOT NULL DEFAULT '',
  affects                      TEXT NOT NULL DEFAULT '',
  impacts                      TEXT NOT NULL DEFAULT '',
  workaround                   TEXT NOT NULL DEFAULT '',
  site_affected                TEXT NOT NULL DEFAULT '',
  original_testing_environment TEXT NOT NULL DEFAULT '',
  raw_description              TEXT NOT NULL DEFAULT '',
  -- §7 distribution pack / ticket card content (coordinator authored in foundation)
  exec_summary                 TEXT NOT NULL DEFAULT '',
  panel_current                TEXT NOT NULL DEFAULT '',
  panel_impacts                TEXT NOT NULL DEFAULT '',
  panel_future                 TEXT NOT NULL DEFAULT '',
  panel_benefits               TEXT NOT NULL DEFAULT '',
  screenshot_url               TEXT NOT NULL DEFAULT '',
  original_requestor           TEXT NOT NULL DEFAULT '',   -- email, drives §8 "isn't relevant today" rule
  stream                       TEXT NOT NULL DEFAULT 'ECOM',  -- ECOM | IDM (§12.4)
  backend_poker_score          DOUBLE PRECISION,
  frontend_poker_score         DOUBLE PRECISION,
  manual_effort                DOUBLE PRECISION,
  jira_synced_at               TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id                   TEXT PRIMARY KEY,
  week_label           TEXT NOT NULL,
  cut_off_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'DRAFT',   -- DRAFT | OPEN | CLOSED | FINALISED
  stream               TEXT NOT NULL DEFAULT 'ECOM',
  notes                TEXT NOT NULL DEFAULT '',
  distribution_sent_at TEXT,
  opened_at            TEXT,
  closed_at            TEXT,
  finalised_at         TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS round_tickets (
  round_id   TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (round_id, ticket_id),
  FOREIGN KEY (round_id) REFERENCES rounds (id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submissions (
  id             TEXT PRIMARY KEY,
  round_id       TEXT NOT NULL,
  ticket_id      TEXT NOT NULL,
  member_id      TEXT NOT NULL,
  relevance      TEXT NOT NULL,            -- YES | UNSURE | NO_CLOSE | NO_NOT_RELEVANT_TODAY (§8)
  closure_reason TEXT NOT NULL DEFAULT '',
  closure_info   TEXT NOT NULL DEFAULT '',
  more_info      TEXT NOT NULL DEFAULT '',
  archived       INTEGER NOT NULL DEFAULT 0,  -- legacy/archived scores never count (§10.1)
  submitted_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (round_id, ticket_id, member_id),
  FOREIGN KEY (round_id) REFERENCES rounds (id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submission_scores (
  submission_id TEXT NOT NULL,
  category_id   TEXT NOT NULL,
  score         INTEGER NOT NULL,
  PRIMARY KEY (submission_id, category_id),
  FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
);

-- Snapshot written at finalisation: keeps finalised rounds immutable for the
-- Phase 3 trend work (§14 data retention) and is the source for JIRA write-back.
CREATE TABLE IF NOT EXISTS ticket_results (
  round_id            TEXT NOT NULL,
  ticket_id           TEXT NOT NULL,
  responses_count     INTEGER NOT NULL,
  business_score      INTEGER,
  std_dev             DOUBLE PRECISION,
  discussion_required INTEGER NOT NULL DEFAULT 0,
  to_close            INTEGER NOT NULL DEFAULT 0,
  effort              DOUBLE PRECISION,
  priority_ratio      DOUBLE PRECISION,
  priority_band       TEXT,
  status_label        TEXT NOT NULL DEFAULT '',
  send_for_estimation INTEGER NOT NULL DEFAULT 0,
  category_averages   TEXT NOT NULL DEFAULT '{}',   -- JSON {categoryId: average}
  computed_at         TEXT NOT NULL,
  PRIMARY KEY (round_id, ticket_id),
  FOREIGN KEY (round_id) REFERENCES rounds (id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_log (
  id          TEXT PRIMARY KEY,
  round_id    TEXT,
  member_id   TEXT,
  kind        TEXT NOT NULL,             -- DISTRIBUTION | REMINDER | ESCALATION
  to_address  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL,             -- SENT | FAILED | SUPPRESSED
  error       TEXT NOT NULL DEFAULT '',
  sent_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jira_writebacks (
  id              TEXT PRIMARY KEY,
  round_id        TEXT NOT NULL,
  ticket_id       TEXT NOT NULL,
  jira_id         TEXT NOT NULL,
  business_score  INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,   -- round+ticket+score: re-running never double-writes
  status          TEXT NOT NULL,          -- PENDING | SUCCESS | FAILED | SKIPPED
  attempts        INTEGER NOT NULL DEFAULT 0,
  transitioned_to TEXT NOT NULL DEFAULT '',
  error           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor_id    TEXT,
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_submissions_round ON submissions (round_id);
CREATE INDEX IF NOT EXISTS idx_submissions_round_ticket ON submissions (round_id, ticket_id);
CREATE INDEX IF NOT EXISTS idx_submissions_member ON submissions (member_id);
CREATE INDEX IF NOT EXISTS idx_round_tickets_round ON round_tickets (round_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS idx_email_log_round ON email_log (round_id);
CREATE INDEX IF NOT EXISTS idx_jira_writebacks_round ON jira_writebacks (round_id);

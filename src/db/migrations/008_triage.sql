-- AI triage: per-workspace settings and one result row per triaged ticket.
-- Triage only reads filed tickets; the submissions table and the filing queue are unchanged.

CREATE TABLE triage_settings (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 0,
  -- Only tickets filed after triage was switched on are triaged.
  enabled_at        INTEGER,
  triage_config     TEXT NOT NULL DEFAULT '{}',
  -- Set when triage stops for a reason an admin has to fix (bad key, no credits, model gone).
  paused_reason     TEXT,
  paused_detail     TEXT,
  paused_at         INTEGER,
  -- Claude API key, encrypted with ENCRYPTION_KEY. Never returned to the browser.
  api_key_enc       TEXT,
  api_key_hint      TEXT,
  api_key_added_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  api_key_added_at  INTEGER,
  updated_at        INTEGER NOT NULL DEFAULT (now_ms())
);

CREATE TABLE triage_results (
  submission_id     TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  lease_owner       TEXT,
  lease_until_at    INTEGER,
  model             TEXT,
  -- The validated model answer, the actions applied on GitHub, and suggestions awaiting review.
  verdict           TEXT,
  applied_actions   TEXT,
  suggestions       TEXT,
  -- Flat copies for inbox filters.
  priority          TEXT,
  is_duplicate      INTEGER NOT NULL DEFAULT 0,
  is_spam           INTEGER NOT NULL DEFAULT 0,
  suggestion_count  INTEGER NOT NULL DEFAULT 0,
  skip_reason       TEXT,
  error             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (now_ms()),
  updated_at        INTEGER NOT NULL DEFAULT (now_ms()),
  completed_at      INTEGER
);

CREATE INDEX triage_results_due_idx ON triage_results(status, next_attempt_at);
CREATE INDEX triage_results_workspace_idx ON triage_results(workspace_id, completed_at);

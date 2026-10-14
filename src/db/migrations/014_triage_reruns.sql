-- Re-running triage on tickets already filed: a preview that never touches GitHub (to try
-- settings and compare them), or a run that applies its results like normal triage does.
CREATE TABLE triage_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT,                                -- optional, to tell runs apart ("Stricter duplicates")
  mode          TEXT NOT NULL CHECK (mode IN ('preview', 'apply')),
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'cancelled')),
  scope         TEXT NOT NULL DEFAULT '{}',          -- which tickets were picked (JSON)
  config_used   TEXT NOT NULL,                       -- the triage settings the run used (JSON)
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (now_ms()),
  finished_at   INTEGER,
  applied_at    INTEGER,                             -- a preview's results applied afterwards
  applied_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX triage_runs_workspace_idx ON triage_runs(workspace_id, created_at DESC);

CREATE TABLE triage_run_items (
  run_id         TEXT NOT NULL REFERENCES triage_runs(id) ON DELETE CASCADE,
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  lease_until_at INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  verdict        TEXT,
  auto_actions   TEXT,                               -- what is (or would be) applied automatically
  suggestions    TEXT,
  before         TEXT,                               -- the ticket's triage result when the run started
  note           TEXT,                               -- why it was skipped or failed
  -- Applying: right away in an "apply" run, or when a preview's results are applied.
  apply_status   TEXT CHECK (apply_status IN ('pending', 'done', 'skipped', 'failed')),
  apply_note     TEXT,
  model          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  completed_at   INTEGER,
  PRIMARY KEY (run_id, submission_id)
);
CREATE INDEX triage_run_items_pending_idx ON triage_run_items(status, run_id);
CREATE INDEX triage_run_items_apply_idx ON triage_run_items(apply_status, run_id);

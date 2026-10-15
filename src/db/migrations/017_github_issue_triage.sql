-- AI triage for issues opened directly on GitHub (not through Discord). Off until an admin
-- turns it on; only issues opened after that are queued (older ones through re-runs).
ALTER TABLE triage_settings ADD COLUMN github_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE triage_settings ADD COLUMN github_enabled_at INTEGER;

-- The triage result of each issue opened on GitHub. The same columns as triage_results;
-- issues aren't tickets, so they're kept apart from submissions.
CREATE TABLE issue_triage (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id           INTEGER NOT NULL,
  number            INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  lease_owner       TEXT,
  lease_until_at    INTEGER,
  model             TEXT,
  verdict           TEXT,
  applied_actions   TEXT,
  suggestions       TEXT,
  priority          TEXT,
  is_duplicate      INTEGER NOT NULL DEFAULT 0,
  is_spam           INTEGER NOT NULL DEFAULT 0,
  is_support        INTEGER NOT NULL DEFAULT 0,
  suggestion_count  INTEGER NOT NULL DEFAULT 0,
  skip_reason       TEXT,
  error             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (now_ms()),
  updated_at        INTEGER NOT NULL DEFAULT (now_ms()),
  completed_at      INTEGER,
  UNIQUE (workspace_id, repo_id, number)
);
CREATE INDEX issue_triage_due_idx ON issue_triage(status, next_attempt_at);
CREATE INDEX issue_triage_workspace_idx ON issue_triage(workspace_id, completed_at);

-- What happened to an issue's triage (triaged, applied, dismissed), for its page in the console.
CREATE TABLE issue_triage_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  triage_id  TEXT NOT NULL REFERENCES issue_triage(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  at         INTEGER NOT NULL DEFAULT (now_ms())
);
CREATE INDEX issue_triage_events_idx ON issue_triage_events(triage_id, id);

-- Re-run items can now be a ticket ('sub:<submission id>') or an issue opened on GitHub
-- ('gh:<repo id>:<number>'). SQLite can't change a primary key in place, so the table is rebuilt.
CREATE TABLE triage_run_items_new (
  run_id            TEXT NOT NULL REFERENCES triage_runs(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  submission_id     TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  gh_repo_id        INTEGER,
  gh_number         INTEGER,
  position          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  lease_until_at    INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  verdict           TEXT,
  auto_actions      TEXT,
  suggestions       TEXT,
  before            TEXT,
  note              TEXT,
  apply_status      TEXT CHECK (apply_status IN ('pending', 'done', 'skipped', 'failed')),
  apply_note        TEXT,
  model             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  completed_at      INTEGER,
  change            TEXT CHECK (change IN ('changed', 'new', 'same')),
  apply_suggestions INTEGER NOT NULL DEFAULT 0,
  apply_done_at     INTEGER,
  apply_inbox_only  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, subject)
);
INSERT INTO triage_run_items_new (run_id, subject, submission_id, position, status, lease_until_at, attempts, next_attempt_at, verdict, auto_actions, suggestions,
    before, note, apply_status, apply_note, model, input_tokens, output_tokens, completed_at, change, apply_suggestions, apply_done_at, apply_inbox_only)
  SELECT run_id, 'sub:' || submission_id, submission_id, position, status, lease_until_at, attempts, next_attempt_at, verdict, auto_actions, suggestions,
    before, note, apply_status, apply_note, model, input_tokens, output_tokens, completed_at, change, apply_suggestions, apply_done_at, apply_inbox_only
  FROM triage_run_items;
DROP TABLE triage_run_items;
ALTER TABLE triage_run_items_new RENAME TO triage_run_items;
CREATE INDEX triage_run_items_pending_idx ON triage_run_items(status, run_id);
CREATE INDEX triage_run_items_apply_idx ON triage_run_items(apply_status, run_id);
CREATE INDEX triage_run_items_run_idx ON triage_run_items(run_id, position);

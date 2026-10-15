-- When a paused triage was last checked (out of credits is checked every few minutes, so it
-- carries on by itself once credits are added).
ALTER TABLE triage_settings ADD COLUMN paused_checked_at INTEGER;

-- Settings for the whole server (one row). Dev mode: while it's on, process restarts (deploys)
-- aren't counted on Server health; turning it off starts counting again from zero.
CREATE TABLE server_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  dev_mode_on_at   INTEGER,                                          -- NULL while dev mode is off
  dev_mode_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  dev_mode_off_at  INTEGER,                                          -- restarts before this aren't counted
  updated_at       INTEGER NOT NULL DEFAULT (now_ms())
);
INSERT INTO server_settings (id) VALUES (1);

-- Triage › Activity also notes when triage pauses and carries on (source 'system'). SQLite can't
-- change a CHECK in place, so the table is rebuilt.
CREATE TABLE triage_log_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  at             INTEGER NOT NULL DEFAULT (now_ms()),
  -- ticket: a new Discord ticket; github: a new issue opened on GitHub; preview / rerun: a re-run
  -- (preview, or applying); review: someone pressed Apply or Dismiss; system: triage paused or
  -- carried on.
  source         TEXT NOT NULL CHECK (source IN ('ticket', 'github', 'preview', 'rerun', 'review', 'system')),
  result         TEXT NOT NULL CHECK (result IN ('ok', 'failed', 'skipped', 'info')),
  submission_id  TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  repo_id        INTEGER,
  number         INTEGER,
  ref            TEXT,
  run_id         TEXT REFERENCES triage_runs(id) ON DELETE SET NULL,
  by_user        TEXT REFERENCES users(id) ON DELETE SET NULL,
  message        TEXT,
  detail         TEXT NOT NULL DEFAULT '{}',
  bulk_id        TEXT REFERENCES triage_bulk(id) ON DELETE SET NULL
);
INSERT INTO triage_log_new (id, workspace_id, at, source, result, submission_id, repo_id, number, ref, run_id, by_user, message, detail, bulk_id)
  SELECT id, workspace_id, at, source, result, submission_id, repo_id, number, ref, run_id, by_user, message, detail, bulk_id FROM triage_log;
DROP TABLE triage_log;
ALTER TABLE triage_log_new RENAME TO triage_log;
CREATE INDEX triage_log_workspace_idx ON triage_log(workspace_id, id DESC);
CREATE INDEX triage_log_run_idx ON triage_log(run_id, id DESC);
CREATE INDEX triage_log_at_idx ON triage_log(at);
CREATE INDEX triage_log_bulk_idx ON triage_log(bulk_id, id DESC);

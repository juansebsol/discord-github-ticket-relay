-- Triage status: how many suggestions were dismissed, so "reviewed, nothing applied" can be told
-- apart from "nothing to do". Filled in from the activity recorded so far.
ALTER TABLE triage_results ADD COLUMN dismissed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE issue_triage ADD COLUMN dismissed_count INTEGER NOT NULL DEFAULT 0;
UPDATE triage_results SET dismissed_count = (SELECT count(*) FROM submission_events e WHERE e.submission_id = triage_results.submission_id AND e.kind = 'triage_dismissed');
UPDATE issue_triage SET dismissed_count = (SELECT count(*) FROM issue_triage_events e WHERE e.triage_id = issue_triage.id AND e.kind = 'triage_dismissed');

-- Everything triage does, in one place (Triage › Activity): what it triaged, applied, suggested,
-- skipped or couldn't do, and why. Kept 90 days. No ticket text is stored, only references.
CREATE TABLE triage_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  at             INTEGER NOT NULL DEFAULT (now_ms()),
  -- ticket: a new Discord ticket; github: a new issue opened on GitHub; preview / rerun: a re-run
  -- (preview, or applying); review: someone pressed Apply or Dismiss.
  source         TEXT NOT NULL CHECK (source IN ('ticket', 'github', 'preview', 'rerun', 'review')),
  result         TEXT NOT NULL CHECK (result IN ('ok', 'failed', 'skipped', 'info')),
  submission_id  TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  repo_id        INTEGER,
  number         INTEGER,
  ref            TEXT,                               -- TR-… or owner/repo#12, for display
  run_id         TEXT REFERENCES triage_runs(id) ON DELETE SET NULL,
  by_user        TEXT REFERENCES users(id) ON DELETE SET NULL,
  message        TEXT,                               -- the reason, for skips, failures and waits
  detail         TEXT NOT NULL DEFAULT '{}'          -- the actions applied, suggested or dismissed (JSON)
);
CREATE INDEX triage_log_workspace_idx ON triage_log(workspace_id, id DESC);
CREATE INDEX triage_log_run_idx ON triage_log(run_id, id DESC);
CREATE INDEX triage_log_at_idx ON triage_log(at);

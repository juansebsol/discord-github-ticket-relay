-- AI triage › Knowledge, live: every "Write all", "Update now" or scheduled update is a run the
-- console follows while Claude writes (the Live studio, and its pill on every page), and can stop.
CREATE TABLE knowledge_runs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Who started it; null: Keep them up to date.
  started_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at   INTEGER NOT NULL DEFAULT (now_ms()),
  finished_at  INTEGER,
  stopped_at   INTEGER,
  stopped_by   TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX knowledge_runs_workspace_idx ON knowledge_runs(workspace_id, started_at);

-- Each app's part in its latest run, and what the live view shows while Claude writes it.
ALTER TABLE app_knowledge ADD COLUMN auto_run_id TEXT REFERENCES knowledge_runs(id) ON DELETE SET NULL;
ALTER TABLE app_knowledge ADD COLUMN auto_started_at INTEGER;
ALTER TABLE app_knowledge ADD COLUMN auto_finished_at INTEGER;
-- JSON: the steps and their times, log lines, the text so far, answers as they come, tokens, result.
ALTER TABLE app_knowledge ADD COLUMN auto_live TEXT;
-- Someone pressed Stop: the worker lets go of it at its next update.
ALTER TABLE app_knowledge ADD COLUMN auto_cancel INTEGER NOT NULL DEFAULT 0;
CREATE INDEX app_knowledge_run_idx ON app_knowledge(auto_run_id);

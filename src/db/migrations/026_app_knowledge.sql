-- AI triage › Knowledge: a TRIAGE.md per app, written by the team and read by Claude with every
-- ticket (known issues, what works as intended, versions, names members use). Kept here, not in
-- the repository, so it needs no GitHub permissions and members never see it.
CREATE TABLE app_knowledge (
  app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body          TEXT NOT NULL DEFAULT '',
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL DEFAULT (now_ms()),
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);
CREATE INDEX app_knowledge_workspace_idx ON app_knowledge(workspace_id);

-- What Claude says would have made it surer (its missing_context answer), copied out of the
-- verdict like priority, so Knowledge can list each app's questions without reading every verdict.
-- Team-only: never used in comments or member messages.
ALTER TABLE triage_results ADD COLUMN question TEXT;
ALTER TABLE issue_triage ADD COLUMN question TEXT;
CREATE INDEX triage_results_question_idx ON triage_results(workspace_id, completed_at) WHERE question IS NOT NULL;
CREATE INDEX issue_triage_question_idx ON issue_triage(workspace_id, completed_at) WHERE question IS NOT NULL;

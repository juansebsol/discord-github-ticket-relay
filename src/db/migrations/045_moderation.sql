-- Moderation: Ticket management, the Mod log and Replies & reasons. Off until an admin turns it
-- on; moderators get none of its pages until an admin gives them.
CREATE TABLE moderation_settings (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  enabled_at    INTEGER,
  reasons       TEXT NOT NULL DEFAULT '{}',          -- per close reason: on, label, comment (JSON)
  replies       TEXT,                                -- saved replies [{ id, name, text }]; null: the defaults
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);

-- What moderators did, for the Mod log, undo and the "Closed by mods" list. The team's note is
-- kept here and never sent to GitHub.
CREATE TABLE mod_actions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                       -- close, reopen, duplicate, not_duplicate, reply, labels, pin
  repo_id       INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  title         TEXT NOT NULL DEFAULT '',
  reason        TEXT,                                -- close: the reason's key
  duplicate_of  INTEGER,
  note          TEXT,
  comment_id    INTEGER,                             -- the comment the app posted (undo deletes it)
  detail        TEXT NOT NULL DEFAULT '{}',
  job_id        TEXT,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  at            INTEGER NOT NULL DEFAULT (now_ms()),
  undone_at     INTEGER,
  undone_by     TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX mod_actions_workspace_idx ON mod_actions(workspace_id, at DESC);
CREATE INDEX mod_actions_issue_idx ON mod_actions(repo_id, number, at DESC);

-- Closing several at once runs in the background, one issue at a time.
CREATE TABLE mod_jobs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reason           TEXT NOT NULL,
  duplicate_of     INTEGER,
  post_comment     INTEGER NOT NULL DEFAULT 1,
  note             TEXT,
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'stopped')),
  waiting_until_at INTEGER,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL DEFAULT (now_ms()),
  finished_at      INTEGER
);
CREATE INDEX mod_jobs_workspace_idx ON mod_jobs(workspace_id, created_at DESC);

CREATE TABLE mod_job_items (
  job_id         TEXT NOT NULL REFERENCES mod_jobs(id) ON DELETE CASCADE,
  repo_id        INTEGER NOT NULL,
  number         INTEGER NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  note           TEXT,
  lease_until_at INTEGER,
  done_at        INTEGER,
  PRIMARY KEY (job_id, repo_id, number)
);
CREATE INDEX mod_job_items_pending_idx ON mod_job_items(status, job_id);

-- Ticket management lists open issues, newest activity first.
CREATE INDEX issue_index_state_idx ON issue_index(repo_id, state, updated_at DESC);

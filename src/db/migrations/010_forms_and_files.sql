-- Form builder: each ticket type can have its own form (JSON list of sections).
-- NULL means the built-in default for that kind of type.
ALTER TABLE ticket_types ADD COLUMN form TEXT;

-- Files attached to tickets: uploaded by members in the Discord form, or added by the
-- team in the console. The file itself lives on disk (FILES_DIR) under its random ID,
-- which is also its public link.
CREATE TABLE ticket_files (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  submission_id   TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('member', 'team')),
  added_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  filename        TEXT NOT NULL,                     -- cleaned display name
  kind            TEXT CHECK (kind IN ('image', 'video')),
  content_type    TEXT,
  ext             TEXT,
  size            INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'failed', 'deleted')),
  source_url_enc  TEXT,                              -- encrypted Discord link; cleared after download
  error           TEXT,
  delete_reason   TEXT CHECK (delete_reason IN ('manual', 'cleanup', 'spam')),
  deleted_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at      INTEGER,
  stored_at       INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (now_ms())
);
CREATE INDEX ticket_files_submission_idx ON ticket_files(submission_id, created_at);
CREATE INDEX ticket_files_workspace_idx ON ticket_files(workspace_id, status);

-- The GitHub issue's state as last seen by a files scan (used by the cleanup rules).
ALTER TABLE submissions ADD COLUMN issue_state TEXT CHECK (issue_state IN ('open', 'closed', 'missing'));
ALTER TABLE submissions ADD COLUMN issue_state_reason TEXT;
ALTER TABLE submissions ADD COLUMN issue_closed_at INTEGER;
ALTER TABLE submissions ADD COLUMN issue_checked_at INTEGER;

-- Cleanup rules and storage limit per workspace. Automatic cleanup is off until an admin turns it on.
CREATE TABLE file_settings (
  workspace_id      TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  auto_cleanup      INTEGER NOT NULL DEFAULT 0,
  closed_enabled    INTEGER NOT NULL DEFAULT 1,
  closed_days       INTEGER NOT NULL DEFAULT 30 CHECK (closed_days BETWEEN 0 AND 3650),
  spam_enabled      INTEGER NOT NULL DEFAULT 1,
  age_enabled       INTEGER NOT NULL DEFAULT 0,
  age_days          INTEGER NOT NULL DEFAULT 180 CHECK (age_days BETWEEN 1 AND 3650),
  storage_limit_mb  INTEGER NOT NULL DEFAULT 2048 CHECK (storage_limit_mb BETWEEN 100 AND 1048576),
  last_run_at       INTEGER,
  last_run_summary  TEXT,
  last_scan_at      INTEGER,
  updated_at        INTEGER NOT NULL DEFAULT (now_ms())
);

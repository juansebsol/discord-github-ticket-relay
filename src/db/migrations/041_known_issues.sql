-- Bot features › Known issues: one Discord message the bot keeps up to date with the problems
-- members report most (Discord tickets, duplicates counted for their original) and what's
-- happening with each: being worked on, fix coming, fixed in a release. Off until turned on.
CREATE TABLE known_issues_settings (
  workspace_id         TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled              INTEGER NOT NULL DEFAULT 0,
  channel_id           TEXT,
  channel_name         TEXT,
  app_ids              TEXT,                              -- JSON list of app ids; null: every app
  period               TEXT NOT NULL DEFAULT '30d',       -- reports counted over 7d, 30d, 90d or all
  min_reports          INTEGER NOT NULL DEFAULT 2,
  max_issues           INTEGER NOT NULL DEFAULT 10,
  fixed_days           INTEGER NOT NULL DEFAULT 14,       -- fixed ones stay this long (0: left off)
  include_private      INTEGER NOT NULL DEFAULT 0,        -- issues of private repositories (no links)
  group_by_app         INTEGER NOT NULL DEFAULT 1,
  show_counts          INTEGER NOT NULL DEFAULT 1,
  title_text           TEXT,                              -- texts; null = the default
  intro_text           TEXT,
  empty_text           TEXT,
  status_text          TEXT,                              -- JSON { open, working, coming, released, fixed }
  report_button        INTEGER NOT NULL DEFAULT 1,        -- a button to the ticket panel's channel
  report_button_label  TEXT,
  updated_at           INTEGER NOT NULL DEFAULT (now_ms())
);

-- The team's say over single issues: always on the board, never on it, shown under another title,
-- or with a note (a workaround) under it.
CREATE TABLE known_issue_overrides (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id       INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  title         TEXT,
  note          TEXT,
  updated_at    INTEGER NOT NULL DEFAULT (now_ms()),
  PRIMARY KEY (workspace_id, repo_id, number)
);

-- The posted message, and when its content last changed (it's edited only then).
CREATE TABLE known_issue_boards (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  issue_count   INTEGER NOT NULL DEFAULT 0,         -- issues on it when it last changed
  status        TEXT NOT NULL DEFAULT 'published',  -- published or missing (deleted in Discord)
  published_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at  INTEGER NOT NULL DEFAULT (now_ms()),
  changed_at    INTEGER NOT NULL DEFAULT (now_ms()),
  checked_at    INTEGER,
  error         TEXT
);

-- Release announcements: a Discord post when an app publishes a GitHub release. Off until a
-- workspace turns it on; only releases published after that are announced.
CREATE TABLE announcement_settings (
  workspace_id        TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 0,
  enabled_at          INTEGER,
  mode                TEXT NOT NULL DEFAULT 'review',   -- review (wait for someone to post it) or auto
  channel_id          TEXT,
  channel_name        TEXT,
  include_prereleases INTEGER NOT NULL DEFAULT 0,
  notes_source        TEXT NOT NULL DEFAULT 'claude',   -- claude (friendlier notes) or github (as written)
  notes_instructions  TEXT,                             -- extra instructions for Claude
  message_text        TEXT,                             -- templates; null = the default
  title_text          TEXT,
  body_text           TEXT,
  download_buttons    INTEGER NOT NULL DEFAULT 1,
  ping_enabled        INTEGER NOT NULL DEFAULT 0,
  role_id             TEXT,
  role_name           TEXT,
  panel_title         TEXT,
  panel_intro         TEXT,
  updated_at          INTEGER NOT NULL DEFAULT (now_ms())
);

-- Per app: whether it's announced, and its own channel or role instead of the workspace's.
CREATE TABLE announcement_apps (
  app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  channel_id    TEXT,                                   -- null: the workspace's channel
  channel_name  TEXT,
  role_mode     TEXT NOT NULL DEFAULT 'default',        -- default, none (no ping) or role
  role_id       TEXT,
  role_name     TEXT
);

-- Each release to announce (one per repository and tag), its notes and its post.
CREATE TABLE announcements (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id           TEXT REFERENCES apps(id) ON DELETE SET NULL,
  app_name         TEXT NOT NULL,
  repo_id          INTEGER NOT NULL,
  repo_owner       TEXT NOT NULL,
  repo_name        TEXT NOT NULL,
  tag              TEXT NOT NULL,
  release_name     TEXT,
  release_url      TEXT NOT NULL,
  published_at     INTEGER,
  prerelease       INTEGER NOT NULL DEFAULT 0,
  github_notes     TEXT NOT NULL DEFAULT '',             -- the release notes as written on GitHub
  release_files    TEXT NOT NULL DEFAULT '[]',           -- [{ name, url }]
  notes            TEXT,                                 -- what's posted as {notes}
  notes_by         TEXT,                                 -- claude, github or edited
  notes_error      TEXT,                                 -- why Claude's notes weren't used
  manual           INTEGER NOT NULL DEFAULT 0,           -- added by someone (always waits to be posted)
  status           TEXT NOT NULL,                        -- writing, waiting, posting, posted, failed, skipped
  channel_id       TEXT,
  message_id       TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  lease_until_at   INTEGER,
  posted_at        INTEGER,
  posted_by        TEXT REFERENCES users(id) ON DELETE SET NULL,  -- null: posted automatically
  created_at       INTEGER NOT NULL DEFAULT (now_ms()),
  updated_at       INTEGER NOT NULL DEFAULT (now_ms()),
  UNIQUE (workspace_id, repo_id, tag)
);
CREATE INDEX announcements_list_idx ON announcements(workspace_id, created_at);
CREATE INDEX announcements_due_idx ON announcements(status, next_attempt_at);

-- When each workspace last checked each repository for new releases.
CREATE TABLE announcement_checks (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id         INTEGER NOT NULL,
  checked_at      INTEGER,
  error           TEXT,
  lease_until_at  INTEGER,
  PRIMARY KEY (workspace_id, repo_id)
);

-- The "Get update pings" message: buttons members click to add or remove a role.
CREATE TABLE announcement_panels (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'published',   -- published or missing
  published_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at  INTEGER NOT NULL DEFAULT (now_ms())
);

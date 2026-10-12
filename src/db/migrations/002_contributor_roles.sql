-- Contributor roles: a second Discord panel where members prove (via GitHub sign-in) that
-- they contributed to an app's repository and receive a Discord role. Additive only; the
-- ticket tables are untouched apart from one new column on apps.

-- Allow a new one-time state purpose. SQLite can't alter a CHECK constraint, so the
-- (short-lived) table is rebuilt with its rows copied over.
CREATE TABLE oauth_states_new (
  state_hash   TEXT PRIMARY KEY,
  purpose      TEXT NOT NULL CHECK (purpose IN ('discord_login', 'discord_bot', 'github_install', 'contributor_verify')),
  session_id   TEXT,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  data         TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL DEFAULT (now_ms()),
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
INSERT INTO oauth_states_new SELECT state_hash, purpose, session_id, workspace_id, data, created_at, expires_at, used_at FROM oauth_states;
DROP TABLE oauth_states;
ALTER TABLE oauth_states_new RENAME TO oauth_states;

-- Which apps can be verified against (independent of whether they accept tickets).
ALTER TABLE apps ADD COLUMN contributor_enabled INTEGER NOT NULL DEFAULT 0;

-- One contributor role and panel channel per workspace.
CREATE TABLE contributor_settings (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  role_id       TEXT,
  role_name     TEXT,
  channel_id    TEXT,
  channel_name  TEXT,
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);

-- The published contributor panel message (separate from the ticket panel).
CREATE TABLE contributor_panels (
  workspace_id     TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'missing')),
  published_at     INTEGER NOT NULL DEFAULT (now_ms()),
  published_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_error       TEXT
);

-- One GitHub account can be linked to only one Discord member per workspace (no alts).
CREATE TABLE contributor_links (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_user_id   INTEGER NOT NULL,
  github_login     TEXT NOT NULL,
  discord_user_id  TEXT NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (now_ms()),
  PRIMARY KEY (workspace_id, github_user_id)
);

-- Audit trail of every verification attempt.
CREATE TABLE contributor_verifications (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id            TEXT REFERENCES apps(id) ON DELETE SET NULL,
  app_name          TEXT NOT NULL,
  repo_owner        TEXT NOT NULL,
  repo_name         TEXT NOT NULL,
  discord_user_id   TEXT NOT NULL,
  discord_name      TEXT NOT NULL,
  github_user_id    INTEGER,
  github_login      TEXT,
  result            TEXT NOT NULL CHECK (result IN ('verified', 'not_contributor', 'conflict', 'error')),
  method            TEXT CHECK (method IN ('merged_pr', 'commit')),
  info              TEXT,                   -- admin-facing explanation (plain text)
  revoked_at        INTEGER,
  revoked_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL DEFAULT (now_ms())
);
CREATE INDEX contributor_verifications_ws_idx ON contributor_verifications(workspace_id, created_at DESC);
CREATE INDEX contributor_verifications_user_idx ON contributor_verifications(workspace_id, discord_user_id, created_at DESC);

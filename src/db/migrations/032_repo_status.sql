-- Repo status: a table of each watched repository (open PRs and issues, recent activity, builds)
-- and what to fix first, polled with GitHub GraphQL, one repository at a time. Off by default.
CREATE TABLE repo_status_settings (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  -- The repositories shown, in order ([{id, owner, name}]); null: the apps' repositories.
  repos         TEXT,
  every_minutes INTEGER NOT NULL DEFAULT 15,
  -- "Refresh now": repositories last read before this are read again.
  refresh_at    INTEGER,
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);

-- What was last read for each repository (shared by the workspaces that watch it).
CREATE TABLE repo_status (
  repo_id         INTEGER PRIMARY KEY,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  -- What the page shows (JSON), and the recent commit authors, PRs and issues kept between reads.
  stats           TEXT,
  raw             TEXT,
  -- The repository's app icon (assets/app-icon/hicolor/64x64/apps/*.png), base64, and its blob id.
  icon            TEXT,
  icon_oid        TEXT,
  fetched_at      INTEGER,
  checked_at      INTEGER,
  error           TEXT,
  -- GitHub's GraphQL budget for the installation, as of this read.
  budget          INTEGER,
  budget_reset_at INTEGER,
  lease_until_at  INTEGER
);

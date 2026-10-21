-- Analytics: downloads over time, with tickets, issues, pull requests and stars. Off until a
-- workspace turns it on; downloads are recorded from then on (GitHub only keeps running totals).
CREATE TABLE analytics_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0,
  enabled_at   INTEGER,
  updated_at   INTEGER NOT NULL DEFAULT (now_ms())
);

-- Every release file of the recorded repositories: what it is, and its running total on GitHub.
CREATE TABLE download_assets (
  id            INTEGER PRIMARY KEY,
  repo_id       INTEGER NOT NULL,
  release       TEXT NOT NULL,                  -- the release's tag
  name          TEXT NOT NULL,                  -- the file name
  published_at  INTEGER,
  prerelease    INTEGER NOT NULL DEFAULT 0,
  platform      TEXT NOT NULL,                  -- windows, macos, linux, freebsd, web, other
  arch          TEXT,                           -- x64, x86, arm64, riscv64, universal
  format        TEXT,                           -- msi, dmg, AppImage, deb, flatpak, zip…
  kind          TEXT NOT NULL,                  -- app, cli, web; meta (checksums, update data) isn't a download
  total         INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (repo_id, release, name)
);

-- Downloads per 30 minutes: how much each file's total grew in that slot (only slots that grew).
-- Kept 32 days; older slots are added up per day into download_days.
CREATE TABLE download_counts (
  asset_id  INTEGER NOT NULL REFERENCES download_assets(id) ON DELETE CASCADE,
  slot_at   INTEGER NOT NULL,
  downloads INTEGER NOT NULL,
  PRIMARY KEY (asset_id, slot_at)
);
CREATE INDEX download_counts_slot_idx ON download_counts(slot_at);
CREATE TABLE download_days (
  asset_id  INTEGER NOT NULL REFERENCES download_assets(id) ON DELETE CASCADE,
  day_at    INTEGER NOT NULL,                   -- UTC midnight
  downloads INTEGER NOT NULL,
  PRIMARY KEY (asset_id, day_at)
);
CREATE INDEX download_days_day_idx ON download_days(day_at);

-- Per repository: when recording began (nothing is known before it), the last slot read, and stars.
CREATE TABLE download_sync (
  repo_id          INTEGER PRIMARY KEY,
  owner            TEXT NOT NULL,
  name             TEXT NOT NULL,
  installation_id  INTEGER NOT NULL,
  started_at       INTEGER NOT NULL,
  last_slot_at     INTEGER,
  checked_at       INTEGER,
  error            TEXT,
  stars_loaded_at  INTEGER,                     -- the star history was read back to the first one
  stars_until_at   INTEGER,                     -- newest star seen
  lease_until_at   INTEGER
);

-- Stars, with when each person starred (GitHub keeps that, so the history goes back to the first).
CREATE TABLE repo_stars (
  repo_id    INTEGER NOT NULL,
  login      TEXT NOT NULL,
  starred_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, login)
);
CREATE INDEX repo_stars_at_idx ON repo_stars(repo_id, starred_at);

-- AI triage › Knowledge, changes: what gets merged into each app repository's default branch
-- (pull requests, commits pushed without one, releases), polled from GitHub (no webhooks). Claude
-- works them into the app's TRIAGE.md, and each ticket's prompt gets its app's recent ones.
CREATE TABLE repo_changes (
  id            TEXT PRIMARY KEY,
  repo_id       INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('pr', 'commit', 'release')),
  -- The pull request's number, the commit's sha or the release's tag.
  ref           TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  author        TEXT,
  url           TEXT NOT NULL,
  labels        TEXT NOT NULL DEFAULT '[]',
  -- Issue numbers it closes ("Fixes #123").
  closes        TEXT NOT NULL DEFAULT '[]',
  -- Bots, dependency bumps and chores: kept, never sent to Claude.
  noise         TEXT,
  merged_at     INTEGER NOT NULL,
  seen_at       INTEGER NOT NULL DEFAULT (now_ms()),
  UNIQUE (repo_id, kind, ref)
);
CREATE INDEX repo_changes_repo_idx ON repo_changes(repo_id, merged_at);

-- Each app's view of a change (a repository can hold several apps): worked into its TRIAGE.md or not.
CREATE TABLE app_changes (
  app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  change_id  TEXT NOT NULL REFERENCES repo_changes(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'added', 'skipped')),
  -- Why it was left out, in a few words (Claude's, or "Bot", "Chore").
  note       TEXT,
  decided_at INTEGER,
  PRIMARY KEY (app_id, change_id)
);
CREATE INDEX app_changes_pending_idx ON app_changes(app_id) WHERE status = 'pending';

-- How far each repository has been checked.
CREATE TABLE repo_change_sync (
  repo_id         INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  default_branch  TEXT,
  -- Pull requests and releases after this are new.
  since_at        INTEGER NOT NULL,
  -- The branch's newest commit at the last check: commits after it are new, whatever their date.
  head_sha        TEXT,
  checked_at      INTEGER,
  last_error      TEXT,
  lease_until_at  INTEGER
);

-- A queued write is a full rewrite or an update with the changes since the last one; the weekly
-- rewrite and the questions follow the last full one.
ALTER TABLE app_knowledge ADD COLUMN auto_mode TEXT;
ALTER TABLE app_knowledge ADD COLUMN auto_full_at INTEGER;
UPDATE app_knowledge SET auto_full_at = auto_at;

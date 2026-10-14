-- A copy of every issue in the connected repositories, used to find duplicates. It's kept
-- current by asking GitHub for changed issues every couple of minutes (no webhooks needed).
CREATE TABLE issue_index (
  repo_id       INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  excerpt       TEXT NOT NULL DEFAULT '',            -- start of the description, cleaned
  state         TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  state_reason  TEXT,                                -- completed, not_planned, duplicate, reopened
  labels        TEXT NOT NULL DEFAULT '[]',
  app_name      TEXT,                                -- from the [App] title prefix of tickets this app filed
  duplicate_of  INTEGER,                             -- the original, when known
  html_url      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  gone          INTEGER NOT NULL DEFAULT 0,          -- deleted or moved on GitHub
  indexed_at    INTEGER NOT NULL DEFAULT (now_ms()),
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX issue_index_updated_idx ON issue_index(repo_id, updated_at DESC);

-- Full-text search over titles and descriptions; "crashes" also finds "crash" and "crashing".
CREATE VIRTUAL TABLE issue_index_fts USING fts5(
  title, excerpt,
  content = 'issue_index', content_rowid = 'rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER issue_index_ai AFTER INSERT ON issue_index BEGIN
  INSERT INTO issue_index_fts (rowid, title, excerpt) VALUES (new.rowid, new.title, new.excerpt);
END;
CREATE TRIGGER issue_index_ad AFTER DELETE ON issue_index BEGIN
  INSERT INTO issue_index_fts (issue_index_fts, rowid, title, excerpt) VALUES ('delete', old.rowid, old.title, old.excerpt);
END;
CREATE TRIGGER issue_index_au AFTER UPDATE OF title, excerpt ON issue_index BEGIN
  INSERT INTO issue_index_fts (issue_index_fts, rowid, title, excerpt) VALUES ('delete', old.rowid, old.title, old.excerpt);
  INSERT INTO issue_index_fts (rowid, title, excerpt) VALUES (new.rowid, new.title, new.excerpt);
END;

-- Sync progress per repository.
CREATE TABLE issue_index_repos (
  repo_id          INTEGER PRIMARY KEY,
  owner            TEXT NOT NULL,
  name             TEXT NOT NULL,
  installation_id  INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'loading' CHECK (status IN ('loading', 'ready', 'error')),
  next_page        INTEGER NOT NULL DEFAULT 1,         -- first load: next page, oldest issues first
  newest_number    INTEGER,                            -- highest issue number when the first load began
  synced_until     INTEGER,                            -- changes on GitHub are picked up from here
  full_check_at    INTEGER,                            -- last weekly check for deleted issues
  sync_requested_at INTEGER,                           -- "Sync now" from the console
  last_synced_at   INTEGER,
  last_error       TEXT,
  lease_until_at   INTEGER,                            -- one process syncs a repository at a time
  created_at       INTEGER NOT NULL DEFAULT (now_ms())
);

-- Each running process reports its memory here (Deployment › Server health).
CREATE TABLE process_status (
  id               TEXT PRIMARY KEY,                   -- instance ID
  role             TEXT NOT NULL,                      -- web, worker, triage
  pid              INTEGER NOT NULL,
  rss_bytes        INTEGER NOT NULL,
  heap_bytes       INTEGER NOT NULL,
  limit_mb         INTEGER,                            -- PM2 restarts the process above this
  host_total_bytes INTEGER,
  host_available_bytes INTEGER,
  started_at       INTEGER NOT NULL,
  seen_at          INTEGER NOT NULL
);

-- Moderators: two more things an admin can allow.
ALTER TABLE workspace_members ADD COLUMN can_search_issues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_members ADD COLUMN can_manage_files INTEGER NOT NULL DEFAULT 0;

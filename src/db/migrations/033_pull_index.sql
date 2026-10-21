-- Pull requests of the indexed repositories, from the same sync as the issue index: GitHub lists
-- them with the issues, so they cost no extra calls. Open ones are kept, closed ones for 90 days.
-- AI triage reads them (a ticket being worked on, or already fixed), and Repo status lists them.
CREATE TABLE pull_index (
  repo_id      INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  excerpt      TEXT NOT NULL DEFAULT '',            -- start of the description, cleaned
  author       TEXT,
  labels       TEXT NOT NULL DEFAULT '[]',
  state        TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  draft        INTEGER NOT NULL DEFAULT 0,
  merged_at    INTEGER,
  closes       TEXT NOT NULL DEFAULT '[]',          -- issues it says it fixes ("Fixes #12")
  mentions     TEXT NOT NULL DEFAULT '[]',          -- other issues it names ("for #12")
  noise        TEXT,                                -- 'Bot' or 'Chore': left out of triage and the page
  html_url     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  indexed_at   INTEGER NOT NULL DEFAULT (now_ms()),
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX pull_index_state_idx ON pull_index(repo_id, state, updated_at DESC);

CREATE VIRTUAL TABLE pull_index_fts USING fts5(
  title, excerpt,
  content = 'pull_index', content_rowid = 'rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER pull_index_ai AFTER INSERT ON pull_index BEGIN
  INSERT INTO pull_index_fts (rowid, title, excerpt) VALUES (new.rowid, new.title, new.excerpt);
END;
CREATE TRIGGER pull_index_ad AFTER DELETE ON pull_index BEGIN
  INSERT INTO pull_index_fts (pull_index_fts, rowid, title, excerpt) VALUES ('delete', old.rowid, old.title, old.excerpt);
END;
CREATE TRIGGER pull_index_au AFTER UPDATE OF title, excerpt ON pull_index BEGIN
  INSERT INTO pull_index_fts (pull_index_fts, rowid, title, excerpt) VALUES ('delete', old.rowid, old.title, old.excerpt);
  INSERT INTO pull_index_fts (rowid, title, excerpt) VALUES (new.rowid, new.title, new.excerpt);
END;

-- Each indexed repository's recent releases, newest first ([{tag, at}]), so a merged fix is "not
-- released yet" or "in v1.4.3"; and when its open pull requests were first read (repositories
-- indexed before pull requests were kept get them once, then from the regular sync).
ALTER TABLE issue_index_repos ADD COLUMN releases TEXT;
ALTER TABLE issue_index_repos ADD COLUMN releases_checked_at INTEGER;
ALTER TABLE issue_index_repos ADD COLUMN pulls_loaded_at INTEGER;

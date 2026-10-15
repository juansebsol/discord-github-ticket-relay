-- Bulk apply from the inbox (and Issues › Triage): the suggestions that match the filters, on
-- the tickets picked, applied on GitHub in the background one at a time.
CREATE TABLE triage_bulk (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Which suggestions to apply: the list's filters when the bulk was started (JSON), and in words.
  filter           TEXT NOT NULL DEFAULT '{}',
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'stopped')),
  waiting_until_at INTEGER,
  waiting_reason   TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL DEFAULT (now_ms()),
  finished_at      INTEGER
);
CREATE INDEX triage_bulk_workspace_idx ON triage_bulk(workspace_id, created_at DESC);

CREATE TABLE triage_bulk_items (
  bulk_id        TEXT NOT NULL REFERENCES triage_bulk(id) ON DELETE CASCADE,
  -- 'sub:<submission id>' for a ticket, 'gh:<repo id>:<number>' for an issue opened on GitHub.
  subject        TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped', 'failed')),
  note           TEXT,
  lease_until_at INTEGER,
  done_at        INTEGER,
  PRIMARY KEY (bulk_id, subject)
);
CREATE INDEX triage_bulk_items_pending_idx ON triage_bulk_items(status, bulk_id);

-- Log entries from a bulk apply point to it (Triage › Activity can show one bulk only).
ALTER TABLE triage_log ADD COLUMN bulk_id TEXT REFERENCES triage_bulk(id) ON DELETE SET NULL;
CREATE INDEX triage_log_bulk_idx ON triage_log(bulk_id, id DESC);

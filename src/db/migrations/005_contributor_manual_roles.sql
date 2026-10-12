-- Optional panel text per tier (e.g. "at least 10 merged pull requests or a big feature"),
-- and roles that are only listed on the panel because admins give them by hand.
ALTER TABLE contributor_tiers ADD COLUMN note TEXT;

CREATE TABLE contributor_manual_roles (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL,
  role_name     TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (now_ms()),
  UNIQUE (workspace_id, role_id)
);

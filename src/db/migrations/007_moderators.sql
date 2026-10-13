-- Moderator role with per-moderator permissions, and invites that carry a role.
-- SQLite can't alter a CHECK constraint, so workspace_members is rebuilt (rows copied).
CREATE TABLE workspace_members_new (
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                   TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator')),
  can_act_tickets        INTEGER NOT NULL DEFAULT 0,   -- moderators: re-check, retry, link, close
  can_view_contributors  INTEGER NOT NULL DEFAULT 1,   -- moderators: see contributor verifications
  created_at             INTEGER NOT NULL DEFAULT (now_ms()),
  PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO workspace_members_new (workspace_id, user_id, role, created_at)
  SELECT workspace_id, user_id, role, created_at FROM workspace_members;
DROP TABLE workspace_members;
ALTER TABLE workspace_members_new RENAME TO workspace_members;
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

ALTER TABLE workspace_invites ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'moderator'));

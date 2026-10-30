-- MCP: the team's coding agents (Claude Code, Cursor, VS Code, Codex) reach tickets through
-- POST /mcp with a personal token. Off until an admin turns it on; each moderator gets each of its
-- tools by its own switch (kept in workspace_members.access as "mcp": [tool, …]).
CREATE TABLE mcp_settings (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  enabled_at    INTEGER,
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);

-- Personal tokens, one per device. Only a hash is kept; the token is shown once.
CREATE TABLE mcp_tokens (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  hint          TEXT NOT NULL,                       -- the token's last characters, to tell tokens apart
  read_only     INTEGER NOT NULL DEFAULT 0,          -- no actions, whatever the person may do
  created_at    INTEGER NOT NULL DEFAULT (now_ms()),
  expires_at    INTEGER,                             -- null: never
  last_used_at  INTEGER,
  last_client   TEXT,                                -- what connected last ("claude-code 2.1")
  calls         INTEGER NOT NULL DEFAULT 0,
  revoked_at    INTEGER,
  revoked_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX mcp_tokens_workspace_idx ON mcp_tokens(workspace_id, created_at DESC);

-- "I'm on it": one person per ticket, kept here only (nothing is written to GitHub).
CREATE TABLE ticket_claims (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id       INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  note          TEXT,
  claimed_at    INTEGER NOT NULL DEFAULT (now_ms()),
  active_at     INTEGER NOT NULL DEFAULT (now_ms()),  -- the claimer last read or claimed it
  ended_at      INTEGER,
  end_reason    TEXT,                                -- released, expired, closed, released_by_admin
  ended_by      TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ticket_claims_active_idx ON ticket_claims(workspace_id, repo_id, number) WHERE ended_at IS NULL;
CREATE INDEX ticket_claims_user_idx ON ticket_claims(workspace_id, user_id, ended_at);

-- Where a moderator's action came from: null in the console, 'mcp' through a coding agent.
ALTER TABLE mod_actions ADD COLUMN via TEXT;

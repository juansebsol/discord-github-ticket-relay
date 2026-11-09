-- Linked workspaces: a workspace made from another one (its main). It has its own GitHub
-- connection, apps, ticket types, tickets and tools, and uses its main's Discord server. The
-- main's owner and admins are its admins, and the main's global moderators its moderators.
-- One level only: a linked workspace has no linked workspaces of its own.
ALTER TABLE workspaces ADD COLUMN parent_id TEXT REFERENCES workspaces(id);
CREATE INDEX workspaces_parent_idx ON workspaces(parent_id);
-- A linked workspace's apps: 1 = on its main's panel (after the main's apps), 0 = on a panel of its own.
ALTER TABLE workspaces ADD COLUMN on_main_panel INTEGER NOT NULL DEFAULT 0;
-- A linked workspace's own panel channel (in its main's server). Mains keep theirs on discord_connections.
ALTER TABLE workspaces ADD COLUMN panel_channel_id TEXT;
ALTER TABLE workspaces ADD COLUMN panel_channel_name TEXT;
-- A link that lets someone without an account install the GitHub App for this workspace (for an
-- organization the admins don't own). One at a time; it works once and expires.
ALTER TABLE workspaces ADD COLUMN github_link_hash TEXT;
ALTER TABLE workspaces ADD COLUMN github_link_enc TEXT;
ALTER TABLE workspaces ADD COLUMN github_link_expires_at INTEGER;
CREATE INDEX workspaces_github_link_idx ON workspaces(github_link_hash);

-- Global moderators: a main workspace's moderators who are also moderators in each of its linked
-- workspaces, with the same pages. The moderators there now become global; new ones aren't
-- unless chosen.
ALTER TABLE workspace_members ADD COLUMN global_mod INTEGER NOT NULL DEFAULT 0;
UPDATE workspace_members SET global_mod = 1 WHERE role = 'moderator';
ALTER TABLE workspace_invites ADD COLUMN global_mod INTEGER NOT NULL DEFAULT 0;

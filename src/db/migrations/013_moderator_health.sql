-- Moderators: an admin can let them see the Server health page.
ALTER TABLE workspace_members ADD COLUMN can_view_health INTEGER NOT NULL DEFAULT 0;

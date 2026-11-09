-- Discord tickets › Panel › My tickets: what members can do on one of their own open tickets (add
-- details, add screenshots, close it) and the comments the app posts on GitHub for each. JSON, read
-- with defaults (member-actions.ts); null: all off with the built-in comments.
ALTER TABLE workspaces ADD COLUMN member_actions TEXT;

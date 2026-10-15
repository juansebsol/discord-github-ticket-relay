-- What a moderator can do on setup pages an admin opens to them (for now Apps & repositories):
-- no access, view, or edit (JSON, keyed by page). Moderators start with no access.
ALTER TABLE workspace_members ADD COLUMN page_access TEXT NOT NULL DEFAULT '{}';

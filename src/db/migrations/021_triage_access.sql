-- What a moderator can do on each Triage page (Actions, Label groups, Prompt, Re-run,
-- Activity): no access, view, or edit (JSON). Moderators start with no access.
ALTER TABLE workspace_members ADD COLUMN triage_access TEXT NOT NULL DEFAULT '{}';

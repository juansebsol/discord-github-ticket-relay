-- Who opened each issue (the Reporter column in Issues). Filled as issues sync; the full
-- re-check below runs on the next sync to fill it in for issues already copied.
ALTER TABLE issue_index ADD COLUMN author TEXT;
ALTER TABLE issue_index ADD COLUMN author_avatar TEXT;
UPDATE issue_index_repos SET full_check_at = NULL;

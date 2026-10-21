-- Pull requests come from GitHub's pull request list, read on their own every 10 minutes: the
-- issue list leaves them out unless the GitHub App has Pull requests: Read, while a public
-- repository's pull requests can be listed without it.
ALTER TABLE issue_index_repos ADD COLUMN pulls_synced_until INTEGER;   -- newest change seen
ALTER TABLE issue_index_repos ADD COLUMN pulls_checked_at INTEGER;
ALTER TABLE issue_index_repos ADD COLUMN pulls_error TEXT;
ALTER TABLE issue_index_repos ADD COLUMN pulls_lease_until_at INTEGER;
-- The first catch-up read the issue list, which had none: read them again.
UPDATE issue_index_repos SET pulls_loaded_at = NULL;

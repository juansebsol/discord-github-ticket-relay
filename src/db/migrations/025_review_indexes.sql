-- Counting what waits for review runs on every page (the AI triage badge in the sidebar) and again
-- on Review: these partial indexes hold only the results with suggestions waiting, so the count
-- doesn't read every result of the workspace. Queries keep the same test:
-- status = 'done' AND suggestion_count > 0.
CREATE INDEX triage_results_waiting_idx ON triage_results(workspace_id, completed_at) WHERE status = 'done' AND suggestion_count > 0;
CREATE INDEX issue_triage_waiting_idx ON issue_triage(workspace_id, completed_at) WHERE status = 'done' AND suggestion_count > 0;

-- "Is this issue a ticket?" (issues opened on GitHub are the ones that aren't): the overview,
-- and triage picking up new issues.
CREATE INDEX submissions_repo_issue_idx ON submissions(repo_id, issue_number);

-- Issues opened lately, newest first (the overview's Latest and "opened this week").
CREATE INDEX issue_index_created_idx ON issue_index(repo_id, created_at DESC);

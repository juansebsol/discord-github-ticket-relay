-- Merged pull requests are kept for good now (contributor roles count them from here, since the
-- issue search leaves pull requests out unless the app has Pull requests: Read). The catch-up
-- reads every closed one again, so merged ones from before the last 90 days are added.
UPDATE issue_index_repos SET pulls_loaded_at = NULL;

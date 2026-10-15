-- Applying a re-run's results to the inbox only: each ticket's triage result is replaced and
-- every action becomes a suggestion to approve on its own. Nothing is sent to GitHub.
ALTER TABLE triage_run_items ADD COLUMN apply_inbox_only INTEGER NOT NULL DEFAULT 0;

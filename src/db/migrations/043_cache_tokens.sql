-- Of each triage call's input tokens, how many were read from Claude's prompt cache (about a tenth
-- of the price) and written to it (a quarter more): costs and estimates use them. Null for calls
-- made before they were kept (all their input is counted at the full price).
ALTER TABLE triage_results ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE triage_results ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE issue_triage ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE issue_triage ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE triage_run_items ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE triage_run_items ADD COLUMN cache_write_tokens INTEGER;

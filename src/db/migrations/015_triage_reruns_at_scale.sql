-- Re-runs at scale. Each result is compared with the ticket's earlier triage once, when it's
-- done, so big runs page and count quickly. Applying can include the suggestions. A run waits
-- (instead of failing) while GitHub's or Claude's rate limit needs it to.
ALTER TABLE triage_run_items ADD COLUMN change TEXT CHECK (change IN ('changed', 'new', 'same'));
ALTER TABLE triage_run_items ADD COLUMN apply_suggestions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE triage_run_items ADD COLUMN apply_done_at INTEGER;
ALTER TABLE triage_runs ADD COLUMN waiting_until_at INTEGER;
ALTER TABLE triage_runs ADD COLUMN waiting_reason TEXT;
CREATE INDEX triage_run_items_run_idx ON triage_run_items(run_id, position);

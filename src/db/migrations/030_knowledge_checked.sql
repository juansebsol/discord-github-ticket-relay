-- AI triage › Knowledge: when the schedule last looked at an app's TRIAGE.md and found nothing
-- new. The next look is an interval after that (or after its last update), and its card says so.
ALTER TABLE app_knowledge ADD COLUMN auto_checked_at INTEGER;

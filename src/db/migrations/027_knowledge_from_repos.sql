-- Claude writes each app's TRIAGE.md itself, from the app's repository (README, changelog, docs,
-- releases) and its issues, open and closed (AI triage › Knowledge). The team's own notes (body)
-- stay separate: Claude never changes them.

-- When the team's notes were last saved (updated_at also moves when Claude writes).
ALTER TABLE app_knowledge ADD COLUMN notes_at INTEGER;
UPDATE app_knowledge SET notes_at = updated_at WHERE body <> '';

-- What Claude wrote, and the job that writes it (one per app, run by the triage worker).
ALTER TABLE app_knowledge ADD COLUMN auto_body TEXT NOT NULL DEFAULT '';
ALTER TABLE app_knowledge ADD COLUMN auto_status TEXT CHECK (auto_status IN ('queued', 'running', 'done', 'failed'));
ALTER TABLE app_knowledge ADD COLUMN auto_at INTEGER;
ALTER TABLE app_knowledge ADD COLUMN auto_requested_at INTEGER;
ALTER TABLE app_knowledge ADD COLUMN auto_requested_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE app_knowledge ADD COLUMN auto_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_knowledge ADD COLUMN auto_error TEXT;
ALTER TABLE app_knowledge ADD COLUMN auto_model TEXT;
-- JSON: what it was written from, and Claude's answers to its own questions from triage.
ALTER TABLE app_knowledge ADD COLUMN auto_sources TEXT;
ALTER TABLE app_knowledge ADD COLUMN auto_answers TEXT;
ALTER TABLE app_knowledge ADD COLUMN auto_input_tokens INTEGER;
ALTER TABLE app_knowledge ADD COLUMN auto_output_tokens INTEGER;
ALTER TABLE app_knowledge ADD COLUMN lease_owner TEXT;
ALTER TABLE app_knowledge ADD COLUMN lease_until_at INTEGER;
CREATE INDEX app_knowledge_queue_idx ON app_knowledge(auto_requested_at) WHERE auto_status IN ('queued', 'running');

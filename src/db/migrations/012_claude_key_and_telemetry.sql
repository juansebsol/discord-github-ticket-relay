-- One Claude API key per workspace, managed in Settings and shared by every feature that
-- uses Claude (AI triage today). Moved here from triage_settings.
CREATE TABLE workspace_ai (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  key_enc        TEXT,                               -- encrypted with ENCRYPTION_KEY; never shown again
  key_hint       TEXT,                               -- sk-ant-…abcd
  key_added_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  key_added_at   INTEGER,
  -- Last time the key was checked with Claude (Test key, Settings, Deployment, or triage itself).
  checked_at     INTEGER,
  check_state    TEXT CHECK (check_state IN ('working', 'rejected', 'credits', 'unreachable')),
  check_detail   TEXT,
  updated_at     INTEGER NOT NULL DEFAULT (now_ms())
);
INSERT INTO workspace_ai (workspace_id, key_enc, key_hint, key_added_by, key_added_at)
  SELECT workspace_id, api_key_enc, api_key_hint, api_key_added_by, api_key_added_at FROM triage_settings WHERE api_key_enc IS NOT NULL;
UPDATE triage_settings SET api_key_enc = NULL, api_key_hint = NULL, api_key_added_by = NULL, api_key_added_at = NULL;

-- More telemetry per process (CPU, event loop delay, heap, GitHub rate limit), as JSON.
ALTER TABLE process_status ADD COLUMN stats TEXT;

-- A history of each process's memory and CPU for the Server health charts (kept 48 hours).
CREATE TABLE process_samples (
  process_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  at           INTEGER NOT NULL,
  rss_bytes    INTEGER NOT NULL,
  cpu_pct      REAL,
  lag_ms       REAL,
  host_available_bytes INTEGER
);
CREATE INDEX process_samples_at_idx ON process_samples(at);

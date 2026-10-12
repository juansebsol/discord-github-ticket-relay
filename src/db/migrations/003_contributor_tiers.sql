-- Contributor tiers: any number of (role, minimum contributions) pairs per workspace,
-- e.g. Junior Contributor at 1, Contributor at 10. Replaces the single role in
-- contributor_settings (those columns are kept but no longer used).

CREATE TABLE contributor_tiers (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id            TEXT NOT NULL,
  role_name          TEXT NOT NULL,
  min_contributions  INTEGER NOT NULL CHECK (min_contributions BETWEEN 1 AND 100000),
  created_at         INTEGER NOT NULL DEFAULT (now_ms()),
  UNIQUE (workspace_id, role_id),
  UNIQUE (workspace_id, min_contributions)
);

-- Carry over a role configured with the single-role version as the first tier.
INSERT INTO contributor_tiers (id, workspace_id, role_id, role_name, min_contributions)
SELECT lower(hex(randomblob(16))), workspace_id, role_id, COALESCE(role_name, 'Contributor'), 1
FROM contributor_settings WHERE role_id IS NOT NULL;

-- What each verification counted and which tier it granted.
ALTER TABLE contributor_verifications ADD COLUMN contributions INTEGER;
ALTER TABLE contributor_verifications ADD COLUMN role_name TEXT;

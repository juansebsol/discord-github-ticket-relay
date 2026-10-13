-- Ticket types (e.g. Bug report, Feature request). When a workspace has enabled types,
-- members pick one after choosing the app; the type adds a GitHub label and a title prefix.
CREATE TABLE ticket_types (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  public_id     TEXT NOT NULL UNIQUE,              -- short opaque ID used in Discord custom_ids
  name          TEXT NOT NULL,                     -- shown to members
  description   TEXT,                              -- shown under the option in Discord
  label         TEXT,                              -- GitHub label added to the issue (hidden from members)
  title_prefix  TEXT,                              -- e.g. "Bug" -> "[Bug] [App] title"
  guidance      TEXT,                              -- text at the top of the form
  placeholder   TEXT,                              -- description field placeholder
  enabled       INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (now_ms()),
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);
CREATE UNIQUE INDEX ticket_types_workspace_name_idx ON ticket_types(workspace_id, lower(name));

-- Snapshot of the chosen type on each submission (the label is merged into labels).
ALTER TABLE submissions ADD COLUMN ticket_type_name TEXT;
ALTER TABLE submissions ADD COLUMN title_prefix TEXT;

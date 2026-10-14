-- Triage: "Not a development issue" flag for the inbox filter.
ALTER TABLE triage_results ADD COLUMN is_support INTEGER NOT NULL DEFAULT 0;

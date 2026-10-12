-- Admin-editable text for the contributor panel. NULL means "use the built-in default";
-- roles_text NULL means "list the role tiers automatically".
ALTER TABLE contributor_settings ADD COLUMN panel_title TEXT;
ALTER TABLE contributor_settings ADD COLUMN panel_intro TEXT;
ALTER TABLE contributor_settings ADD COLUMN roles_text TEXT;
ALTER TABLE contributor_settings ADD COLUMN panel_steps TEXT;
ALTER TABLE contributor_settings ADD COLUMN panel_footer TEXT;
ALTER TABLE contributor_settings ADD COLUMN button_label TEXT;

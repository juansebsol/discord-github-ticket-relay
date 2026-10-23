-- Announcements: the buttons under a post are the workspace's own (a label, a link and the apps
-- each is for), not a fixed Windows/macOS/Linux set. The release notes button can be turned off
-- and renamed.
ALTER TABLE announcement_settings ADD COLUMN buttons TEXT NOT NULL DEFAULT '[]';  -- [{ label, url, appId }]
ALTER TABLE announcement_settings ADD COLUMN notes_button INTEGER NOT NULL DEFAULT 1;
ALTER TABLE announcement_settings ADD COLUMN notes_button_label TEXT;              -- null: "Release notes"
ALTER TABLE announcement_settings DROP COLUMN download_buttons;

-- Discord tickets › Panel: the workspace's own notice of who can read a report and what to leave
-- out, shown when a member picks a ticket type and at the top of the form. One for apps whose
-- repository is public, one for private ones; null = the built-in text.
ALTER TABLE workspaces ADD COLUMN notice_public TEXT;
ALTER TABLE workspaces ADD COLUMN notice_private TEXT;

-- Discord tickets › Panel: when a panel has apps from more than one workspace (a main and its linked
-- workspaces on it), each workspace's apps get their own menu, named by this. Null: the workspace's name.
ALTER TABLE workspaces ADD COLUMN panel_section_title TEXT;

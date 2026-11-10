-- Discord tickets › Panel, on a main with linked workspaces on its panel: members press a button for
-- the main's apps or one for every linked workspace's, then pick the app. panel_section_title (053)
-- names the main's button; this names the linked workspaces' one. Null: the default name.
ALTER TABLE workspaces ADD COLUMN panel_linked_title TEXT;

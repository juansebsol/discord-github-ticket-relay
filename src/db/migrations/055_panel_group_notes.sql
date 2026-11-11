-- Discord tickets › Panel, on a main with linked workspaces on its panel: an optional description for
-- each of the two buttons (the main's apps, the linked workspaces'), shown with the button's name in
-- the panel's text, or in the private Open a ticket message while My tickets is on. Null: none.
ALTER TABLE workspaces ADD COLUMN panel_main_note TEXT;
ALTER TABLE workspaces ADD COLUMN panel_linked_note TEXT;

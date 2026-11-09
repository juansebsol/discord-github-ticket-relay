-- Discord tickets › Panel › My tickets: the panel shows an "Open a ticket" and a "My tickets" button
-- instead of the app menu; My tickets shows a member their own tickets here and what's happening
-- with each, privately. Off until an admin turns it on.
ALTER TABLE workspaces ADD COLUMN my_tickets INTEGER NOT NULL DEFAULT 0;

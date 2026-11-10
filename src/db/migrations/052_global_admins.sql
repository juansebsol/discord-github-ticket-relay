-- Global admins: like global moderators, a main workspace's admins who are also admins in each of
-- its linked workspaces. workspace_members.global_mod (and workspace_invites.global_mod) is the
-- "Global" switch for both roles. Today's admins, and admin invites not used yet, stay admins
-- everywhere; new ones aren't unless chosen. A linked workspace can also have admins of its own.
UPDATE workspace_members SET global_mod = 1 WHERE role = 'admin';
UPDATE workspace_invites SET global_mod = 1 WHERE role = 'admin' AND used_at IS NULL;

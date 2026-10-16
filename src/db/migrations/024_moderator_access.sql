-- One access map per moderator: for each page they can open, view or edit (JSON, keyed by page,
-- for example {"inbox":"edit","triage.prompt":"view"}). Pages left out: no access; the Inbox is
-- always at least View. It replaces can_act_tickets, can_view_contributors, can_search_issues,
-- can_manage_files, can_view_health, triage_access and page_access, which stay in the table but
-- are no longer read.
ALTER TABLE workspace_members ADD COLUMN access TEXT NOT NULL DEFAULT '{}';

-- Everyone keeps what they could do. Admins are filled too (their map is only used if they
-- become a moderator again), so nobody loses access by being switched back.
--   Act on tickets            → Inbox: edit, Review: edit (applying suggestions needed it)
--   any Triage page           → Review: view (when they couldn't act on tickets)
--   See verifications         → Verifications: view
--   Search all issues         → All issues, Opened on GitHub, Sync: view
--   Clean up files            → Files: edit
--   See server health         → Server health: view
--   Triage pages, Apps        → copied (Activity only has View)
UPDATE workspace_members SET access = (
  SELECT coalesce(json_group_object(k, v), '{}') FROM (
    SELECT 'inbox' AS k, 'edit' AS v WHERE workspace_members.can_act_tickets = 1
    UNION ALL SELECT 'triage.review', 'edit' WHERE workspace_members.can_act_tickets = 1
    UNION ALL SELECT 'triage.review', 'view' WHERE workspace_members.can_act_tickets = 0
      AND EXISTS (SELECT 1 FROM json_each(workspace_members.triage_access) WHERE value IN ('view', 'edit'))
    UNION ALL SELECT 'verifications', 'view' WHERE workspace_members.can_view_contributors = 1
    UNION ALL SELECT 'issues', 'view' WHERE workspace_members.can_search_issues = 1
    UNION ALL SELECT 'issues-github', 'view' WHERE workspace_members.can_search_issues = 1
    UNION ALL SELECT 'issues-sync', 'view' WHERE workspace_members.can_search_issues = 1
    UNION ALL SELECT 'files', 'edit' WHERE workspace_members.can_manage_files = 1
    UNION ALL SELECT 'health', 'view' WHERE workspace_members.can_view_health = 1
    UNION ALL SELECT 'triage.' || key, CASE WHEN key = 'activity' THEN 'view' ELSE value END FROM json_each(workspace_members.triage_access)
      WHERE key IN ('actions', 'labels', 'prompt', 'runs', 'activity') AND value IN ('view', 'edit')
    UNION ALL SELECT key, value FROM json_each(workspace_members.page_access) WHERE key = 'apps' AND value IN ('view', 'edit')
  )
) WHERE role <> 'owner';

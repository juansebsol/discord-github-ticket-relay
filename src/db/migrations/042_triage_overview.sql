-- AI triage › Overview: charts of what triage did and every label on the open issues. Whoever
-- can open Review can open it too (it only shows, nothing to change).
UPDATE workspace_members SET access = json_set(access, '$."triage.overview"', 'view')
  WHERE role <> 'owner' AND json_extract(access, '$."triage.review"') IS NOT NULL;

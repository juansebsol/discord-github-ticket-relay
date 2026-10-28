-- Release announcements move to Bot features as GitHub releases, and Announcements becomes
-- messages the team writes and the bot posts. Moderators keep what they had on the release pages
-- under their new names; nobody gets the new Announcements until an admin gives it.
UPDATE workspace_members SET access = json_set(access, '$.releases', json_extract(access, '$.announcements'))
  WHERE json_extract(access, '$.announcements') IS NOT NULL;
UPDATE workspace_members SET access = json_set(access, '$."release-settings"', json_extract(access, '$."announcement-settings"'))
  WHERE json_extract(access, '$."announcement-settings"') IS NOT NULL;
UPDATE workspace_members SET access = json_set(access, '$."release-pings"', json_extract(access, '$."announcement-pings"'))
  WHERE json_extract(access, '$."announcement-pings"') IS NOT NULL;
UPDATE workspace_members SET access = json_remove(access, '$.announcements', '$."announcement-settings"', '$."announcement-pings"');

-- An announcement: the message, an optional card (embed) and buttons, the role it pings, and the
-- channels it's posted in. A draft until it's posted; deleting it from Discord makes it one again.
CREATE TABLE posts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'draft',      -- draft, posting (being sent) or posted
  content       TEXT NOT NULL DEFAULT '',           -- the message text
  card_title    TEXT,                               -- the card under it (none without title and text)
  card_text     TEXT,
  card_color    TEXT NOT NULL DEFAULT 'blurple',
  role_id       TEXT,                               -- the role pinged (null: no one)
  role_name     TEXT,
  buttons       TEXT NOT NULL DEFAULT '[]',         -- [{ label, url }]
  targets       TEXT NOT NULL DEFAULT '[]',         -- [{ channelId, channelName, messageId }]
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  posted_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  posted_at     INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (now_ms()),
  updated_at    INTEGER NOT NULL DEFAULT (now_ms())
);
CREATE INDEX posts_list_idx ON posts(workspace_id, updated_at);

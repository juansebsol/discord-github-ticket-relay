import { withTransaction, type Db, type Queryable } from '../db/database.js';
import { randomUUID } from 'node:crypto';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { Config } from '../config.js';
import { AREA_KEYS, hasEdit, MCP_SWITCH_KEYS, type McpSwitch, type MemberAccess } from './permissions.js';
import { UserFacingError, type Role, type UserRow, type WorkspaceRow } from './types.js';

export async function upsertUser(
  q: Queryable,
  u: { discordUserId: string; username: string; displayName: string | null; avatar: string | null },
): Promise<UserRow> {
  const { rows } = await q.query<UserRow>(
    `INSERT INTO users (id, discord_user_id, username, display_name, avatar)
     VALUES ($5, $1, $2, $3, $4)
     ON CONFLICT (discord_user_id) DO UPDATE
       SET username = EXCLUDED.username, display_name = EXCLUDED.display_name,
           avatar = EXCLUDED.avatar, last_login_at = now_ms()
     RETURNING *`,
    [u.discordUserId, u.username, u.displayName, u.avatar, randomUUID()],
  );
  return rows[0]!;
}

export interface Membership extends MemberAccess {
  workspace: WorkspaceRow;
  /** A main workspace's moderator who is also in each of its linked workspaces. */
  global?: boolean;
  /** In a linked workspace through its main (the main's name): owner, admin or global moderator there. */
  via?: string;
}

const MEMBER_COLUMNS = 'm.role, m.access, m.global_mod';

/** What a new moderator can do: see tickets (always) and contributor verifications. */
const NEW_MODERATOR_ACCESS: MemberAccess['access'] = { verifications: 'view' };

function accessMap(v: unknown): MemberAccess['access'] {
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as MemberAccess['access'];
}

function toMembership(row: Record<string, unknown>): Membership {
  const { role, access, global_mod, via_main, ...workspace } = row;
  return {
    workspace: workspace as unknown as WorkspaceRow, role: role as Role, access: accessMap(access), global: Boolean(global_mod),
    ...(typeof via_main === 'string' ? { via: via_main } : {}),
  };
}

/**
 * Who is in a linked workspace through its main: the main's owner and admins (same role), and its
 * global moderators (with the pages they have there). They win over a membership of their own.
 */
const INHERITED = `SELECT w.*, ${MEMBER_COLUMNS}, p.name AS via_main FROM workspaces w
  JOIN workspaces p ON p.id = w.parent_id JOIN workspace_members m ON m.workspace_id = p.id
  WHERE m.user_id = $1 AND (m.role <> 'moderator' OR m.global_mod = 1)`;

/** Every workspace this person can open: mains first, each followed by its linked workspaces. */
export async function listMemberships(q: Queryable, userId: string): Promise<Membership[]> {
  const { rows } = await q.query(
    `SELECT w.*, ${MEMBER_COLUMNS}, NULL AS via_main FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = $1
     UNION ALL ${INHERITED}`,
    [userId],
  );
  const byId = new Map<string, Membership>();
  for (const r of rows.map(toMembership)) {
    if (!byId.has(r.workspace.id) || r.via) byId.set(r.workspace.id, r);
  }
  const all = [...byId.values()].sort((a, b) => a.workspace.created_at.getTime() - b.workspace.created_at.getTime());
  // A linked workspace right after its main; one whose main they can't open stands on its own.
  const top = all.filter((m) => !m.workspace.parent_id || !byId.has(m.workspace.parent_id));
  return top.flatMap((m) => [m, ...all.filter((x) => x.workspace.parent_id === m.workspace.id)]);
}

/** Returns the membership only if the user belongs to the workspace (directly or through its main). */
export async function getMembership(q: Queryable, userId: string, workspaceId: string): Promise<Membership | null> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return null;
  const { rows } = await q.query(
    `SELECT w.*, ${MEMBER_COLUMNS}, NULL AS via_main FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.workspace_id = $2
     UNION ALL ${INHERITED} AND w.id = $2`,
    [userId, workspaceId],
  );
  const found = rows.map(toMembership);
  return found.find((m) => m.via) ?? found[0] ?? null;
}

export async function getWorkspace(q: Queryable, id: string): Promise<WorkspaceRow | null> {
  const { rows } = await q.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Who may create a workspace: platform admins listed in deployment config, anyone when
 * open creation is enabled, or the very first user of a fresh deployment (bootstrap).
 */
export async function canCreateWorkspace(q: Queryable, config: Config, user: UserRow): Promise<boolean> {
  if (config.openWorkspaceCreation) return true;
  if (config.platformAdminDiscordIds.includes(user.discord_user_id)) return true;
  if (config.platformAdminDiscordIds.length > 0) return false;
  const { rows } = await q.query('SELECT 1 FROM workspaces LIMIT 1');
  return rows.length === 0;
}

export async function createWorkspace(db: Db, config: Config, user: UserRow, name: string): Promise<WorkspaceRow> {
  return withTransaction(db, async (c) => {
    // The write transaction serializes bootstrap, so two first users can't both claim a fresh deployment.
    if (!(await canCreateWorkspace(c, config, user))) {
      throw new UserFacingError('You need an invitation from an existing workspace owner to get access.', 403);
    }
    const { rows } = await c.query<WorkspaceRow>('INSERT INTO workspaces (id, name) VALUES ($1, $2) RETURNING *', [randomUUID(), name]);
    await c.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [rows[0]!.id, user.id]);
    return rows[0]!;
  });
}

/** Workspace name and how long ticket text is kept (Settings page). */
export async function updateWorkspaceGeneral(q: Queryable, workspaceId: string, s: { name: string; retentionDays: number }): Promise<void> {
  await q.query('UPDATE workspaces SET name = $2, retention_days = $3, updated_at = now_ms() WHERE id = $1', [workspaceId, s.name, s.retentionDays]);
}

/** Spam and duplicate limits per Discord member (Tickets › Settings). */
export async function updateTicketLimits(
  q: Queryable,
  workspaceId: string,
  s: { rateLimitCount: number; rateLimitWindowMinutes: number; duplicateWindowMinutes: number },
): Promise<void> {
  await q.query(
    'UPDATE workspaces SET rate_limit_count = $2, rate_limit_window_minutes = $3, duplicate_window_minutes = $4, updated_at = now_ms() WHERE id = $1',
    [workspaceId, s.rateLimitCount, s.rateLimitWindowMinutes, s.duplicateWindowMinutes],
  );
}

/** Ticket panel heading and introduction (null = default text). */
export async function updatePanelText(q: Queryable, workspaceId: string, s: { panelTitle: string | null; panelIntro: string | null }): Promise<void> {
  await q.query('UPDATE workspaces SET panel_title = $2, panel_intro = $3, updated_at = now_ms() WHERE id = $1', [workspaceId, s.panelTitle, s.panelIntro]);
}

/** Turns the panel's Open a ticket and My tickets buttons on or off. */
export async function setMyTickets(q: Queryable, workspaceId: string, on: boolean): Promise<void> {
  await q.query('UPDATE workspaces SET my_tickets = $2, updated_at = now_ms() WHERE id = $1', [workspaceId, on ? 1 : 0]);
}

/** What members can do on their own tickets, and the comments posted for it (stored as given; read with member-actions.ts). */
export async function setMemberActions(q: Queryable, workspaceId: string, value: unknown): Promise<void> {
  await q.query('UPDATE workspaces SET member_actions = $2, updated_at = now_ms() WHERE id = $1', [workspaceId, JSON.stringify(value)]);
}

/** The notice of who can read a report, for public and private repositories (null = default text). */
export async function updateNotices(q: Queryable, workspaceId: string, s: { public: string | null; private: string | null }): Promise<void> {
  await q.query('UPDATE workspaces SET notice_public = $2, notice_private = $3, updated_at = now_ms() WHERE id = $1', [workspaceId, s.public, s.private]);
}

/** Display names for user ids (actors in ticket activity). */
export async function userNames(q: Queryable, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!unique.length) return new Map();
  const { rows } = await q.query<{ id: string; name: string }>(
    'SELECT id, COALESCE(display_name, username) AS name FROM users WHERE id IN (SELECT value FROM json_each($1))',
    [unique],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function listMembers(q: Queryable, workspaceId: string) {
  const { rows } = await q.query<UserRow & MemberAccess & { global_mod: boolean; joined_at: Date }>(
    `SELECT u.*, ${MEMBER_COLUMNS}, m.created_at AS joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at`,
    [workspaceId],
  );
  return rows.map((r) => ({ ...r, access: accessMap(r.access) }));
}

/**
 * The people in a linked workspace through its main: the main's owner and admins, and its global
 * moderators (shown as moderators). Empty for any other workspace.
 */
export async function inheritedMembers(q: Queryable, workspaceId: string) {
  const { rows } = await q.query<UserRow & MemberAccess & { global_mod: boolean; joined_at: Date }>(
    `SELECT u.*, ${MEMBER_COLUMNS}, m.created_at AS joined_at FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.parent_id JOIN users u ON u.id = m.user_id
     WHERE w.id = $1 AND (m.role <> 'moderator' OR m.global_mod = 1)
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at`,
    [workspaceId],
  );
  return rows.map((r) => ({ ...r, access: accessMap(r.access) }));
}

/**
 * Someone stopped being in a main's linked workspaces (removed, or no longer a global moderator):
 * there, where they have no membership of their own, their coding agents lose access and the
 * tickets they claimed are free again.
 */
async function leaveLinked(q: Queryable, mainId: string, userId: string): Promise<void> {
  const linked = `SELECT w.id FROM workspaces w WHERE w.parent_id = $1
    AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.user_id = $2)`;
  await q.query(`UPDATE mcp_tokens SET revoked_at = now_ms() WHERE workspace_id IN (${linked}) AND user_id = $2 AND revoked_at IS NULL`, [mainId, userId]);
  await q.query(`UPDATE ticket_claims SET ended_at = now_ms(), end_reason = 'left' WHERE workspace_id IN (${linked}) AND user_id = $2 AND ended_at IS NULL`, [mainId, userId]);
}

export async function removeMember(db: Db, workspaceId: string, userId: string): Promise<void> {
  await withTransaction(db, async (c) => {
    const { rows } = await c.query(
      `SELECT user_id, role FROM workspace_members WHERE workspace_id = $1`,
      [workspaceId],
    );
    const target = rows.find((r) => r.user_id === userId);
    if (!target) throw new UserFacingError('That person is not a member of this workspace.', 404);
    if (target.role === 'owner' && rows.filter((r) => r.role === 'owner').length <= 1) {
      throw new UserFacingError('A workspace must keep at least one owner.');
    }
    await c.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
    // Their coding agents lose access, and the tickets they claimed are free again.
    await c.query('UPDATE mcp_tokens SET revoked_at = now_ms() WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL', [workspaceId, userId]);
    await c.query(`UPDATE ticket_claims SET ended_at = now_ms(), end_reason = 'left' WHERE workspace_id = $1 AND user_id = $2 AND ended_at IS NULL`, [workspaceId, userId]);
    await leaveLinked(c, workspaceId, userId);
  });
}

/**
 * A one-time invite link. `global`: a moderator who is also in every linked workspace. A linked
 * workspace only invites moderators of its own (its admins and global moderators come from its main).
 */
export async function createInvite(q: Queryable, workspaceId: string, createdBy: string, role: 'admin' | 'moderator' = 'admin', o: { global?: boolean } = {}): Promise<string> {
  const ws = await getWorkspace(q, workspaceId);
  if (ws?.parent_id && role !== 'moderator') throw new UserFacingError('A linked workspace only has moderators of its own. Make admins in its main workspace.');
  const token = randomToken(24);
  await q.query(
    `INSERT INTO workspace_invites (id, workspace_id, token_hash, created_by, expires_at, role, global_mod)
     VALUES ($4, $1, $2, $3, now_ms() + 604800000, $5, $6)`,
    [workspaceId, sha256(token), createdBy, randomUUID(), role, role === 'moderator' && Boolean(o.global) && !ws?.parent_id],
  );
  return token;
}

export async function listInvites(q: Queryable, workspaceId: string) {
  const { rows } = await q.query(
    `SELECT i.id, i.role, i.global_mod, i.created_at, i.expires_at, COALESCE(u.display_name, u.username) AS created_by_name
     FROM workspace_invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.workspace_id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now_ms()
     ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return rows as { id: string; role: 'admin' | 'moderator'; global_mod: boolean; created_at: Date; expires_at: Date; created_by_name: string | null }[];
}

export async function revokeInvite(q: Queryable, workspaceId: string, inviteId: string): Promise<void> {
  await q.query('UPDATE workspace_invites SET revoked_at = now_ms() WHERE id = $1 AND workspace_id = $2', [inviteId, workspaceId]);
}

export async function findInvite(q: Queryable, token: string) {
  const { rows } = await q.query(
    `SELECT i.id, i.workspace_id, i.role, i.global_mod, w.name AS workspace_name FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now_ms()`,
    [sha256(token)],
  );
  return (rows[0] as { id: string; workspace_id: string; role: 'admin' | 'moderator'; global_mod: boolean; workspace_name: string } | undefined) ?? null;
}

export async function acceptInvite(db: Db, token: string, userId: string): Promise<string> {
  return withTransaction(db, async (c) => {
    const { rows } = await c.query(
      `UPDATE workspace_invites SET used_at = now_ms(), used_by = $2
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now_ms()
       RETURNING workspace_id, role, global_mod`,
      [sha256(token), userId],
    );
    if (!rows[0]) throw new UserFacingError('This invitation link is invalid, expired or has already been used.', 404);
    await c.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, access, global_mod) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [rows[0].workspace_id, userId, rows[0].role, rows[0].role === 'moderator' ? NEW_MODERATOR_ACCESS : {}, rows[0].role === 'moderator' && Boolean(rows[0].global_mod)],
    );
    return rows[0].workspace_id as string;
  });
}

/**
 * Owner only: make a member an Admin, a Moderator or (in a main workspace) a Global moderator, who
 * is also in every linked workspace. The owner's own role can't change here, and a linked
 * workspace has no admins of its own.
 */
export async function setMemberRole(db: Db, workspaceId: string, userId: string, role: 'admin' | 'moderator', o: { global?: boolean } = {}): Promise<void> {
  await withTransaction(db, async (q) => {
    const ws = await getWorkspace(q, workspaceId);
    if (ws?.parent_id && role !== 'moderator') throw new UserFacingError('A linked workspace only has moderators of its own. Make admins in its main workspace.');
    const { rows } = await q.query<{ role: Role; global_mod: boolean }>('SELECT role, global_mod FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
    if (!rows[0]) throw new UserFacingError('That person is not a member of this workspace.', 404);
    if (rows[0].role === 'owner') throw new UserFacingError('The owner’s role can’t be changed.');
    const global = role === 'moderator' && Boolean(o.global) && !ws?.parent_id;
    // An admin who becomes a moderator keeps the access they had as one, or starts like a new moderator.
    await q.query(
      `UPDATE workspace_members SET role = $3, global_mod = $5, access = CASE WHEN $3 = 'moderator' AND role <> 'moderator' AND access = '{}' THEN $4 ELSE access END
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId, role, NEW_MODERATOR_ACCESS, global],
    );
    // No longer in the linked workspaces: an admin or global moderator who became a moderator here only.
    if (role === 'moderator' && !global && (rows[0].role !== 'moderator' || rows[0].global_mod)) await leaveLinked(q, workspaceId, userId);
  });
}

/**
 * Owners and admins: changes a moderator's level on the pages given ("none" removes it); the
 * other pages keep theirs. Unknown pages are ignored, and Edit on a page without anything to
 * change is stored as View. Returns the new access map.
 */
export async function setModeratorAccess(q: Queryable, workspaceId: string, userId: string, changes: Partial<Record<string, unknown>>): Promise<MemberAccess['access']> {
  const { rows } = await q.query<{ access: unknown }>(`SELECT access FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'moderator'`, [workspaceId, userId]);
  if (!rows[0]) throw new UserFacingError('Only moderators have adjustable permissions.', 404);
  const next = { ...accessMap(rows[0].access) };
  for (const a of AREA_KEYS) {
    const v = changes[a];
    if (v === undefined) continue;
    if (v === 'edit' || v === 'view') next[a] = v === 'edit' && hasEdit(a) ? 'edit' : 'view';
    else delete next[a];
  }
  await q.query(`UPDATE workspace_members SET access = $3 WHERE workspace_id = $1 AND user_id = $2 AND role = 'moderator'`, [workspaceId, userId, next]);
  return next;
}

/** Owners and admins: the MCP tools a moderator's agents can use (exactly these; unknown ones are ignored). */
export async function setMcpAccess(q: Queryable, workspaceId: string, userId: string, switches: unknown[]): Promise<McpSwitch[]> {
  const { rows } = await q.query<{ access: unknown }>(`SELECT access FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'moderator'`, [workspaceId, userId]);
  if (!rows[0]) throw new UserFacingError('Only moderators have adjustable permissions.', 404);
  const on = MCP_SWITCH_KEYS.filter((s) => switches.includes(s));
  const next = { ...accessMap(rows[0].access) };
  if (on.length) next.mcp = on;
  else delete next.mcp;
  await q.query(`UPDATE workspace_members SET access = $3 WHERE workspace_id = $1 AND user_id = $2 AND role = 'moderator'`, [workspaceId, userId, next]);
  return on;
}

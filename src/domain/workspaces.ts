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
}

const MEMBER_COLUMNS = 'm.role, m.access';

/** What a new moderator can do: see tickets (always) and contributor verifications. */
const NEW_MODERATOR_ACCESS: MemberAccess['access'] = { verifications: 'view' };

function accessMap(v: unknown): MemberAccess['access'] {
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as MemberAccess['access'];
}

function toMembership(row: Record<string, unknown>): Membership {
  const { role, access, ...workspace } = row;
  return { workspace: workspace as unknown as WorkspaceRow, role: role as Role, access: accessMap(access) };
}

export async function listMemberships(q: Queryable, userId: string): Promise<Membership[]> {
  const { rows } = await q.query(
    `SELECT w.*, ${MEMBER_COLUMNS} FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY w.created_at`,
    [userId],
  );
  return rows.map(toMembership);
}

/** Returns the membership only if the user belongs to the workspace. */
export async function getMembership(q: Queryable, userId: string, workspaceId: string): Promise<Membership | null> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return null;
  const { rows } = await q.query(
    `SELECT w.*, ${MEMBER_COLUMNS} FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.workspace_id = $2`,
    [userId, workspaceId],
  );
  return rows[0] ? toMembership(rows[0]) : null;
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
  const { rows } = await q.query<UserRow & MemberAccess & { joined_at: Date }>(
    `SELECT u.*, ${MEMBER_COLUMNS}, m.created_at AS joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at`,
    [workspaceId],
  );
  return rows.map((r) => ({ ...r, access: accessMap(r.access) }));
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
  });
}

export async function createInvite(q: Queryable, workspaceId: string, createdBy: string, role: 'admin' | 'moderator' = 'admin'): Promise<string> {
  const token = randomToken(24);
  await q.query(
    `INSERT INTO workspace_invites (id, workspace_id, token_hash, created_by, expires_at, role)
     VALUES ($4, $1, $2, $3, now_ms() + 604800000, $5)`,
    [workspaceId, sha256(token), createdBy, randomUUID(), role],
  );
  return token;
}

export async function listInvites(q: Queryable, workspaceId: string) {
  const { rows } = await q.query(
    `SELECT i.id, i.role, i.created_at, i.expires_at, COALESCE(u.display_name, u.username) AS created_by_name
     FROM workspace_invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.workspace_id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now_ms()
     ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return rows as { id: string; role: 'admin' | 'moderator'; created_at: Date; expires_at: Date; created_by_name: string | null }[];
}

export async function revokeInvite(q: Queryable, workspaceId: string, inviteId: string): Promise<void> {
  await q.query('UPDATE workspace_invites SET revoked_at = now_ms() WHERE id = $1 AND workspace_id = $2', [inviteId, workspaceId]);
}

export async function findInvite(q: Queryable, token: string) {
  const { rows } = await q.query(
    `SELECT i.id, i.workspace_id, i.role, w.name AS workspace_name FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now_ms()`,
    [sha256(token)],
  );
  return (rows[0] as { id: string; workspace_id: string; role: 'admin' | 'moderator'; workspace_name: string } | undefined) ?? null;
}

export async function acceptInvite(db: Db, token: string, userId: string): Promise<string> {
  return withTransaction(db, async (c) => {
    const { rows } = await c.query(
      `UPDATE workspace_invites SET used_at = now_ms(), used_by = $2
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now_ms()
       RETURNING workspace_id, role`,
      [sha256(token), userId],
    );
    if (!rows[0]) throw new UserFacingError('This invitation link is invalid, expired or has already been used.', 404);
    await c.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, access) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [rows[0].workspace_id, userId, rows[0].role, rows[0].role === 'moderator' ? NEW_MODERATOR_ACCESS : {}],
    );
    return rows[0].workspace_id as string;
  });
}

/** Owner only: switch a member between Admin and Moderator. The owner's own role can't change here. */
export async function setMemberRole(q: Queryable, workspaceId: string, userId: string, role: 'admin' | 'moderator'): Promise<void> {
  const { rows } = await q.query<{ role: Role }>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  if (!rows[0]) throw new UserFacingError('That person is not a member of this workspace.', 404);
  if (rows[0].role === 'owner') throw new UserFacingError('The owner’s role can’t be changed.');
  // An admin who becomes a moderator keeps the access they had as one, or starts like a new moderator.
  await q.query(
    `UPDATE workspace_members SET role = $3, access = CASE WHEN $3 = 'moderator' AND role <> 'moderator' AND access = '{}' THEN $4 ELSE access END
     WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId, role, NEW_MODERATOR_ACCESS],
  );
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

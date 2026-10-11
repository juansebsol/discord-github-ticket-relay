import { withTransaction, type Db, type Queryable } from '../db/database.js';
import { randomUUID } from 'node:crypto';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { Config } from '../config.js';
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

export interface Membership {
  workspace: WorkspaceRow;
  role: Role;
}

export async function listMemberships(q: Queryable, userId: string): Promise<Membership[]> {
  const { rows } = await q.query(
    `SELECT w.*, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY w.created_at`,
    [userId],
  );
  return rows.map(({ role, ...workspace }) => ({ workspace: workspace as WorkspaceRow, role }));
}

/** Returns the membership only if the user belongs to the workspace. */
export async function getMembership(q: Queryable, userId: string, workspaceId: string): Promise<Membership | null> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return null;
  const { rows } = await q.query(
    `SELECT w.*, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.workspace_id = $2`,
    [userId, workspaceId],
  );
  if (!rows[0]) return null;
  const { role, ...workspace } = rows[0];
  return { workspace: workspace as WorkspaceRow, role };
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

export interface WorkspaceSettingsInput {
  name: string;
  rateLimitCount: number;
  rateLimitWindowMinutes: number;
  duplicateWindowMinutes: number;
  retentionDays: number;
  panelTitle: string | null;
  panelIntro: string | null;
}

export async function updateWorkspaceSettings(q: Queryable, workspaceId: string, s: WorkspaceSettingsInput): Promise<void> {
  await q.query(
    `UPDATE workspaces SET name = $2, rate_limit_count = $3, rate_limit_window_minutes = $4,
       duplicate_window_minutes = $5, retention_days = $6, panel_title = $7, panel_intro = $8, updated_at = now_ms()
     WHERE id = $1`,
    [workspaceId, s.name, s.rateLimitCount, s.rateLimitWindowMinutes, s.duplicateWindowMinutes, s.retentionDays, s.panelTitle, s.panelIntro],
  );
}

export async function listMembers(q: Queryable, workspaceId: string) {
  const { rows } = await q.query<UserRow & { role: Role; joined_at: Date }>(
    `SELECT u.*, m.role, m.created_at AS joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 ORDER BY m.role DESC, m.created_at`,
    [workspaceId],
  );
  return rows;
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
  });
}

export async function createInvite(q: Queryable, workspaceId: string, createdBy: string): Promise<string> {
  const token = randomToken(24);
  await q.query(
    `INSERT INTO workspace_invites (id, workspace_id, token_hash, created_by, expires_at)
     VALUES ($4, $1, $2, $3, now_ms() + 604800000)`,
    [workspaceId, sha256(token), createdBy, randomUUID()],
  );
  return token;
}

export async function listInvites(q: Queryable, workspaceId: string) {
  const { rows } = await q.query(
    `SELECT id, created_at, expires_at FROM workspace_invites
     WHERE workspace_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now_ms()
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows as { id: string; created_at: Date; expires_at: Date }[];
}

export async function revokeInvite(q: Queryable, workspaceId: string, inviteId: string): Promise<void> {
  await q.query('UPDATE workspace_invites SET revoked_at = now_ms() WHERE id = $1 AND workspace_id = $2', [inviteId, workspaceId]);
}

export async function findInvite(q: Queryable, token: string) {
  const { rows } = await q.query(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now_ms()`,
    [sha256(token)],
  );
  return (rows[0] as { id: string; workspace_id: string; workspace_name: string } | undefined) ?? null;
}

export async function acceptInvite(db: Db, token: string, userId: string): Promise<string> {
  return withTransaction(db, async (c) => {
    const { rows } = await c.query(
      `UPDATE workspace_invites SET used_at = now_ms(), used_by = $2
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now_ms()
       RETURNING workspace_id`,
      [sha256(token), userId],
    );
    if (!rows[0]) throw new UserFacingError('This invitation link is invalid, expired or has already been used.', 404);
    await c.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
      [rows[0].workspace_id, userId],
    );
    return rows[0].workspace_id as string;
  });
}

import type { Queryable } from '../db/pool.js';
import { randomCode } from '../lib/crypto.js';
import {
  UserFacingError,
  type AppRow,
  type DiscordConnectionRow,
  type GitHubConnectionRow,
  type PanelRow,
} from './types.js';

// ---- GitHub connection --------------------------------------------------------------------

export async function getGitHubConnection(q: Queryable, workspaceId: string): Promise<GitHubConnectionRow | null> {
  const { rows } = await q.query<GitHubConnectionRow>('SELECT * FROM github_connections WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

export async function saveGitHubConnection(
  q: Queryable,
  workspaceId: string,
  c: { installationId: number; accountLogin: string; accountType: string; accountAvatarUrl: string | null; repositorySelection: string; suspended: boolean },
  userId: string,
): Promise<void> {
  await q.query(
    `INSERT INTO github_connections (workspace_id, installation_id, account_login, account_type, account_avatar_url,
       repository_selection, status, status_detail, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
     ON CONFLICT (workspace_id) DO UPDATE SET installation_id = EXCLUDED.installation_id,
       account_login = EXCLUDED.account_login, account_type = EXCLUDED.account_type,
       account_avatar_url = EXCLUDED.account_avatar_url, repository_selection = EXCLUDED.repository_selection,
       status = EXCLUDED.status, status_detail = NULL, connected_by = EXCLUDED.connected_by,
       connected_at = now(), updated_at = now()`,
    [workspaceId, c.installationId, c.accountLogin, c.accountType, c.accountAvatarUrl, c.repositorySelection, c.suspended ? 'suspended' : 'active', userId],
  );
}

export async function setGitHubStatusByInstallation(
  q: Queryable,
  installationId: number,
  status: GitHubConnectionRow['status'],
  detail: string | null,
): Promise<number> {
  const res = await q.query(
    'UPDATE github_connections SET status = $2, status_detail = $3, updated_at = now() WHERE installation_id = $1',
    [installationId, status, detail],
  );
  return res.rowCount ?? 0;
}

export async function setGitHubStatus(q: Queryable, workspaceId: string, status: GitHubConnectionRow['status'], detail: string | null) {
  await q.query('UPDATE github_connections SET status = $2, status_detail = $3, updated_at = now() WHERE workspace_id = $1', [
    workspaceId,
    status,
    detail,
  ]);
}

export async function deleteGitHubConnection(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('DELETE FROM github_connections WHERE workspace_id = $1', [workspaceId]);
}

// ---- Discord connection -------------------------------------------------------------------

export async function getDiscordConnection(q: Queryable, workspaceId: string): Promise<DiscordConnectionRow | null> {
  const { rows } = await q.query<DiscordConnectionRow>('SELECT * FROM discord_connections WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

export async function getDiscordConnectionByGuild(q: Queryable, guildId: string): Promise<DiscordConnectionRow | null> {
  const { rows } = await q.query<DiscordConnectionRow>('SELECT * FROM discord_connections WHERE guild_id = $1', [guildId]);
  return rows[0] ?? null;
}

/**
 * Binds a Discord server to a workspace. A server can only belong to one workspace,
 * because interactions are routed by server ID.
 */
export async function saveDiscordGuild(
  q: Queryable,
  workspaceId: string,
  guild: { id: string; name: string; icon: string | null },
  userId: string,
): Promise<void> {
  const owner = await getDiscordConnectionByGuild(q, guild.id);
  if (owner && owner.workspace_id !== workspaceId) {
    throw new UserFacingError('That Discord server is already connected to another workspace. Disconnect it there first.', 409);
  }
  const current = await getDiscordConnection(q, workspaceId);
  const sameGuild = current?.guild_id === guild.id;
  try {
    await q.query(
      `INSERT INTO discord_connections (workspace_id, guild_id, guild_name, guild_icon, connected_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE SET guild_id = EXCLUDED.guild_id, guild_name = EXCLUDED.guild_name,
         guild_icon = EXCLUDED.guild_icon, status = 'active', status_detail = NULL,
         tickets_channel_id = CASE WHEN $6 THEN discord_connections.tickets_channel_id ELSE NULL END,
         tickets_channel_name = CASE WHEN $6 THEN discord_connections.tickets_channel_name ELSE NULL END,
         connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
      [workspaceId, guild.id, guild.name, guild.icon, userId, sameGuild],
    );
  } catch (err) {
    if (uniqueViolation(err)) {
      throw new UserFacingError('That Discord server is already connected to another workspace. Disconnect it there first.', 409);
    }
    throw err;
  }
}

export async function setTicketsChannel(q: Queryable, workspaceId: string, channel: { id: string; name: string }): Promise<void> {
  await q.query(
    `UPDATE discord_connections SET tickets_channel_id = $2, tickets_channel_name = $3, updated_at = now() WHERE workspace_id = $1`,
    [workspaceId, channel.id, channel.name],
  );
}

export async function setDiscordStatus(q: Queryable, workspaceId: string, status: DiscordConnectionRow['status'], detail: string | null) {
  await q.query('UPDATE discord_connections SET status = $2, status_detail = $3, updated_at = now() WHERE workspace_id = $1', [
    workspaceId,
    status,
    detail,
  ]);
}

export async function deleteDiscordConnection(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('DELETE FROM discord_connections WHERE workspace_id = $1', [workspaceId]);
}

// ---- Apps ---------------------------------------------------------------------------------

export async function listApps(q: Queryable, workspaceId: string): Promise<AppRow[]> {
  const { rows } = await q.query<AppRow>('SELECT * FROM apps WHERE workspace_id = $1 ORDER BY position, lower(name)', [workspaceId]);
  return rows;
}

export async function getApp(q: Queryable, workspaceId: string, appId: string): Promise<AppRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(appId)) return null;
  const { rows } = await q.query<AppRow>('SELECT * FROM apps WHERE workspace_id = $1 AND id = $2', [workspaceId, appId]);
  return rows[0] ?? null;
}

export async function getAppByPublicId(q: Queryable, workspaceId: string, publicId: string): Promise<AppRow | null> {
  const { rows } = await q.query<AppRow>('SELECT * FROM apps WHERE workspace_id = $1 AND public_id = $2', [workspaceId, publicId]);
  return rows[0] ?? null;
}

export interface AppInput {
  name: string;
  description: string | null;
  repo: { id: number; owner: string; name: string; private: boolean };
  labels: string[];
  enabled: boolean;
}

function uniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

export async function createApp(q: Queryable, workspaceId: string, input: AppInput): Promise<AppRow> {
  try {
    const { rows } = await q.query<AppRow>(
      `INSERT INTO apps (workspace_id, public_id, name, description, repo_id, repo_owner, repo_name, repo_private, labels, enabled, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         COALESCE((SELECT max(position) + 1 FROM apps WHERE workspace_id = $1), 0))
       RETURNING *`,
      [workspaceId, randomCode(10), input.name, input.description, input.repo.id, input.repo.owner, input.repo.name, input.repo.private, input.labels, input.enabled],
    );
    return rows[0]!;
  } catch (err) {
    if (uniqueViolation(err)) throw new UserFacingError(`An app named “${input.name}” already exists.`, 409);
    throw err;
  }
}

export async function updateApp(q: Queryable, workspaceId: string, appId: string, input: AppInput): Promise<void> {
  try {
    await q.query(
      `UPDATE apps SET name = $3, description = $4, repo_id = $5, repo_owner = $6, repo_name = $7, repo_private = $8,
         labels = $9, enabled = $10, updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, appId, input.name, input.description, input.repo.id, input.repo.owner, input.repo.name, input.repo.private, input.labels, input.enabled],
    );
  } catch (err) {
    if (uniqueViolation(err)) throw new UserFacingError(`An app named “${input.name}” already exists.`, 409);
    throw err;
  }
}

export async function setAppEnabled(q: Queryable, workspaceId: string, appId: string, enabled: boolean): Promise<void> {
  await q.query('UPDATE apps SET enabled = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, appId, enabled]);
}

export async function deleteApp(q: Queryable, workspaceId: string, appId: string): Promise<void> {
  await q.query('DELETE FROM apps WHERE workspace_id = $1 AND id = $2', [workspaceId, appId]);
}

export async function moveApp(q: Queryable, workspaceId: string, appId: string, direction: 'up' | 'down'): Promise<void> {
  const apps = await listApps(q, workspaceId);
  const index = apps.findIndex((a) => a.id === appId);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= apps.length) return;
  [apps[index], apps[swapWith]] = [apps[swapWith]!, apps[index]!];
  for (let i = 0; i < apps.length; i++) {
    await q.query('UPDATE apps SET position = $3 WHERE workspace_id = $1 AND id = $2', [workspaceId, apps[i]!.id, i]);
  }
}

/** Refreshes repository names/visibility after a rename or transfer (matched by stable repo ID). */
export async function refreshAppRepo(q: Queryable, workspaceId: string, repo: { id: number; owner: string; name: string; private: boolean }) {
  await q.query(
    `UPDATE apps SET repo_owner = $3, repo_name = $4, repo_private = $5, updated_at = now()
     WHERE workspace_id = $1 AND repo_id = $2 AND (repo_owner <> $3 OR repo_name <> $4 OR repo_private <> $5)`,
    [workspaceId, repo.id, repo.owner, repo.name, repo.private],
  );
}

// ---- Panel --------------------------------------------------------------------------------

export async function getPanel(q: Queryable, workspaceId: string): Promise<PanelRow | null> {
  const { rows } = await q.query<PanelRow>('SELECT * FROM panels WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

export async function savePanel(
  q: Queryable,
  workspaceId: string,
  p: { channelId: string; messageId: string; contentHash: string },
  userId: string | null,
): Promise<void> {
  await q.query(
    `INSERT INTO panels (workspace_id, channel_id, message_id, content_hash, status, published_by, last_checked_at)
     VALUES ($1, $2, $3, $4, 'published', $5, now())
     ON CONFLICT (workspace_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id,
       content_hash = EXCLUDED.content_hash, status = 'published', published_by = EXCLUDED.published_by,
       published_at = now(), last_checked_at = now(), last_error = NULL`,
    [workspaceId, p.channelId, p.messageId, p.contentHash, userId],
  );
}

export async function markPanel(q: Queryable, workspaceId: string, status: PanelRow['status'], error: string | null): Promise<void> {
  await q.query('UPDATE panels SET status = $2, last_error = $3, last_checked_at = now() WHERE workspace_id = $1', [
    workspaceId,
    status,
    error,
  ]);
}

export async function deletePanel(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('DELETE FROM panels WHERE workspace_id = $1', [workspaceId]);
}

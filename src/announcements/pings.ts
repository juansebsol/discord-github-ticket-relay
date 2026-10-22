/**
 * Release announcements: the "Get update pings" message, with a button per role announcements
 * ping (the workspace's, and any app's own). Members click to get the role, and again to drop it.
 */
import type { Queryable } from '../db/database.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/client.js';
import * as m from '../discord/messages.js';
import { elevatedPermissions } from '../discord/permissions.js';
import { listApps } from '../domain/store.js';
import { UserFacingError, type AppRow, type Deps, type DiscordConnectionRow, type WorkspaceRow } from '../domain/types.js';
import { sha256 } from '../lib/crypto.js';
import { announcedRepos, appAnnounceSettings, getAnnouncementSettings, PANEL_DEFAULTS, targetFor, type AnnouncementSettings, type AppAnnounceSettings } from './settings.js';

export const PING_PREFIX = 'an:role:';
const MAX_BUTTONS = 25;

export interface PingRole {
  id: string;
  name: string;
  /** The apps whose releases ping it. */
  apps: string[];
}

/** Every role announcements ping, with the apps for each (the workspace's role first). */
export function pingRoles(s: AnnouncementSettings, apps: AppRow[], appSettings: Map<string, AppAnnounceSettings>): PingRole[] {
  if (!s.pingEnabled) return [];
  const out = new Map<string, PingRole>();
  if (s.roleId) out.set(s.roleId, { id: s.roleId, name: s.roleName ?? 'role', apps: [] });
  for (const app of announcedRepos(apps, appSettings)) {
    const t = targetFor(s, appSettings.get(app.id));
    if (!t.roleId) continue;
    const role = out.get(t.roleId) ?? { id: t.roleId, name: t.roleName ?? 'role', apps: [] };
    role.apps.push(app.name);
    out.set(t.roleId, role);
  }
  return [...out.values()].filter((r) => r.apps.length).slice(0, MAX_BUTTONS);
}

export async function workspacePingRoles(q: Queryable, workspaceId: string, s?: AnnouncementSettings): Promise<PingRole[]> {
  return pingRoles(s ?? (await getAnnouncementSettings(q, workspaceId)), await listApps(q, workspaceId), await appAnnounceSettings(q, workspaceId));
}

/** The message: the intro, which role is for which apps, and a button per role. */
export function pingPanelPayload(s: Pick<AnnouncementSettings, 'panelTitle' | 'panelIntro'>, roles: PingRole[]) {
  const lines = roles.map((r) => `- <@&${r.id}>: ${r.apps.join(', ')}`);
  const buttons = roles.map((r) => ({ type: m.ComponentType.Button, style: 2, label: m.truncate(r.name, 80), custom_id: `${PING_PREFIX}${r.id}` }));
  const rows: { type: number; components: typeof buttons }[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: m.ComponentType.ActionRow, components: buttons.slice(i, i + 5) });
  return {
    content: '',
    embeds: [{
      title: m.truncate(s.panelTitle?.trim() || PANEL_DEFAULTS.title, 256),
      description: m.truncate([s.panelIntro?.trim() || PANEL_DEFAULTS.intro, lines.join('\n')].filter(Boolean).join('\n\n'), 4096),
      color: 0x5865f2,
    }],
    components: rows,
    allowed_mentions: m.NO_MENTIONS,
  };
}

export interface PingPanelRow {
  channel_id: string;
  message_id: string;
  content_hash: string;
  status: 'published' | 'missing';
  published_at: Date;
}

export async function getPingPanel(q: Queryable, workspaceId: string): Promise<PingPanelRow | null> {
  const { rows } = await q.query<PingPanelRow>('SELECT * FROM announcement_panels WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

function explain(err: unknown): UserFacingError {
  if (err instanceof DiscordApiError) {
    if (err.code === DiscordErrorCode.MissingAccess || err.code === DiscordErrorCode.MissingPermissions) {
      return new UserFacingError('The bot is missing permissions in that channel. It needs View Channel, Send Messages, Embed Links and Read Message History.');
    }
    if (err.code === DiscordErrorCode.UnknownChannel) return new UserFacingError('That channel no longer exists. Choose another channel in Settings.');
    if (err.status === 429) return new UserFacingError('Discord is rate limiting the bot. Try again in a minute.', 429);
  }
  return new UserFacingError('Discord did not accept the message. Try again in a moment.', 502);
}

/** Posts the message in the announcements channel, or updates it (moved when the channel changed). */
export async function publishPingPanel(deps: Deps, workspaceId: string, userId: string | null): Promise<'created' | 'updated' | 'moved'> {
  const discord = deps.discord;
  if (!discord) throw new UserFacingError('Discord is not configured on this deployment.');
  const s = await getAnnouncementSettings(deps.db, workspaceId);
  if (!s.channelId) throw new UserFacingError('Choose the announcements channel in Settings first.');
  const roles = await workspacePingRoles(deps.db, workspaceId, s);
  if (!roles.length) throw new UserFacingError('Turn on pings and choose a role in Settings first.');
  const payload = pingPanelPayload(s, roles);
  const hash = sha256(JSON.stringify(payload));
  const existing = await getPingPanel(deps.db, workspaceId);
  const save = (messageId: string) => deps.db.query(
    `INSERT INTO announcement_panels (workspace_id, channel_id, message_id, content_hash, status, published_by) VALUES ($1, $2, $3, $4, 'published', $5)
     ON CONFLICT (workspace_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, content_hash = excluded.content_hash,
       status = 'published', published_by = excluded.published_by, published_at = now_ms()`,
    [workspaceId, s.channelId, messageId, hash, userId],
  );
  if (existing && existing.channel_id === s.channelId) {
    try {
      await discord.editMessage(existing.channel_id, existing.message_id, payload);
      await save(existing.message_id);
      return 'updated';
    } catch (err) {
      if (!(err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMessage)) throw explain(err);
    }
  }
  let created: { id: string };
  try {
    created = await discord.createMessage(s.channelId, payload);
  } catch (err) {
    throw explain(err);
  }
  await save(created.id);
  if (existing && existing.channel_id !== s.channelId) {
    await discord.deleteMessage(existing.channel_id, existing.message_id).catch(() => {});
    return 'moved';
  }
  return 'created';
}

export type PingPanelState =
  | { state: 'not_published' }
  | { state: 'missing' }
  | { state: 'published'; outdated: boolean; channelChanged: boolean; link: string | null };

/** The posted message against the settings now. `live: false` skips asking Discord whether it still exists. */
export async function checkPingPanel(deps: Deps, workspaceId: string, conn: DiscordConnectionRow | null, o: { live: boolean } = { live: true }): Promise<PingPanelState> {
  const panel = await getPingPanel(deps.db, workspaceId);
  if (!panel) return { state: 'not_published' };
  if (!o.live && panel.status === 'missing') return { state: 'missing' };
  if (deps.discord && o.live) {
    try {
      await deps.discord.getMessage(panel.channel_id, panel.message_id);
    } catch (err) {
      if (err instanceof DiscordApiError && (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.UnknownChannel)) {
        await deps.db.query(`UPDATE announcement_panels SET status = 'missing' WHERE workspace_id = $1`, [workspaceId]);
        return { state: 'missing' };
      }
    }
  }
  const s = await getAnnouncementSettings(deps.db, workspaceId);
  const hash = sha256(JSON.stringify(pingPanelPayload(s, await workspacePingRoles(deps.db, workspaceId, s))));
  return {
    state: 'published',
    outdated: hash !== panel.content_hash,
    channelChanged: s.channelId !== panel.channel_id,
    link: conn ? `https://discord.com/channels/${conn.guild_id}/${panel.channel_id}/${panel.message_id}` : null,
  };
}

export async function unpublishPingPanel(deps: Deps, workspaceId: string): Promise<void> {
  const panel = await getPingPanel(deps.db, workspaceId);
  if (!panel) return;
  if (deps.discord) await deps.discord.deleteMessage(panel.channel_id, panel.message_id).catch(() => {});
  await deps.db.query('DELETE FROM announcement_panels WHERE workspace_id = $1', [workspaceId]);
}

// ---- A member clicks a button ------------------------------------------------------------------------

interface MemberInteraction {
  token: string;
  guild_id?: string;
  member?: { roles?: string[]; user: { id: string } };
  data?: { custom_id?: string };
}

function notice(title: string, description: string, tone: 'warning' | 'danger' = 'warning') {
  return m.noticeMessage(title, description, tone);
}

/**
 * Adds the role, or takes it away when the member has it. Only a role announcements ping can be
 * given this way. Answered at once ("thinking…"), then the change is made and the answer filled in.
 */
export async function handlePingComponent(deps: Deps, i: MemberInteraction, workspace: WorkspaceRow): Promise<{ response: unknown; after?: () => Promise<void> }> {
  const roleId = (i.data?.custom_id ?? '').slice(PING_PREFIX.length);
  const s = await getAnnouncementSettings(deps.db, workspace.id);
  const role = s.enabled ? (await workspacePingRoles(deps.db, workspace.id, s)).find((r) => r.id === roleId) : undefined;
  if (!role || !i.guild_id || !i.member) {
    return { response: { type: 4, data: notice('Not available', 'Update pings for this button are turned off right now.') } };
  }
  const has = (i.member.roles ?? []).includes(role.id);
  const discord = deps.discord!;
  const guildId = i.guild_id;
  const userId = i.member.user.id;
  return {
    response: { type: 5, data: { flags: m.EPHEMERAL } },
    after: async () => {
      let reply;
      try {
        // Checked again now: a role given moderator permissions since isn't handed out.
        const live = (await discord.listRoles(guildId)).find((r) => r.id === role.id);
        if (!live || elevatedPermissions(live.permissions).length) {
          deps.log.warn({ workspace: workspace.id, role: role.id }, 'update ping role refused: it has moderator permissions or is gone');
          await discord.editOriginalResponse(i.token, notice('Not available', 'This button can’t give its role right now. Please let a moderator know.'));
          return;
        }
        if (has) await discord.removeMemberRole(guildId, userId, role.id, 'Turned off update pings');
        else await discord.addMemberRole(guildId, userId, role.id, 'Turned on update pings');
        reply = m.pingToggledMessage(!has, role.apps);
      } catch (err) {
        deps.log.warn({ workspace: workspace.id, role: role.id, err: (err as Error).message }, 'update ping role change failed');
        reply = notice('Couldn’t change your pings', 'The bot couldn’t change your role. Please let a moderator know.', 'danger');
      }
      await discord.editOriginalResponse(i.token, reply).catch((err) => deps.log.warn({ err: (err as Error).message }, 'update ping reply failed'));
    },
  };
}

import { DiscordApiError, DiscordErrorCode } from '../discord/client.js';
import { buildPanelMessage, type PanelApp, type PanelSection } from '../discord/messages.js';
import type { Queryable } from '../db/database.js';
import { sha256 } from '../lib/crypto.js';
import { panelApps, panelWorkspaces, withScope } from './linked.js';
import { deletePanel, getDiscordConnection, getPanel, markPanel, savePanel } from './store.js';
import { UserFacingError, type AppRow, type Deps, type WorkspaceRow } from './types.js';
import { enabledTicketTypes } from './ticket-types.js';
import { getWorkspace } from './workspaces.js';

export function panelApp(a: Pick<AppRow, 'public_id' | 'name' | 'description'>): PanelApp {
  return { publicId: a.public_id, name: a.name, description: a.description };
}

/** A workspace's menu name on a panel with apps from several: its own (Discord tickets › Panel), or its name. */
export function sectionTitle(ws: Pick<WorkspaceRow, 'name' | 'panel_section_title'>): string {
  return ws.panel_section_title?.trim() || ws.name;
}

/** The panel's enabled apps by workspace, in panel order, leaving out workspaces with none. */
export function panelSectionsOf(family: WorkspaceRow[], apps: AppRow[]): PanelSection[] {
  return family
    .map((w) => ({ id: w.id, title: sectionTitle(w), apps: apps.filter((a) => a.enabled && a.workspace_id === w.id).map(panelApp) }))
    .filter((s) => s.apps.length > 0);
}

/** For the private menu (Open a ticket, "More apps…"): the panel's enabled apps, and by workspace. */
export async function panelSections(q: Queryable, workspace: WorkspaceRow): Promise<{ apps: AppRow[]; sections: PanelSection[] }> {
  const [apps, family] = await Promise.all([panelApps(q, workspace), panelWorkspaces(q, workspace)]);
  const enabled = apps.filter((a) => a.enabled);
  return { apps: enabled, sections: panelSectionsOf(family, enabled) };
}

/**
 * The panel message for these apps (a main's include its linked workspaces' on it, in a menu for
 * each workspace). A linked workspace's own panel tags its custom_ids with its ID, so its clicks
 * come back to it.
 */
export function panelPayloadFor(workspace: WorkspaceRow, apps: AppRow[], hasTypes = false, family: WorkspaceRow[] = [workspace]) {
  const payload = withScope(buildPanelMessage({
    hasTypes,
    myTickets: workspace.my_tickets,
    title: workspace.panel_title,
    intro: workspace.panel_intro,
    apps: apps.filter((a) => a.enabled).map(panelApp),
    sections: panelSectionsOf(family, apps),
  }), workspace.parent_id ? workspace.id : null);
  return { payload, hash: sha256(JSON.stringify(payload)) };
}

/** The panel's apps and workspaces, and whether any of them has ticket types (the steps mention choosing one). */
export async function panelContent(deps: Pick<Deps, 'db'>, workspace: WorkspaceRow): Promise<{ apps: AppRow[]; hasTypes: boolean; family: WorkspaceRow[] }> {
  const [apps, family] = await Promise.all([panelApps(deps.db, workspace), panelWorkspaces(deps.db, workspace)]);
  const types = await Promise.all(family.map((w) => enabledTicketTypes(deps.db, w.id)));
  return { apps, hasTypes: types.some((t) => t.length > 0), family };
}

export type PanelState =
  | { state: 'not_published' }
  | { state: 'published'; channelId: string; messageId: string; outdated: boolean; channelChanged: boolean }
  | { state: 'missing'; channelId: string }
  | { state: 'unknown'; channelId: string; messageId: string; error: string };

/** Checks the stored panel against Discord (detects deleted panels) and the current config. */
export async function checkPanel(deps: Deps, workspaceId: string, opts: { live: boolean } = { live: true }): Promise<PanelState> {
  const panel = await getPanel(deps.db, workspaceId);
  if (!panel) return { state: 'not_published' };
  const workspace = (await getWorkspace(deps.db, workspaceId))!;
  const conn = await getDiscordConnection(deps.db, workspaceId);
  const content = await panelContent(deps, workspace);
  const { hash } = panelPayloadFor(workspace, content.apps, content.hasTypes, content.family);
  const channelChanged = conn?.tickets_channel_id !== panel.channel_id;

  if (opts.live && deps.discord) {
    try {
      await deps.discord.getMessage(panel.channel_id, panel.message_id);
      if (panel.status !== 'published' || panel.last_error) await markPanel(deps.db, workspaceId, 'published', null);
    } catch (err) {
      if (err instanceof DiscordApiError && (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.UnknownChannel)) {
        await markPanel(deps.db, workspaceId, 'missing', 'The panel message was deleted from Discord.');
        return { state: 'missing', channelId: panel.channel_id };
      }
      const message = err instanceof DiscordApiError && err.code === DiscordErrorCode.MissingAccess
        ? 'The bot can no longer see the tickets channel.'
        : 'Could not reach Discord to check the panel.';
      return { state: 'unknown', channelId: panel.channel_id, messageId: panel.message_id, error: message };
    }
  } else if (panel.status === 'missing') {
    return { state: 'missing', channelId: panel.channel_id };
  }
  return { state: 'published', channelId: panel.channel_id, messageId: panel.message_id, outdated: panel.content_hash !== hash, channelChanged };
}

function explainDiscordError(err: unknown): UserFacingError {
  if (err instanceof DiscordApiError) {
    if (err.code === DiscordErrorCode.MissingAccess || err.code === DiscordErrorCode.MissingPermissions) {
      return new UserFacingError('The bot is missing permissions in the tickets channel. It needs View Channel, Send Messages, Embed Links and Read Message History.');
    }
    if (err.code === DiscordErrorCode.UnknownChannel) return new UserFacingError('The tickets channel no longer exists. Choose another channel in the Discord step.');
    if (err.status === 429) return new UserFacingError('Discord is rate limiting the bot. Try again in a minute.', 429);
  }
  return new UserFacingError('Discord did not accept the panel. Try again in a moment.', 502);
}

/**
 * Publishes the panel, or updates the existing message in place. Re-posts it when the
 * old message was deleted, and moves it when the tickets channel changed.
 */
export async function publishPanel(deps: Deps, workspaceId: string, userId: string | null): Promise<'created' | 'updated' | 'recreated' | 'moved'> {
  const discord = deps.discord;
  if (!discord) throw new UserFacingError('Discord is not configured on this deployment.');
  const conn = await getDiscordConnection(deps.db, workspaceId);
  if (!conn?.tickets_channel_id) throw new UserFacingError('Choose a tickets channel first.');
  const workspace = (await getWorkspace(deps.db, workspaceId))!;
  if (workspace.parent_id && workspace.on_main_panel) throw new UserFacingError('This workspace’s apps are on its main workspace’s panel. Choose “Its own panel” first.');
  const { apps, hasTypes, family } = await panelContent(deps, workspace);
  if (!apps.some((a) => a.enabled)) throw new UserFacingError('Add at least one enabled app before publishing the panel.');
  const { payload, hash } = panelPayloadFor(workspace, apps, hasTypes, family);
  const existing = await getPanel(deps.db, workspaceId);

  if (existing && existing.channel_id === conn.tickets_channel_id) {
    try {
      await discord.editMessage(existing.channel_id, existing.message_id, payload);
      await savePanel(deps.db, workspaceId, { channelId: existing.channel_id, messageId: existing.message_id, contentHash: hash }, userId);
      return 'updated';
    } catch (err) {
      if (!(err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMessage)) throw explainDiscordError(err);
      // The message was deleted in Discord: fall through and post a new one.
    }
  }

  let created;
  try {
    created = await discord.createMessage(conn.tickets_channel_id, payload);
  } catch (err) {
    throw explainDiscordError(err);
  }
  await savePanel(deps.db, workspaceId, { channelId: conn.tickets_channel_id, messageId: created.id, contentHash: hash }, userId);

  if (existing && existing.channel_id !== conn.tickets_channel_id) {
    await discord.deleteMessage(existing.channel_id, existing.message_id).catch(() => {});
    return 'moved';
  }
  return existing ? 'recreated' : 'created';
}

export async function unpublishPanel(deps: Deps, workspaceId: string): Promise<void> {
  const existing = await getPanel(deps.db, workspaceId);
  if (!existing) return;
  if (deps.discord) await deps.discord.deleteMessage(existing.channel_id, existing.message_id).catch(() => {});
  await deletePanel(deps.db, workspaceId);
}

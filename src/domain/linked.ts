/**
 * Linked workspaces: a workspace made from another one, its main. It has its own GitHub
 * connection (often another organization), apps, ticket types, tickets, triage and analytics, and
 * it uses its main's Discord server, so Discord setup and the server-wide tools (contributor
 * roles, announcements, bot features) stay with the main. Its apps are either on the main's panel,
 * after the main's own, or on a panel of its own in that server.
 *
 * Who's in it: the main's owner and admins as its admins, the main's global moderators as its
 * moderators (with the pages they have in the main), and moderators invited to it alone. See
 * getMembership() in workspaces.ts.
 *
 * In Discord, interactions arrive for the main (by server). A linked workspace's own panel tags its
 * buttons' custom_ids with "~<workspace id>" (withScope) so its clicks, private menus and My tickets
 * stay with it; the main's panel keeps plain custom_ids. An app picked anywhere is found by its
 * public ID among the server's workspaces and filed in its own workspace.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { UserFacingError, type AppRow, type WorkspaceRow } from './types.js';
import { getWorkspace } from './workspaces.js';

/** A linked workspace's main, or null for a main (or a workspace that isn't linked). */
export async function mainOf(q: Queryable, ws: WorkspaceRow): Promise<WorkspaceRow | null> {
  return ws.parent_id ? getWorkspace(q, ws.parent_id) : null;
}

/** A main's linked workspaces, oldest first. */
export async function listLinked(q: Queryable, mainId: string): Promise<WorkspaceRow[]> {
  const { rows } = await q.query<WorkspaceRow>('SELECT * FROM workspaces WHERE parent_id = $1 ORDER BY created_at, name', [mainId]);
  return rows;
}

/** Makes a linked workspace under a main. Its apps start on the main's panel. */
export async function createLinkedWorkspace(q: Queryable, main: WorkspaceRow, name: string): Promise<WorkspaceRow> {
  if (main.parent_id) throw new UserFacingError('A linked workspace can’t have linked workspaces of its own. Add it to the main workspace instead.');
  const { rows } = await q.query<WorkspaceRow>(
    'INSERT INTO workspaces (id, name, parent_id, on_main_panel) VALUES ($1, $2, $3, 1) RETURNING *',
    [randomUUID(), name, main.id],
  );
  return rows[0]!;
}

/** Where a linked workspace's apps are offered: on its main's panel, or on a panel of its own. */
export async function setOnMainPanel(q: Queryable, workspaceId: string, on: boolean): Promise<void> {
  await q.query('UPDATE workspaces SET on_main_panel = $2, updated_at = now_ms() WHERE id = $1 AND parent_id IS NOT NULL', [workspaceId, on]);
}

/** A main's group button names on its panel: its own apps' and the linked workspaces' (null: the default). */
export async function setGroupTitles(q: Queryable, mainId: string, titles: { main: string | null; linked: string | null }): Promise<void> {
  await q.query('UPDATE workspaces SET panel_section_title = $2, panel_linked_title = $3, updated_at = now_ms() WHERE id = $1 AND parent_id IS NULL', [mainId, titles.main, titles.linked]);
}

/** A linked workspace's own panel channel (in its main's server). */
export async function setLinkedPanelChannel(q: Queryable, workspaceId: string, channel: { id: string; name: string }): Promise<void> {
  await q.query('UPDATE workspaces SET panel_channel_id = $2, panel_channel_name = $3, updated_at = now_ms() WHERE id = $1', [workspaceId, channel.id, channel.name]);
}

/**
 * The workspaces whose apps and tickets a panel shows: a main's panel has its own and those of
 * its linked workspaces that are on it (oldest first); a linked workspace's own panel just its own.
 */
export async function panelWorkspaces(q: Queryable, ws: WorkspaceRow): Promise<WorkspaceRow[]> {
  if (ws.parent_id) return [ws];
  return [ws, ...(await listLinked(q, ws.id)).filter((l) => l.on_main_panel)];
}

/** A panel's apps, in order: the workspace's own, then each linked workspace's on it. */
export async function panelApps(q: Queryable, ws: WorkspaceRow): Promise<AppRow[]> {
  const family = await panelWorkspaces(q, ws);
  const { rows } = await q.query<AppRow>('SELECT * FROM apps WHERE workspace_id IN (SELECT value FROM json_each($1)) ORDER BY position, lower(name)', [family.map((w) => w.id)]);
  return family.flatMap((w) => rows.filter((a) => a.workspace_id === w.id));
}

/**
 * An app picked in Discord, by its public ID, among the server's workspaces (the main and its
 * linked ones), with the workspace it files in. Null when it's gone or belongs elsewhere.
 */
export async function serverApp(q: Queryable, main: WorkspaceRow, publicId: string): Promise<{ app: AppRow; workspace: WorkspaceRow } | null> {
  const { rows } = await q.query<AppRow>(
    `SELECT a.* FROM apps a JOIN workspaces w ON w.id = a.workspace_id WHERE a.public_id = $1 AND (w.id = $2 OR w.parent_id = $2)`,
    [publicId, main.id],
  );
  const app = rows[0];
  if (!app) return null;
  const workspace = app.workspace_id === main.id ? main : await getWorkspace(q, app.workspace_id);
  return workspace ? { app, workspace } : null;
}

/** The scope tag a linked workspace's own panel adds to its custom_ids. */
const SCOPE = /~([0-9a-f-]{36})$/i;

/** "tr:mine:p:0~<id>" → ["tr:mine:p:0", "<id>"]; plain custom_ids have no scope. */
export function splitScope(customId: string): [string, string | null] {
  const m = SCOPE.exec(customId);
  return m ? [customId.slice(0, m.index), m[1]!.toLowerCase()] : [customId, null];
}

/**
 * Tags every ticket custom_id ("tr:…") in a Discord payload with a linked workspace's ID, so the
 * clicks come back to it. Field IDs in forms (title, details…) are left alone. Null: unchanged.
 */
export function withScope<T>(payload: T, scopeId: string | null): T {
  if (!scopeId) return payload;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'custom_id' && typeof x === 'string' && x.startsWith('tr:') && !SCOPE.test(x) ? `${x}~${scopeId}` : walk(x);
    return out;
  };
  return walk(payload) as T;
}

/** The workspace whose panel a click came from: the main, or a linked workspace's own panel (by its tag). */
export async function panelScope(q: Queryable, main: WorkspaceRow, scopeId: string | null): Promise<WorkspaceRow | null> {
  if (!scopeId) return main;
  const ws = await getWorkspace(q, scopeId);
  return ws && ws.parent_id === main.id ? ws : null;
}

/** Tools that stay with the main: they post in or change its Discord server. A linked workspace doesn't show them. */
export const MAIN_ONLY_TOOLS = ['contributors', 'announcements', 'bot'] as const;

/** Whether a page under /w/:wid belongs to a tool only the main has (contributor roles, announcements, bot features). */
export function isMainOnlyPath(path: string): boolean {
  return /^\/w\/[^/]+\/(contributors|announcements|bot)(\/|$|\?)/.test(path);
}

/** The workspace whose panel shows this workspace's apps: its main's, for a linked workspace on it. */
export function panelOwnerId(ws: Pick<WorkspaceRow, 'id' | 'parent_id' | 'on_main_panel'>): string {
  return ws.parent_id && ws.on_main_panel ? ws.parent_id : ws.id;
}

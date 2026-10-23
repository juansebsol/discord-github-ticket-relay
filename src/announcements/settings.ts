/**
 * Release announcements: what a workspace chose (on or off, review first or automatic, the
 * channel, the notes, the message, and who gets a ping), each app's own channel or role, and the
 * releases waiting, posted or skipped.
 */
import type { Queryable } from '../db/database.js';
import type { AppRow } from '../domain/types.js';

export const ANNOUNCE_MODES = ['review', 'auto'] as const;
export type AnnounceMode = (typeof ANNOUNCE_MODES)[number];
export const NOTES_SOURCES = ['claude', 'github'] as const;
export type NotesSource = (typeof NOTES_SOURCES)[number];

/** The message, as templates; {app}, {version}, {name}, {notes}, {link} and {role} are filled in. */
export const TEMPLATE_DEFAULTS = {
  message: '{role} **{app} {version}** is out!',
  title: 'What’s new in {version}',
  body: '{notes}',
};
export const TEMPLATE_LIMITS = { message: 500, title: 200, body: 1500 } as const;
export const PLACEHOLDERS = ['app', 'version', 'name', 'notes', 'link', 'role'] as const;

/**
 * A button under a post: its label, and its link (a web address, or {file:pattern} for a file of
 * the release). appId: only for that app's releases (null: every app).
 */
export interface AnnounceButton {
  label: string;
  url: string;
  appId: string | null;
}
export const BUTTONS_MAX = 10;
export const BUTTON_LIMITS = { label: 80, url: 512 } as const;
export const NOTES_BUTTON_DEFAULT = 'Release notes';

export const PANEL_DEFAULTS = {
  title: 'Get update pings',
  intro: 'Pick the apps you want a ping for when a new version comes out. Click again to stop.',
};
export const PANEL_LIMITS = { title: 200, intro: 1000 } as const;
export const INSTRUCTIONS_MAX = 1000;

export interface AnnouncementSettings {
  enabled: boolean;
  enabledAt: Date | null;
  mode: AnnounceMode;
  channelId: string | null;
  channelName: string | null;
  includePrereleases: boolean;
  notesSource: NotesSource;
  /** Extra instructions for Claude (tone, length, emoji); null: none. */
  notesInstructions: string | null;
  /** Templates; null: the default. */
  messageText: string | null;
  titleText: string | null;
  bodyText: string | null;
  /** The workspace's own buttons, in order. */
  buttons: AnnounceButton[];
  /** A button to the release on GitHub, and its label (null: "Release notes"). */
  notesButton: boolean;
  notesButtonLabel: string | null;
  /** Off until a role is picked: posts ping nobody. */
  pingEnabled: boolean;
  roleId: string | null;
  roleName: string | null;
  panelTitle: string | null;
  panelIntro: string | null;
}

interface SettingsRow {
  enabled: boolean;
  enabled_at: Date | null;
  mode: string;
  channel_id: string | null;
  channel_name: string | null;
  include_prereleases: boolean;
  notes_source: string;
  notes_instructions: string | null;
  message_text: string | null;
  title_text: string | null;
  body_text: string | null;
  buttons: unknown;
  notes_button: boolean;
  notes_button_label: string | null;
  ping_enabled: boolean;
  role_id: string | null;
  role_name: string | null;
  panel_title: string | null;
  panel_intro: string | null;
}

export async function getAnnouncementSettings(q: Queryable, workspaceId: string): Promise<AnnouncementSettings> {
  const { rows } = await q.query<SettingsRow>('SELECT * FROM announcement_settings WHERE workspace_id = $1', [workspaceId]);
  const r = rows[0];
  return {
    enabled: Boolean(r?.enabled),
    enabledAt: r?.enabled_at ?? null,
    mode: r?.mode === 'auto' ? 'auto' : 'review',
    channelId: r?.channel_id ?? null,
    channelName: r?.channel_name ?? null,
    includePrereleases: Boolean(r?.include_prereleases),
    notesSource: r?.notes_source === 'github' ? 'github' : 'claude',
    notesInstructions: r?.notes_instructions ?? null,
    messageText: r?.message_text ?? null,
    titleText: r?.title_text ?? null,
    bodyText: r?.body_text ?? null,
    buttons: cleanButtons(r?.buttons),
    notesButton: r ? Boolean(r.notes_button) : true,
    notesButtonLabel: r?.notes_button_label ?? null,
    pingEnabled: Boolean(r?.ping_enabled),
    roleId: r?.role_id ?? null,
    roleName: r?.role_name ?? null,
    panelTitle: r?.panel_title ?? null,
    panelIntro: r?.panel_intro ?? null,
  };
}

/** Saves everything; turning it on (again) starts from now, so older releases aren't announced. */
export async function saveAnnouncementSettings(q: Queryable, workspaceId: string, s: AnnouncementSettings): Promise<void> {
  await q.query(
    `INSERT INTO announcement_settings (workspace_id, enabled, enabled_at, mode, channel_id, channel_name, include_prereleases, notes_source, notes_instructions,
       message_text, title_text, body_text, buttons, notes_button, notes_button_label, ping_enabled, role_id, role_name, panel_title, panel_intro, updated_at)
     VALUES ($1, $2, CASE WHEN $2 = 1 THEN now_ms() END, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET
       enabled_at = CASE WHEN excluded.enabled = 1 THEN COALESCE(CASE WHEN announcement_settings.enabled = 1 THEN announcement_settings.enabled_at END, now_ms()) ELSE announcement_settings.enabled_at END,
       enabled = excluded.enabled, mode = excluded.mode, channel_id = excluded.channel_id, channel_name = excluded.channel_name,
       include_prereleases = excluded.include_prereleases, notes_source = excluded.notes_source, notes_instructions = excluded.notes_instructions,
       message_text = excluded.message_text, title_text = excluded.title_text, body_text = excluded.body_text,
       buttons = excluded.buttons, notes_button = excluded.notes_button, notes_button_label = excluded.notes_button_label,
       ping_enabled = excluded.ping_enabled, role_id = excluded.role_id, role_name = excluded.role_name,
       panel_title = excluded.panel_title, panel_intro = excluded.panel_intro, updated_at = now_ms()`,
    [workspaceId, s.enabled ? 1 : 0, s.mode, s.channelId, s.channelName, s.includePrereleases ? 1 : 0, s.notesSource, s.notesInstructions,
      s.messageText, s.titleText, s.bodyText, JSON.stringify(s.buttons), s.notesButton ? 1 : 0, s.notesButtonLabel, s.pingEnabled ? 1 : 0, s.roleId, s.roleName, s.panelTitle, s.panelIntro],
  );
}

/** Stored buttons, kept only when they have a label and a link. */
function cleanButtons(v: unknown): AnnounceButton[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
    .map((b) => ({ label: String(b.label ?? '').slice(0, BUTTON_LIMITS.label), url: String(b.url ?? '').slice(0, BUTTON_LIMITS.url), appId: typeof b.appId === 'string' && b.appId ? b.appId : null }))
    .filter((b) => b.label.trim() && b.url.trim())
    .slice(0, BUTTONS_MAX);
}

// ---- Each app ------------------------------------------------------------------------------------

export type RoleMode = 'default' | 'none' | 'role';

export interface AppAnnounceSettings {
  enabled: boolean;
  /** Its own channel; null: the workspace's. */
  channelId: string | null;
  channelName: string | null;
  /** default: the workspace's role; none: no ping; role: its own. */
  roleMode: RoleMode;
  roleId: string | null;
  roleName: string | null;
}

export const APP_DEFAULTS: AppAnnounceSettings = { enabled: true, channelId: null, channelName: null, roleMode: 'default', roleId: null, roleName: null };

export async function appAnnounceSettings(q: Queryable, workspaceId: string): Promise<Map<string, AppAnnounceSettings>> {
  const { rows } = await q.query<{ app_id: string; enabled: boolean; channel_id: string | null; channel_name: string | null; role_mode: string; role_id: string | null; role_name: string | null }>(
    'SELECT * FROM announcement_apps WHERE workspace_id = $1',
    [workspaceId],
  );
  return new Map(rows.map((r) => [r.app_id, {
    enabled: Boolean(r.enabled), channelId: r.channel_id, channelName: r.channel_name,
    roleMode: r.role_mode === 'none' || (r.role_mode === 'role' && r.role_id) ? (r.role_mode as RoleMode) : 'default', roleId: r.role_id, roleName: r.role_name,
  }]));
}

export async function saveAppAnnounceSettings(q: Queryable, workspaceId: string, appId: string, s: AppAnnounceSettings): Promise<void> {
  await q.query(
    `INSERT INTO announcement_apps (app_id, workspace_id, enabled, channel_id, channel_name, role_mode, role_id, role_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (app_id) DO UPDATE SET enabled = excluded.enabled, channel_id = excluded.channel_id, channel_name = excluded.channel_name,
       role_mode = excluded.role_mode, role_id = excluded.role_id, role_name = excluded.role_name`,
    [appId, workspaceId, s.enabled ? 1 : 0, s.channelId, s.channelName, s.roleMode, s.roleMode === 'role' ? s.roleId : null, s.roleMode === 'role' ? s.roleName : null],
  );
}

/** Where an app's releases are posted, and the role pinged (null: no ping). */
export function targetFor(s: AnnouncementSettings, a: AppAnnounceSettings | undefined): { channelId: string | null; channelName: string | null; roleId: string | null; roleName: string | null } {
  const app = a ?? APP_DEFAULTS;
  const role = !s.pingEnabled || app.roleMode === 'none' ? null
    : app.roleMode === 'role' && app.roleId ? { id: app.roleId, name: app.roleName }
      : s.roleId ? { id: s.roleId, name: s.roleName } : null;
  return { channelId: app.channelId ?? s.channelId, channelName: app.channelId ? app.channelName : s.channelName, roleId: role?.id ?? null, roleName: role?.name ?? null };
}

/**
 * The repositories announced, each with the app it's announced as: apps on, in their order (two
 * apps on one repository: the first one).
 */
export function announcedRepos(apps: AppRow[], appSettings: Map<string, AppAnnounceSettings>): AppRow[] {
  const out = new Map<number, AppRow>();
  for (const a of [...apps].sort((x, y) => x.position - y.position)) if ((appSettings.get(a.id) ?? APP_DEFAULTS).enabled && !out.has(a.repo_id)) out.set(a.repo_id, a);
  return [...out.values()];
}

// ---- Releases to announce ------------------------------------------------------------------------

export type AnnouncementStatus = 'writing' | 'waiting' | 'posting' | 'posted' | 'failed' | 'skipped';

export interface ReleaseFile {
  name: string;
  url: string;
}

export interface AnnouncementRow {
  id: string;
  workspace_id: string;
  app_id: string | null;
  app_name: string;
  repo_id: number;
  repo_owner: string;
  repo_name: string;
  tag: string;
  release_name: string | null;
  release_url: string;
  published_at: Date | null;
  prerelease: number;
  github_notes: string;
  release_files: ReleaseFile[];
  notes: string | null;
  notes_by: 'claude' | 'github' | 'edited' | null;
  notes_error: string | null;
  manual: boolean;
  status: AnnouncementStatus;
  channel_id: string | null;
  message_id: string | null;
  error: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  lease_until_at: Date | null;
  posted_at: Date | null;
  posted_by: string | null;
  posted_by_name?: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getAnnouncement(q: Queryable, workspaceId: string, id: string): Promise<AnnouncementRow | null> {
  const { rows } = await q.query<AnnouncementRow>(
    `SELECT a.*, COALESCE(u.display_name, u.username) AS posted_by_name FROM announcements a LEFT JOIN users u ON u.id = a.posted_by
      WHERE a.workspace_id = $1 AND a.id = $2`,
    [workspaceId, id],
  );
  return rows[0] ?? null;
}

export async function listAnnouncements(q: Queryable, workspaceId: string, limit = 200): Promise<AnnouncementRow[]> {
  const { rows } = await q.query<AnnouncementRow>(
    `SELECT a.*, COALESCE(u.display_name, u.username) AS posted_by_name FROM announcements a LEFT JOIN users u ON u.id = a.posted_by
      WHERE a.workspace_id = $1 ORDER BY COALESCE(a.published_at, a.created_at) DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows;
}

/** Posts waiting for someone to look at them (and ones that failed). */
export async function announcementCounts(q: Queryable, workspaceId: string): Promise<{ waiting: number; failed: number; posted30: number }> {
  const { rows } = await q.query<{ waiting: number; failed: number; posted30: number }>(
    `SELECT sum(status = 'waiting') AS waiting, sum(status = 'failed') AS failed, sum(status = 'posted' AND posted_at >= now_ms() - 30 * 86400000) AS posted30
       FROM announcements WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { waiting: Number(rows[0]?.waiting ?? 0), failed: Number(rows[0]?.failed ?? 0), posted30: Number(rows[0]?.posted30 ?? 0) };
}

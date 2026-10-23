/**
 * Bot features › Known issues: one Discord message the bot keeps up to date with the problems
 * members report most, and what's happening with each. Issues are ranked by their Discord tickets
 * (as Repo status › Most reported counts them: duplicates count for their original), and each
 * one's status comes from the pull requests about it and the releases: being worked on, fix
 * coming in the next update, fixed in a release. The team can pin an issue, hide one, show it
 * under another title or add a note (a workaround). Everything comes from the database; the
 * message is edited only when what it says changes.
 */
import type { Queryable } from '../db/database.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/client.js';
import { ComponentType, escapeMarkdown, NO_MENTIONS, truncate } from '../discord/messages.js';
import { repoReleases, releaseOf } from '../domain/pull-index.js';
import { getDiscordConnection, listApps } from '../domain/store.js';
import { UserFacingError, type AppRow, type Deps, type DiscordConnectionRow } from '../domain/types.js';
import { sha256 } from '../lib/crypto.js';
import { fixesFor } from '../repo-status/pulls.js';
import { mostReported, periodOf, periodStart, type PeriodId } from '../repo-status/reports.js';

/** The board is looked at this often, and edited when what it says changed. */
export const REFRESH_MS = 10 * 60_000;

export const STATUSES = ['open', 'working', 'coming', 'released', 'fixed'] as const;
export type IssueStatus = (typeof STATUSES)[number];

export const STATUS_DEFAULTS: Record<IssueStatus, string> = {
  open: '🔍 Looking into it',
  working: '🛠️ Being worked on',
  coming: '📦 Fixed, coming in the next update',
  released: '✅ Fixed in {version}: update to get it',
  fixed: '✅ Fixed',
};
/** What each status means, for the settings page. */
export const STATUS_NAMES: Record<IssueStatus, string> = {
  open: 'Open, nothing linked yet',
  working: 'An open pull request is working on it',
  coming: 'Fixed, not released yet',
  released: 'Fixed in a release ({version} is the release)',
  fixed: 'Closed as fixed (no release found)',
};

export const TEXT_DEFAULTS = {
  title: 'Known issues',
  intro: 'Before you open a ticket, check whether your problem is already here: we know about these.',
  empty: '🎉 No known issues right now. Something wrong? Open a ticket.',
  reportButton: 'Report a problem',
};
export const TEXT_LIMITS = { title: 200, intro: 1000, empty: 500, status: 120, reportButton: 80, issueTitle: 200, note: 300 } as const;
export const LIMITS = { minReports: [1, 50], maxIssues: [1, 25], fixedDays: [0, 90] } as const;

export interface KnownIssuesSettings {
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  /** null: every app. */
  appIds: string[] | null;
  period: PeriodId;
  minReports: number;
  maxIssues: number;
  /** Fixed ones stay on the board this many days after they're closed (0: taken off at once). */
  fixedDays: number;
  includePrivate: boolean;
  groupByApp: boolean;
  showCounts: boolean;
  titleText: string | null;
  introText: string | null;
  emptyText: string | null;
  statusText: Partial<Record<IssueStatus, string>>;
  reportButton: boolean;
  reportButtonLabel: string | null;
}

interface SettingsRow {
  enabled: boolean;
  channel_id: string | null;
  channel_name: string | null;
  app_ids: unknown;
  period: string;
  min_reports: number;
  max_issues: number;
  fixed_days: number;
  include_private: boolean;
  group_by_app: boolean;
  show_counts: boolean;
  title_text: string | null;
  intro_text: string | null;
  empty_text: string | null;
  status_text: unknown;
  report_button: boolean;
  report_button_label: string | null;
}

const clamp = (n: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));

export async function getKnownIssuesSettings(q: Queryable, workspaceId: string): Promise<KnownIssuesSettings> {
  const { rows } = await q.query<SettingsRow>('SELECT * FROM known_issues_settings WHERE workspace_id = $1', [workspaceId]);
  const r = rows[0];
  const status = r?.status_text && typeof r.status_text === 'object' ? (r.status_text as Record<string, unknown>) : {};
  return {
    enabled: Boolean(r?.enabled),
    channelId: r?.channel_id ?? null,
    channelName: r?.channel_name ?? null,
    appIds: Array.isArray(r?.app_ids) ? (r.app_ids as unknown[]).map(String) : null,
    period: periodOf(r?.period).id,
    minReports: clamp(r?.min_reports ?? 2, LIMITS.minReports),
    maxIssues: clamp(r?.max_issues ?? 10, LIMITS.maxIssues),
    fixedDays: clamp(r?.fixed_days ?? 14, LIMITS.fixedDays),
    includePrivate: Boolean(r?.include_private),
    groupByApp: r ? Boolean(r.group_by_app) : true,
    showCounts: r ? Boolean(r.show_counts) : true,
    titleText: r?.title_text ?? null,
    introText: r?.intro_text ?? null,
    emptyText: r?.empty_text ?? null,
    statusText: Object.fromEntries(STATUSES.filter((k) => typeof status[k] === 'string' && status[k]).map((k) => [k, String(status[k])])),
    reportButton: r ? Boolean(r.report_button) : true,
    reportButtonLabel: r?.report_button_label ?? null,
  };
}

export async function saveKnownIssuesSettings(q: Queryable, workspaceId: string, s: KnownIssuesSettings): Promise<void> {
  await q.query(
    `INSERT INTO known_issues_settings (workspace_id, enabled, channel_id, channel_name, app_ids, period, min_reports, max_issues, fixed_days, include_private,
       group_by_app, show_counts, title_text, intro_text, empty_text, status_text, report_button, report_button_label, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, channel_id = excluded.channel_id, channel_name = excluded.channel_name,
       app_ids = excluded.app_ids, period = excluded.period, min_reports = excluded.min_reports, max_issues = excluded.max_issues, fixed_days = excluded.fixed_days,
       include_private = excluded.include_private, group_by_app = excluded.group_by_app, show_counts = excluded.show_counts, title_text = excluded.title_text,
       intro_text = excluded.intro_text, empty_text = excluded.empty_text, status_text = excluded.status_text, report_button = excluded.report_button,
       report_button_label = excluded.report_button_label, updated_at = now_ms()`,
    [workspaceId, s.enabled ? 1 : 0, s.channelId, s.channelName, s.appIds ? JSON.stringify(s.appIds) : null, s.period, s.minReports, s.maxIssues, s.fixedDays,
      s.includePrivate ? 1 : 0, s.groupByApp ? 1 : 0, s.showCounts ? 1 : 0, s.titleText, s.introText, s.emptyText, JSON.stringify(s.statusText),
      s.reportButton ? 1 : 0, s.reportButtonLabel],
  );
}

// ---- Single issues ----------------------------------------------------------------------------------

export interface IssueOverride {
  pinned: boolean;
  hidden: boolean;
  title: string | null;
  note: string | null;
}

const key = (repoId: number, n: number) => `${repoId}:${n}`;

export async function issueOverrides(q: Queryable, workspaceId: string): Promise<Map<string, IssueOverride & { repoId: number; number: number }>> {
  const { rows } = await q.query<{ repo_id: number; number: number; pinned: boolean; hidden: boolean; title: string | null; note: string | null }>(
    'SELECT repo_id, number, pinned, hidden, title, note FROM known_issue_overrides WHERE workspace_id = $1',
    [workspaceId],
  );
  return new Map(rows.map((r) => [key(r.repo_id, r.number), { repoId: r.repo_id, number: r.number, pinned: Boolean(r.pinned), hidden: Boolean(r.hidden), title: r.title, note: r.note }]));
}

/** Changes what's set for one issue (fields left out stay); nothing set at all: forgotten. */
export async function setIssueOverride(q: Queryable, workspaceId: string, repoId: number, number: number, change: Partial<IssueOverride>): Promise<void> {
  const current = (await issueOverrides(q, workspaceId)).get(key(repoId, number)) ?? { pinned: false, hidden: false, title: null, note: null };
  const next = { ...current, ...change };
  // Pinned and hidden can't both be on: the latest wins.
  if (change.pinned) next.hidden = false;
  if (change.hidden) next.pinned = false;
  if (!next.pinned && !next.hidden && !next.title && !next.note) {
    await q.query('DELETE FROM known_issue_overrides WHERE workspace_id = $1 AND repo_id = $2 AND number = $3', [workspaceId, repoId, number]);
    return;
  }
  await q.query(
    `INSERT INTO known_issue_overrides (workspace_id, repo_id, number, pinned, hidden, title, note) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, repo_id, number) DO UPDATE SET pinned = excluded.pinned, hidden = excluded.hidden, title = excluded.title, note = excluded.note, updated_at = now_ms()`,
    [workspaceId, repoId, number, next.pinned ? 1 : 0, next.hidden ? 1 : 0, next.title, next.note],
  );
}

// ---- What's on the board -----------------------------------------------------------------------------

export interface BoardIssue {
  repoId: number;
  repo: string;
  appId: string;
  appName: string;
  number: number;
  /** As shown: the team's title, else GitHub's. */
  title: string;
  githubTitle: string;
  /** null for a private repository (no link is posted). */
  url: string | null;
  githubUrl: string;
  private: boolean;
  /** Discord tickets about it in the period. */
  reports: number;
  state: 'open' | 'closed' | null;
  status: IssueStatus;
  /** The release a fix shipped in (for "Fixed in {version}"). */
  version: string | null;
  pull: { number: number; url: string } | null;
  pinned: boolean;
  hidden: boolean;
  note: string | null;
  lastAt: Date | null;
}

export interface Board {
  /** On the board, in order. */
  shown: BoardIssue[];
  /** Reported but not on it (too few reports, or past the limit), most reported first. */
  below: BoardIssue[];
  hidden: BoardIssue[];
  /** Apps whose repositories are left out because they're private. */
  privateApps: string[];
}

/** The apps the board covers, one per repository (the first in order). */
export function boardApps(s: KnownIssuesSettings, apps: AppRow[]): { apps: AppRow[]; privateApps: string[] } {
  const chosen = [...apps].sort((a, b) => a.position - b.position).filter((a) => !s.appIds || s.appIds.includes(a.id));
  const byRepo = new Map<number, AppRow>();
  const privateApps: string[] = [];
  for (const a of chosen) {
    if (a.repo_private && !s.includePrivate) {
      privateApps.push(a.name);
      continue;
    }
    if (!byRepo.has(a.repo_id)) byRepo.set(a.repo_id, a);
  }
  return { apps: [...byRepo.values()], privateApps };
}

export async function computeBoard(deps: Pick<Deps, 'db' | 'box'>, workspaceId: string, s: KnownIssuesSettings, now = Date.now()): Promise<Board> {
  const { db } = deps;
  const { apps, privateApps } = boardApps(s, await listApps(db, workspaceId));
  const appOf = new Map(apps.map((a) => [a.repo_id, a]));
  const repos = apps.map((a) => ({ id: a.repo_id, owner: a.repo_owner, name: a.repo_name }));
  const reported = await mostReported(db, deps.box, workspaceId, repos, periodStart(s.period, now));
  const overrides = await issueOverrides(db, workspaceId);
  type Candidate = { repoId: number; number: number; title: string; url: string; state: 'open' | 'closed' | null; reason: string | null; closedAt: Date | null; reports: number; lastAt: Date | null };
  const candidates = new Map<string, Candidate>(reported.map((r) => [key(r.repo.id, r.number), {
    repoId: r.repo.id, number: r.number, title: r.title, url: r.url, state: r.state, reason: r.stateReason, closedAt: r.closedAt, reports: r.reports.length, lastAt: r.lastAt,
  }]));
  // Pinned issues without Discord reports in the period still go on.
  for (const o of overrides.values()) {
    if (!o.pinned || candidates.has(key(o.repoId, o.number)) || !appOf.has(o.repoId)) continue;
    const { rows } = await db.query<{ title: string; state: 'open' | 'closed'; state_reason: string | null; html_url: string; closed_at: Date | null }>(
      'SELECT title, state, state_reason, html_url, closed_at FROM issue_index WHERE repo_id = $1 AND number = $2 AND gone = 0',
      [o.repoId, o.number],
    );
    const a = appOf.get(o.repoId)!;
    const i = rows[0];
    candidates.set(key(o.repoId, o.number), {
      repoId: o.repoId, number: o.number, title: i ? i.title.replace(/^(\s*\[[^\]]*\])+\s*/, '').trim() : `Issue #${o.number}`,
      url: i?.html_url ?? `https://github.com/${a.repo_owner}/${a.repo_name}/issues/${o.number}`, state: i?.state ?? null, reason: i?.state_reason ?? null, closedAt: i?.closed_at ?? null, reports: 0, lastAt: null,
    });
  }

  const issues: BoardIssue[] = [];
  for (const repoId of new Set([...candidates.values()].map((c) => c.repoId))) {
    const app = appOf.get(repoId);
    if (!app) continue;
    const list = [...candidates.values()].filter((c) => c.repoId === repoId);
    const [fixes, releases] = await Promise.all([fixesFor(db, repoId, list.map((c) => c.number)), repoReleases(db, repoId)]);
    for (const c of list) {
      const o = overrides.get(key(repoId, c.number));
      const fix = fixes.get(c.number);
      // Closed as not planned or a duplicate: not a known issue.
      if (c.state === 'closed' && (c.reason ?? 'completed') !== 'completed') continue;
      let status: IssueStatus = 'open';
      let version: string | null = null;
      if (c.state === 'closed') {
        // Fixed ones stay a while, so members see it's fixed and update.
        if (!o?.pinned && (!c.closedAt || now - c.closedAt.getTime() > s.fixedDays * 86_400_000)) continue;
        if (fix?.status === 'waiting') status = 'coming';
        else if (fix?.status === 'merged') [status, version] = fix.release ? ['released', fix.release.tag] : ['fixed', null];
        else {
          // No merged pull request known: the first release after it was closed (none yet: coming).
          const release = releases?.length && c.closedAt ? releaseOf(c.closedAt, releases) : undefined;
          [status, version] = release ? ['released', release.tag] : release === null ? ['coming', null] : ['fixed', null];
        }
      } else if (fix) {
        // Open: a pull request that only mentions it is work on it; a merged one that closes it is a fix.
        if (fix.status === 'open' || !fix.pull.closes.includes(c.number)) status = 'working';
        else if (fix.status === 'merged' && fix.release) [status, version] = ['released', fix.release.tag];
        else status = 'coming';
      }
      issues.push({
        repoId, repo: `${app.repo_owner}/${app.repo_name}`, appId: app.id, appName: app.name, number: c.number,
        title: o?.title?.trim() || c.title, githubTitle: c.title, url: app.repo_private ? null : c.url, githubUrl: c.url, private: app.repo_private,
        reports: c.reports, state: c.state, status, version,
        pull: fix ? { number: fix.pull.number, url: `https://github.com/${app.repo_owner}/${app.repo_name}/pull/${fix.pull.number}` } : null,
        pinned: Boolean(o?.pinned), hidden: Boolean(o?.hidden), note: o?.note ?? null, lastAt: c.lastAt,
      });
    }
  }
  const byReports = (a: BoardIssue, b: BoardIssue) => b.reports - a.reports || (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0);
  const visible = issues.filter((i) => !i.hidden);
  const pinned = visible.filter((i) => i.pinned).sort(byReports);
  const ranked = visible.filter((i) => !i.pinned && i.reports >= s.minReports).sort(byReports);
  const shown = [...pinned, ...ranked].slice(0, Math.max(s.maxIssues, pinned.length));
  const on = new Set(shown.map((i) => key(i.repoId, i.number)));
  return {
    shown,
    below: visible.filter((i) => !on.has(key(i.repoId, i.number))).sort(byReports).slice(0, 15),
    hidden: issues.filter((i) => i.hidden).sort(byReports),
    privateApps,
  };
}

// ---- The message ---------------------------------------------------------------------------------------

export function statusLine(s: Pick<KnownIssuesSettings, 'statusText'>, i: Pick<BoardIssue, 'status' | 'version'>): string {
  return (s.statusText[i.status] ?? STATUS_DEFAULTS[i.status]).replace(/\{version\}/g, i.version ?? 'the latest version');
}

const safe = (t: string) => escapeMarkdown(t).replace(/\s+/g, ' ').trim();

/** One line per issue (and its note under it), grouped by app when that's on. */
export function boardText(s: KnownIssuesSettings, shown: BoardIssue[]): string {
  const line = (i: BoardIssue, withApp: boolean) => {
    const title = i.url ? `[${safe(i.title)}](${i.url})` : safe(i.title);
    const parts = [`${withApp ? `**${safe(i.appName)}**: ` : ''}${title}`];
    if (s.showCounts && i.reports) parts.push(`${i.reports} report${i.reports === 1 ? '' : 's'}`);
    parts.push(statusLine(s, i));
    return `- ${parts.join(' · ')}${i.note?.trim() ? `\n  ↳ ${i.note.trim().replace(/\s*\n\s*/g, ' ')}` : ''}`;
  };
  if (!s.groupByApp) return shown.map((i) => line(i, true)).join('\n');
  const apps = [...new Set(shown.map((i) => i.appId))];
  return apps.map((id) => {
    const mine = shown.filter((i) => i.appId === id);
    return `**${safe(mine[0]!.appName)}**\n${mine.map((i) => line(i, false)).join('\n')}`;
  }).join('\n\n');
}

/** The ticket panel's channel, for the "Report a problem" button. */
export function reportUrl(conn: Pick<DiscordConnectionRow, 'guild_id' | 'tickets_channel_id'> | null): string | null {
  return conn?.tickets_channel_id ? `https://discord.com/channels/${conn.guild_id}/${conn.tickets_channel_id}` : null;
}

export function boardPayload(s: KnownIssuesSettings, shown: BoardIssue[], o: { reportUrl: string | null; updatedAt: Date }) {
  const list = shown.length ? boardText(s, shown) : (s.emptyText?.trim() || TEXT_DEFAULTS.empty);
  const intro = s.introText?.trim() ?? TEXT_DEFAULTS.intro;
  const description = truncate([intro, list].filter(Boolean).join('\n\n'), 4096);
  const button = s.reportButton && o.reportUrl ? [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 5, label: truncate(s.reportButtonLabel?.trim() || TEXT_DEFAULTS.reportButton, 80), url: o.reportUrl }] }] : [];
  return {
    content: '',
    embeds: [{ title: truncate(s.titleText?.trim() || TEXT_DEFAULTS.title, 256), description, color: 0xd99a1e, footer: { text: 'Updated' }, timestamp: o.updatedAt.toISOString() }],
    components: button,
    allowed_mentions: NO_MENTIONS,
  };
}

/** What the message says, leaving out when it was updated (so an unchanged board isn't edited). */
function contentHash(payload: ReturnType<typeof boardPayload>): string {
  return sha256(JSON.stringify({ ...payload, embeds: payload.embeds.map(({ timestamp: _t, ...e }) => e) }));
}

// ---- Posting and keeping it current ----------------------------------------------------------------------

export interface BoardRow {
  workspace_id: string;
  channel_id: string;
  message_id: string;
  content_hash: string;
  issue_count: number;
  status: 'published' | 'missing';
  published_at: Date;
  changed_at: Date;
  checked_at: Date | null;
  error: string | null;
}

export async function getBoardRow(q: Queryable, workspaceId: string): Promise<BoardRow | null> {
  const { rows } = await q.query<BoardRow>('SELECT * FROM known_issue_boards WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

function explain(err: unknown): UserFacingError {
  if (err instanceof DiscordApiError) {
    if (err.code === DiscordErrorCode.MissingAccess || err.code === DiscordErrorCode.MissingPermissions) {
      return new UserFacingError('The bot is missing permissions in that channel. It needs View Channel, Send Messages, Embed Links and Read Message History.');
    }
    if (err.code === DiscordErrorCode.UnknownChannel) return new UserFacingError('That channel no longer exists. Choose another one in Settings.');
    if (err.status === 429) return new UserFacingError('Discord is rate limiting the bot. Try again in a minute.', 429);
  }
  return new UserFacingError('Discord did not accept the message. Try again in a moment.', 502);
}

/**
 * Posts the board, or brings the posted one up to date (moved when the channel changed, posted
 * again when it was deleted). Edits only when what it says changed, unless `force`.
 */
export async function publishBoard(deps: Deps, workspaceId: string, userId: string | null, o: { force?: boolean } = {}): Promise<'created' | 'updated' | 'unchanged' | 'moved'> {
  const discord = deps.discord;
  if (!discord) throw new UserFacingError('Discord is not configured on this deployment.');
  const s = await getKnownIssuesSettings(deps.db, workspaceId);
  if (!s.channelId) throw new UserFacingError('Choose a channel for the board in Settings first.');
  const [board, conn, existing] = await Promise.all([computeBoard(deps, workspaceId, s), getDiscordConnection(deps.db, workspaceId), getBoardRow(deps.db, workspaceId)]);
  const now = new Date();
  const payload = boardPayload(s, board.shown, { reportUrl: reportUrl(conn), updatedAt: now });
  const hash = contentHash(payload);
  if (existing && existing.status === 'published' && existing.channel_id === s.channelId) {
    if (existing.content_hash === hash && !o.force) {
      await deps.db.query('UPDATE known_issue_boards SET checked_at = $2, error = NULL WHERE workspace_id = $1', [workspaceId, now]);
      return 'unchanged';
    }
    try {
      await discord.editMessage(existing.channel_id, existing.message_id, payload);
      await deps.db.query('UPDATE known_issue_boards SET content_hash = $2, issue_count = $4, changed_at = $3, checked_at = $3, error = NULL WHERE workspace_id = $1', [workspaceId, hash, now, board.shown.length]);
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
  await deps.db.query(
    `INSERT INTO known_issue_boards (workspace_id, channel_id, message_id, content_hash, issue_count, status, published_by, published_at, changed_at, checked_at)
     VALUES ($1, $2, $3, $4, $7, 'published', $5, $6, $6, $6)
     ON CONFLICT (workspace_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, content_hash = excluded.content_hash, issue_count = excluded.issue_count,
       status = 'published', published_by = excluded.published_by, published_at = excluded.published_at, changed_at = excluded.changed_at, checked_at = excluded.checked_at, error = NULL`,
    [workspaceId, s.channelId, created.id, hash, userId, now, board.shown.length],
  );
  if (existing && existing.channel_id !== s.channelId) {
    await discord.deleteMessage(existing.channel_id, existing.message_id).catch(() => {});
    return 'moved';
  }
  return 'created';
}

export type BoardState =
  | { state: 'not_published' }
  | { state: 'missing' }
  | { state: 'published'; channelChanged: boolean; link: string | null; changedAt: Date; checkedAt: Date | null; error: string | null };

/** The posted board. `live: false` skips asking Discord whether it still exists. */
export async function checkBoard(deps: Deps, workspaceId: string, conn: DiscordConnectionRow | null, o: { live: boolean } = { live: true }): Promise<BoardState> {
  const row = await getBoardRow(deps.db, workspaceId);
  if (!row) return { state: 'not_published' };
  if (row.status === 'missing') return { state: 'missing' };
  if (deps.discord && o.live) {
    try {
      await deps.discord.getMessage(row.channel_id, row.message_id);
    } catch (err) {
      if (err instanceof DiscordApiError && (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.UnknownChannel)) {
        await deps.db.query(`UPDATE known_issue_boards SET status = 'missing' WHERE workspace_id = $1`, [workspaceId]);
        return { state: 'missing' };
      }
    }
  }
  const s = await getKnownIssuesSettings(deps.db, workspaceId);
  return {
    state: 'published', channelChanged: s.channelId !== row.channel_id,
    link: conn ? `https://discord.com/channels/${conn.guild_id}/${row.channel_id}/${row.message_id}` : null,
    changedAt: row.changed_at, checkedAt: row.checked_at, error: row.error,
  };
}

export async function unpublishBoard(deps: Deps, workspaceId: string): Promise<void> {
  const row = await getBoardRow(deps.db, workspaceId);
  if (!row) return;
  if (deps.discord) await deps.discord.deleteMessage(row.channel_id, row.message_id).catch(() => {});
  await deps.db.query('DELETE FROM known_issue_boards WHERE workspace_id = $1', [workspaceId]);
}

/** After a change in the console: the posted board catches up right away (a failure waits for the next round). */
export async function refreshBoardSoon(deps: Deps, workspaceId: string): Promise<void> {
  const [s, row] = await Promise.all([getKnownIssuesSettings(deps.db, workspaceId), getBoardRow(deps.db, workspaceId)]);
  if (!s.enabled || row?.status !== 'published' || row.channel_id !== s.channelId) return;
  await publishBoard(deps, workspaceId, null).catch((err) => deps.log.warn({ workspace: workspaceId, err: (err as Error).message }, 'known issues board update failed'));
}

/** Runs in the triage worker's polling loop: each posted board is looked at every 10 minutes. */
export class KnownIssuesUpdater {
  constructor(readonly deps: Deps) {}

  async tick(now = Date.now()): Promise<number> {
    const { db } = this.deps;
    if (!this.deps.discord) return 0;
    const { rows } = await db.query<{ workspace_id: string }>(
      `SELECT b.workspace_id FROM known_issue_boards b JOIN known_issues_settings s ON s.workspace_id = b.workspace_id AND s.enabled = 1 AND s.channel_id = b.channel_id
        WHERE b.status = 'published' AND (b.checked_at IS NULL OR b.checked_at < $1) ORDER BY b.checked_at LIMIT 5`,
      [new Date(now - REFRESH_MS)],
    );
    let updated = 0;
    for (const r of rows) {
      try {
        if ((await publishBoard(this.deps, r.workspace_id, null)) !== 'unchanged') updated++;
      } catch (err) {
        const message = (err as Error).message;
        await db.query('UPDATE known_issue_boards SET checked_at = $2, error = $3 WHERE workspace_id = $1', [r.workspace_id, new Date(now), message.slice(0, 300)]);
        this.deps.log.warn({ workspace: r.workspace_id, err: message }, 'known issues board update failed');
      }
    }
    return updated;
  }
}

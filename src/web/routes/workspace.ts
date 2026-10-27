import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkContributorPanel, contributorApps, getContributorSettings, listManualRoles, listTiers, verificationStats } from '../../domain/contributors.js';
import { checkDiscordCredentials, checkGitHubCredentials, type CredentialCheck } from '../../domain/credentials.js';
import { checkPanel } from '../../domain/panel.js';
import { AREAS, areasOf, can, levelOf, TOOL_NAMES, TOOLS, toolAccess, type Area, type MemberAccess, type Tool } from '../../domain/permissions.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../../domain/store.js';
import { countByStatus, decryptPayload, filedThisWeek } from '../../domain/submissions.js';
import type { AppRow, DiscordConnectionRow, SubmissionStatus } from '../../domain/types.js';
import { updateWorkspaceGeneral, userNames } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import type { LogDetail, TriageAction } from '../../triage/engine.js';
import { getTriageSettings, monthlyUsage } from '../../triage/settings.js';
import { getStatusSettings, statusRepos, statusRows } from '../../repo-status/tracker.js';
import { analyticsRepos, getAnalyticsSettings } from '../../analytics/recorder.js';
import { announcedRepos, announcementCounts, appAnnounceSettings, getAnnouncementSettings } from '../../announcements/settings.js';
import { checkBoard, getBoardRow, getKnownIssuesSettings, issueOverrides } from '../../bot-features/known-issues.js';
import type { StepState } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import {
  copyField,
  csrfField,
  empty,
  icon,
  iconBtn,
  linkBtn,
  locked,
  notice,
  pageHeader,
  pill,
  plural,
  setting,
  submitBtn,
  tag,
  timeAgo,
  when,
  type IconName,
} from '../ui.js';
import { claudeCard, keyPill, keyStatus, keySummary } from './claude.js';
import { areaHref, canOpen, canOpenIssue, firstPage, panelPill, repoSyncState, TOOL_ICONS, type ToolName } from './tool.js';

// ---- Overview -----------------------------------------------------------------------------------

/** The tools with a card on the overview, in sidebar order. */
const OVERVIEW_TOOLS: readonly ToolName[] = ['analytics', 'repos', 'tickets', 'issues', 'triage', 'contributors', 'announcements', 'bot'];

const DAY_MS = 86_400_000;
/** Latest goes back this far for issues opened on GitHub (the others are newest first by index). */
const LATEST_DAYS = 30;
const LATEST_COUNT = 8;

const num = (n: number) => n.toLocaleString('en-US');

/** A number on a tool card. It links to the page that lists those items, for someone who can open it. */
interface Stat {
  label: string;
  value: number;
  area: Area;
  href: string;
  /** "312 of 500". */
  of?: number;
  tone?: 'warn' | 'accent';
  title?: string;
}

/** A tool card's button: shown only to someone who can open the page. */
interface Go {
  area: Area;
  label: string;
  href?: string;
  primary?: boolean;
}

interface ToolCard {
  tool: ToolName;
  meta: string;
  status: SafeHtml;
  stats: Stat[];
  /** In order of preference; the first two pages this person can open are shown, one button each. */
  go: Go[];
}

function statBox(m: MemberAccess, s: Stat): SafeHtml {
  const cls = ['v', s.tone ?? '', s.of !== undefined ? 'split' : ''].filter(Boolean).join(' ');
  const inner = html`<div class="l">${s.label}</div><div class="${cls}">${num(s.value)}${s.of !== undefined ? html`<span class="of">of ${num(s.of)}</span>` : ''}${s.tone === 'warn' ? icon('triangle-alert', 14) : ''}</div>`;
  const title = s.title ? html`title="${s.title}"` : '';
  return canOpen(m, s.area) ? html`<a class="stat" href="${s.href}" ${title}>${inner}</a>` : html`<div class="stat" ${title}>${inner}</div>`;
}

function toolCard(ctx: WorkspaceRequestContext, c: ToolCard): SafeHtml {
  const id = `tool-${c.tool}`;
  const seen = new Set<Area>();
  const buttons = c.go
    .filter((g) => canOpen(ctx.membership, g.area) && !seen.has(g.area) && seen.add(g.area))
    .slice(0, 2)
    .map((g, i) => linkBtn(g.href ?? areaHref(ctx, g.area), g.label, { size: 'sm', variant: i ? 'ghost' : g.primary ? 'primary' : 'secondary' }));
  return html`<section class="card tool-card" aria-labelledby="${id}">
    <div class="card-h"><span class="tile accent">${icon(TOOL_ICONS[c.tool])}</span><div class="grow"><h2 id="${id}">${TOOL_NAMES[c.tool]}</h2><div class="desc">${c.meta}</div></div>${c.status}</div>
    <div class="stats">${c.stats.map((s) => statBox(ctx.membership, s))}</div>
    ${buttons.length ? html`<div class="card-f plain"><div class="row">${buttons}</div></div>` : ''}
  </section>`;
}

/** Everything the overview reads once and shares between cards. */
interface Shared {
  web: Web;
  ctx: WorkspaceRequestContext;
  dc: DiscordConnectionRow | null;
  apps: AppRow[];
  /** The workspace's repositories (from its apps) and their names. */
  repos: Map<number, string>;
  counts: Record<SubmissionStatus, number>;
}

async function ticketsCard({ web, ctx, dc, counts }: Shared): Promise<ToolCard> {
  const b = ctx.base;
  const [panel, filed] = await Promise.all([checkPanel(web.deps, ctx.workspace.id, { live: false }), filedThisWeek(web.deps.db, ctx.workspace.id)]);
  const attention = counts.failed + counts.uncertain;
  // Members can't open tickets until the panel is in Discord: that comes first for whoever can post it.
  const publish = panel.state === 'not_published' || panel.state === 'missing';
  return {
    tool: 'tickets',
    meta: `Members open them from ${dc?.tickets_channel_name ? `#${dc.tickets_channel_name}` : 'the ticket panel'} · each becomes a GitHub issue`,
    status: panelPill(panel.state),
    stats: [
      { label: 'Filed this week', value: filed, area: 'inbox', href: `${b}/tickets?status=filed`, title: 'Tickets filed as GitHub issues in the last 7 days' },
      { label: 'Need attention', value: attention, area: 'inbox', href: `${b}/tickets?status=attention`, tone: attention ? 'warn' : undefined, title: 'Tickets that failed or couldn’t be confirmed on GitHub' },
      { label: 'Queued', value: counts.pending + counts.processing, area: 'inbox', href: `${b}/tickets?status=open`, title: 'Tickets waiting to be filed' },
    ],
    go: [
      ...(publish && can(ctx.membership, 'panel.edit') ? [{ area: 'panel' as const, label: panel.state === 'missing' ? 'Post panel again' : 'Publish panel', primary: true }] : []),
      { area: 'inbox', label: 'Open inbox' },
      { area: 'panel', label: 'Panel' },
      { area: 'types', label: 'Ticket types' },
      { area: 'files', label: 'Files' },
      { area: 'ticket-settings', label: 'Settings' },
    ],
  };
}

/** Issues opened on GitHub: not filed by a ticket (the same test triage uses, and submissions_repo_issue_idx serves). */
const NOT_A_TICKET = `NOT EXISTS (SELECT 1 FROM submissions s WHERE s.repo_id = x.repo_id AND s.issue_number = x.number)`;

async function issuesCard({ web, ctx, repos }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const ids = JSON.stringify([...repos.keys()]);
  const [{ problem, loading, oldest, text }, { rows: n }] = await Promise.all([
    repoSyncState(db, [...repos.keys()]),
    db.query<{ open: number | null; closed: number | null; github: number | null }>(
      `SELECT sum(x.state = 'open') AS open,
         sum(x.state = 'closed' AND x.closed_at >= $2) AS closed,
         sum(x.created_at >= $2 AND ${NOT_A_TICKET}) AS github
       FROM issue_index x WHERE x.repo_id IN (SELECT value FROM json_each($1)) AND x.gone = 0`,
      [ids, new Date(Date.now() - 7 * DAY_MS)],
    ),
  ]);
  // Changes are picked up every 2 minutes; much longer means syncing has stopped.
  const behind = oldest !== null && Date.now() - oldest.getTime() > 30 * 60_000;
  const c = n[0];
  return {
    tool: 'issues',
    meta: text,
    status: !repos.size
      ? pill('Not set up', 'neutral')
      : problem ? pill('Sync problem', 'warn') : loading ? pill('Loading', 'neutral') : behind ? pill('Behind', 'warn') : oldest ? pill('Up to date', 'ok') : pill('Not synced yet', 'neutral'),
    stats: [
      { label: 'Open issues', value: Number(c?.open ?? 0), area: 'issues', href: `${b}/issues` },
      { label: 'Opened on GitHub this week', value: Number(c?.github ?? 0), area: 'issues-github', href: `${b}/issues/github?show=all`, title: 'Issues opened directly on GitHub in the last 7 days, not through Discord' },
      { label: 'Closed this week', value: Number(c?.closed ?? 0), area: 'issues', href: `${b}/issues?state=closed` },
    ],
    go: [
      { area: 'issues', label: 'Search issues' },
      { area: 'issues-github', label: 'Opened on GitHub' },
      { area: 'issues-sync', label: 'Sync' },
    ],
  };
}

async function triageCard({ web, ctx }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const wid = ctx.workspace.id;
  const [settings, usage, { rows: applied }] = await Promise.all([
    getTriageSettings(db, wid),
    monthlyUsage(db, wid),
    // One entry per ticket or issue where something was changed on GitHub, automatically or by someone.
    db.query<{ n: number }>(`SELECT count(*) AS n FROM triage_log WHERE workspace_id = $1 AND at >= $2 AND json_array_length(detail, '$.applied') > 0`, [wid, new Date(Date.now() - 7 * DAY_MS)]),
  ]);
  const c = settings.config;
  const anyOn = settings.enabled || settings.githubEnabled;
  const review = ctx.progress?.review ?? 0;
  const covers = settings.enabled && settings.githubEnabled
    ? 'Discord tickets and issues opened on GitHub'
    : settings.enabled ? 'Discord tickets' : settings.githubEnabled ? 'Issues opened on GitHub' : 'Flags new tickets and issues once it’s on';
  return {
    tool: 'triage',
    meta: `${covers} · ${c.model}`,
    status: !anyOn ? pill('Off', 'neutral') : settings.paused ? pill('Paused', 'warn') : pill('On', 'ok'),
    stats: [
      { label: 'To review', value: review, area: 'triage.review', href: `${b}/triage`, tone: review ? 'accent' : undefined, title: 'Tickets and issues with suggestions waiting for someone' },
      { label: 'Applied this week', value: Number(applied[0]?.n ?? 0), area: 'triage.activity', href: `${b}/triage/activity`, title: 'Tickets and issues changed on GitHub by triage in the last 7 days, automatically or by someone' },
      {
        label: 'This month', value: usage.triaged, of: c.monthlyLimit, area: 'triage.actions', href: `${b}/triage/actions#limits`,
        tone: anyOn && usage.triaged >= c.monthlyLimit ? 'warn' : undefined, title: 'Tickets and issues triaged this month, re-runs included, and the monthly limit',
      },
    ],
    go: [
      ...(review ? [{ area: 'triage.review' as const, label: 'Review suggestions', primary: true }] : []),
      ...(!anyOn && can(ctx.membership, 'triage.actions.edit') ? [{ area: 'triage.actions' as const, label: 'Turn on' }] : []),
      { area: 'triage.review', label: 'Review suggestions' },
      { area: 'triage.overview', label: 'Overview' },
      { area: 'triage.activity', label: 'Activity' },
      { area: 'triage.actions', label: 'Actions' },
      { area: 'triage.labels', label: 'Custom labels' },
      { area: 'triage.prompt', label: 'Prompt' },
      { area: 'triage.runs', label: 'Re-run' },
    ],
  };
}

async function contributorsCard({ web, ctx, dc, apps }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const wid = ctx.workspace.id;
  const [settings, tiers, manual, stats, panel] = await Promise.all([
    getContributorSettings(db, wid),
    listTiers(db, wid),
    listManualRoles(db, wid),
    verificationStats(db, wid),
    checkContributorPanel(web.deps, wid, dc, { live: false }),
  ]);
  const roles = tiers.length + manual.length;
  const repos = new Set(contributorApps(apps).map((a) => a.repo_id)).size;
  return {
    tool: 'contributors',
    meta: settings.channel_name || roles
      ? [settings.channel_name ? `#${settings.channel_name}` : 'No channel yet', plural(roles, 'role'), plural(repos, 'repository', 'repositories')].join(' · ')
      : 'Not set up yet',
    status: !settings.enabled ? pill('Off', 'neutral') : panelPill(panel.state),
    stats: [
      { label: 'Verified', value: stats.verified, area: 'verifications', href: `${b}/contributors?result=verified`, title: 'Members who hold a contributor role' },
      { label: 'This week', value: stats.thisWeek, area: 'verifications', href: `${b}/contributors?result=all`, title: 'Verifications in the last 7 days, whatever the result' },
      { label: 'Conflicts', value: stats.conflicts, area: 'verifications', href: `${b}/contributors?result=conflict`, tone: stats.conflicts ? 'warn' : undefined, title: 'GitHub accounts already linked to another member, in the last 30 days' },
    ],
    go: [
      // Verification is switched on with the panel's channel.
      ...(!settings.enabled && can(ctx.membership, 'contributor-panel.edit') ? [{ area: 'contributor-panel' as const, label: 'Turn on' }] : []),
      { area: 'verifications', label: 'Verifications' },
      { area: 'contributor-roles', label: 'Roles' },
      { area: 'contributor-panel', label: 'Panel' },
    ],
  };
}

async function reposCard({ web, ctx }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const s = await getStatusSettings(db, ctx.workspace.id);
  const repos = await statusRepos(db, ctx.workspace.id, s);
  const rows = [...(await statusRows(db, repos.map((r) => r.id))).values()];
  const read = rows.flatMap((r) => (r.stats ? [r.stats] : []));
  const oldest = rows.length === repos.length && rows.every((r) => r.fetched_at) ? new Date(Math.min(...rows.map((r) => r.fetched_at!.getTime()))) : null;
  const stale = oldest !== null && Date.now() - oldest.getTime() > Math.max(2 * s.everyMinutes, 15) * 60_000;
  const sum = (f: (x: (typeof read)[number]) => number) => read.reduce((n, x) => n + f(x), 0);
  const critical = sum((x) => x.critical);
  return {
    tool: 'repos',
    meta: s.enabled ? `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}${oldest ? ` · read ${timeAgo(oldest)}` : ''}` : 'Off',
    status: !s.enabled ? pill('Off', 'neutral') : rows.some((r) => r.error) ? pill('Problem', 'warn') : stale ? pill('Stale', 'warn') : read.length ? pill('Fresh', 'ok') : pill('Reading…', 'neutral'),
    stats: [
      { label: 'Critical issues', value: critical, area: 'repo-status', href: `${b}/repos?view=fix`, tone: critical ? 'warn' : undefined, title: 'Open issues naming a crash, hang, freeze, data loss, launch failure or security problem' },
      { label: 'Open PRs', value: sum((x) => x.openPrs), area: 'repo-status', href: `${b}/repos` },
      { label: 'Unreleased commits', value: sum((x) => x.build?.unreleased ?? 0), area: 'repo-status', href: `${b}/repos`, title: 'Commits on each default branch since its latest build' },
    ],
    go: [{ area: 'repo-status', label: s.enabled ? 'Open Repo status' : 'Set up Repo status', primary: !s.enabled && can(ctx.membership, 'repo-status.edit') }],
  };
}

async function analyticsCard({ web, ctx }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const s = await getAnalyticsSettings(db, ctx.workspace.id);
  const repos = await analyticsRepos(db, ctx.workspace.id);
  const ids = repos.map((r) => r.id);
  const since = (ms: number) => new Date(Date.now() - ms);
  const downloads = async (ms: number) => Number((await db.query<{ n: number }>(
    `SELECT COALESCE(sum(c.downloads), 0) AS n FROM download_counts c JOIN download_assets a ON a.id = c.asset_id
      WHERE a.repo_id IN (SELECT value FROM json_each($1)) AND a.kind <> 'meta' AND c.slot_at >= $2`, [ids, since(ms)])).rows[0]?.n ?? 0);
  const day = s.enabled ? await downloads(86_400_000) : 0;
  const week = s.enabled ? await downloads(7 * 86_400_000) : 0;
  // Stars gained: the change in GitHub's star count (a star taken back counts -1).
  const stars = s.enabled ? Number((await db.query<{ n: number }>('SELECT COALESCE(sum(change), 0) AS n FROM repo_star_changes WHERE repo_id IN (SELECT value FROM json_each($1)) AND slot_at >= $2', [ids, since(7 * 86_400_000)])).rows[0]?.n ?? 0) : 0;
  return {
    tool: 'analytics',
    meta: s.enabled ? `Downloads and stars every 30 minutes${s.enabledAt ? ` · started ${timeAgo(s.enabledAt)}` : ''}` : 'Off',
    status: s.enabled ? pill('Recording', 'ok') : pill('Off', 'neutral'),
    stats: [
      { label: 'Downloads, last 24 h', value: day, area: 'analytics', href: `${b}/analytics` },
      { label: 'Last 7 days', value: week, area: 'analytics', href: `${b}/analytics?range=7d` },
      { label: 'Stars gained, last 7 days', value: stars, area: 'analytics', href: `${b}/analytics?range=7d&metric=stars` },
    ],
    go: [{ area: 'analytics', label: s.enabled ? 'Open Analytics' : 'Set up Analytics', primary: !s.enabled && can(ctx.membership, 'analytics.edit') }],
  };
}

async function announcementsCard({ web, ctx }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const [s, counts, apps, appSettings] = await Promise.all([getAnnouncementSettings(db, ctx.workspace.id), announcementCounts(db, ctx.workspace.id), listApps(db, ctx.workspace.id), appAnnounceSettings(db, ctx.workspace.id)]);
  const announced = announcedRepos(apps, appSettings).length;
  return {
    tool: 'announcements',
    meta: s.enabled ? [s.channelName ? `#${s.channelName}` : 'No channel yet', plural(announced, 'app'), s.pingEnabled && s.roleName ? `pings @${s.roleName}` : 'no ping'].join(' · ') : 'Off',
    status: !s.enabled ? pill('Off', 'neutral') : s.mode === 'auto' ? pill('Automatic', 'ok') : pill('Review first', 'ok'),
    stats: [
      { label: 'Waiting to post', value: counts.waiting, area: 'announcements', href: `${b}/announcements?show=waiting`, tone: counts.waiting ? 'accent' : undefined, title: 'New releases waiting for someone to post them' },
      { label: 'Posted, 30 days', value: counts.posted30, area: 'announcements', href: `${b}/announcements?show=posted` },
      { label: 'Failed', value: counts.failed, area: 'announcements', href: `${b}/announcements?show=waiting`, tone: counts.failed ? 'warn' : undefined, title: 'Posts Discord didn’t take' },
    ],
    go: [
      ...(!s.enabled && can(ctx.membership, 'announcement-settings.edit') ? [{ area: 'announcement-settings' as const, label: 'Set up Announcements', primary: true }] : []),
      { area: 'announcements', label: 'Posts' },
      { area: 'announcement-settings', label: 'Settings' },
    ],
  };
}

async function botCard({ web, ctx, dc }: Shared): Promise<ToolCard> {
  const { db } = web.deps;
  const b = ctx.base;
  const [s, row, overrides] = await Promise.all([getKnownIssuesSettings(db, ctx.workspace.id), getBoardRow(db, ctx.workspace.id), issueOverrides(db, ctx.workspace.id)]);
  const board = await checkBoard(web.deps, ctx.workspace.id, dc, { live: false });
  const kept = [...overrides.values()];
  return {
    tool: 'bot',
    meta: s.enabled ? `Known issues${s.channelName ? ` in #${s.channelName}` : ''}${board.state === 'published' ? ` · changed ${timeAgo(board.changedAt)}` : ''}` : 'Known issues board: off',
    status: !s.enabled ? pill('Off', 'neutral') : board.state === 'published' ? pill('Live', 'ok') : board.state === 'missing' ? pill('Board deleted', 'warn') : pill('Not published', 'neutral'),
    stats: [
      { label: 'On the board', value: board.state === 'published' ? row?.issue_count ?? 0 : 0, area: 'known-issues', href: `${b}/bot/known-issues` },
      { label: 'Pinned', value: kept.filter((o) => o.pinned).length, area: 'known-issues', href: `${b}/bot/known-issues` },
      { label: 'Hidden', value: kept.filter((o) => o.hidden).length, area: 'known-issues', href: `${b}/bot/known-issues#hidden` },
    ],
    go: [
      ...(!s.enabled && can(ctx.membership, 'known-issues.edit') ? [{ area: 'known-issues' as const, label: 'Set up the board', href: `${b}/bot/known-issues?view=settings`, primary: true }] : []),
      { area: 'known-issues', label: 'Known issues' },
    ],
  };
}

const CARDS: Record<ToolName, (s: Shared) => Promise<ToolCard>> = { tickets: ticketsCard, issues: issuesCard, repos: reposCard, analytics: analyticsCard, triage: triageCard, contributors: contributorsCard, announcements: announcementsCard, bot: botCard };

// ---- Latest: what just happened, across the tools ------------------------------------------------

interface FeedItem {
  at: Date;
  icon: IconName;
  /** Read out before the title (the icon is decorative). */
  source: string;
  title: string;
  detail: string;
  href: string | null;
}

const PRIORITY_NAMES: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

/** A triage action in a few plain words, for one line. */
function actionText(a: TriageAction): string {
  switch (a.kind) {
    case 'priority':
      return a.priority ? `${PRIORITY_NAMES[a.priority] ?? a.priority} priority` : 'Priority';
    case 'duplicate':
      return `Duplicate of #${String(a.duplicateOf)}`;
    case 'regression':
      return `Regression of #${String(a.regressionOf)}`;
    case 'inProgress':
      return `Being worked on in ${a.work?.ref ?? 'a pull request'}`;
    case 'fixed':
      return `Already fixed in ${a.work?.ref ?? 'an earlier change'}`;
    case 'needsInfo':
      return 'Needs more info';
    case 'multiple':
      return 'Several problems';
    case 'related':
      return 'Related issues';
    case 'shared':
      return 'Shared problem';
    case 'wrongRepo':
      return `Belongs to ${a.rightApp ?? 'another app'}`;
    case 'spam':
      return 'Spam';
    case 'support':
      return 'Not a development issue';
    case 'noAction':
      return 'No action needed';
    default:
      return `${a.groupName ?? 'Labels'}: ${(a.labels ?? []).join(', ')}`;
  }
}

function triageTitle(d: LogDetail): string {
  const list = (xs: TriageAction[]) => xs.map(actionText).join(', ');
  const applied = d.applied ?? [];
  const suggested = d.suggested ?? [];
  return [applied.length ? `Applied ${list(applied)}` : '', suggested.length ? `${applied.length ? 'suggested' : 'Suggested'} ${list(suggested)}` : ''].filter(Boolean).join('; ');
}

/** The newest events from the tools this person can open: each source only with the page that lists it. */
async function latestFeed({ web, ctx, repos }: Shared): Promise<{ items: FeedItem[]; sources: string[] }> {
  const { db, box } = web.deps;
  const m = ctx.membership;
  const b = ctx.base;
  const wid = ctx.workspace.id;
  const ids = JSON.stringify([...repos.keys()]);
  // An issue's own page needs one of the GitHub issues pages.
  const issuePages = canOpenIssue(m);
  const show = {
    tickets: canOpen(m, 'inbox'),
    issues: issuePages,
    triage: canOpen(m, 'triage.review') || canOpen(m, 'triage.activity'),
    verified: canOpen(m, 'verifications'),
  };
  const none = { rows: [] };
  const [tickets, issues, triage, verified] = await Promise.all([
    show.tickets
      ? db.query<{ id: string; ref: string; payload_enc: string | null; repo_name: string; issue_number: number | null; reporter_display_name: string; created_at: Date; completed_at: Date | null; title: string | null }>(
          `SELECT s.id, s.ref, s.payload_enc, s.repo_name, s.issue_number, s.reporter_display_name, s.created_at, s.completed_at, x.title
           FROM submissions s LEFT JOIN issue_index x ON x.repo_id = s.repo_id AND x.number = s.issue_number
           WHERE s.workspace_id = $1 AND s.status = 'created' ORDER BY s.created_at DESC LIMIT ${LATEST_COUNT}`,
          [wid],
        )
      : none,
    show.issues && repos.size
      ? db.query<{ repo_id: number; number: number; title: string; author: string | null; created_at: Date }>(
          `SELECT x.repo_id, x.number, x.title, x.author, x.created_at FROM issue_index x
           WHERE x.repo_id IN (SELECT value FROM json_each($1)) AND x.gone = 0 AND x.created_at >= $2 AND ${NOT_A_TICKET}
           ORDER BY x.created_at DESC LIMIT ${LATEST_COUNT}`,
          [ids, new Date(Date.now() - LATEST_DAYS * DAY_MS)],
        )
      : none,
    // New tickets and issues Claude flagged, and suggestions someone applied. Bulk applies and re-runs stay on Activity.
    show.triage
      ? db.query<{ at: Date; source: string; submission_id: string | null; repo_id: number | null; number: number | null; ref: string | null; by_user: string | null; detail: LogDetail; ticket_repo: string | null; ticket_number: number | null }>(
          `SELECT l.at, l.source, l.submission_id, l.repo_id, l.number, l.ref, l.by_user, l.detail, s.repo_name AS ticket_repo, s.issue_number AS ticket_number
           FROM triage_log l LEFT JOIN submissions s ON s.id = l.submission_id
           WHERE l.workspace_id = $1 AND l.result = 'ok' AND l.source IN ('ticket', 'github', 'review') AND l.bulk_id IS NULL AND json_extract(l.detail, '$.bulk') IS NULL
             AND (json_array_length(l.detail, '$.applied') > 0 OR json_array_length(l.detail, '$.suggested') > 0)
           ORDER BY l.id DESC LIMIT ${LATEST_COUNT}`,
          [wid],
        )
      : none,
    show.verified
      ? db.query<{ discord_name: string; role_name: string | null; github_login: string | null; contributions: number | null; created_at: Date }>(
          `SELECT discord_name, role_name, github_login, contributions, created_at FROM contributor_verifications
           WHERE workspace_id = $1 AND result = 'verified' ORDER BY created_at DESC LIMIT ${LATEST_COUNT}`,
          [wid],
        )
      : none,
  ]);
  const names = await userNames(db, triage.rows.map((l) => l.by_user));
  const issueHref = (repoId: number, n: number) => (issuePages ? `${b}/issues/${String(repoId)}/${String(n)}` : null);
  const items: FeedItem[] = [
    ...tickets.rows.map((s) => ({
      at: s.completed_at ?? s.created_at,
      icon: 'ticket' as const,
      source: 'Discord ticket',
      // The ticket's own title, as in the inbox; once its text is gone, its issue's title on GitHub.
      title: decryptPayload(box, s)?.title ?? s.title ?? s.ref,
      detail: `Discord ticket from ${s.reporter_display_name}, filed as ${s.repo_name}#${String(s.issue_number)}`,
      href: `${b}/tickets/${s.id}`,
    })),
    ...issues.rows.map((x) => ({
      at: x.created_at,
      icon: 'circle-dot' as const,
      source: 'GitHub issue',
      title: x.title,
      detail: `opened on GitHub${x.author ? ` by @${x.author}` : ''} in ${repos.get(x.repo_id) ?? 'a repository'}`,
      href: issueHref(x.repo_id, x.number),
    })),
    ...triage.rows.map((l) => {
      const ref = l.submission_id
        ? l.ticket_repo && l.ticket_number ? `${l.ticket_repo}#${String(l.ticket_number)}` : l.ref ?? 'a ticket'
        : `${repos.get(l.repo_id ?? 0) ?? 'issue'}#${String(l.number)}`;
      return {
        at: l.at,
        icon: 'sparkles' as const,
        source: 'AI triage',
        title: triageTitle(l.detail ?? {}),
        detail: l.source === 'review' ? `by ${l.by_user ? names.get(l.by_user) ?? 'an admin' : 'someone'} on ${ref}` : `AI triage on ${ref}`,
        href: l.submission_id ? `${b}/tickets/${l.submission_id}` : l.repo_id && l.number ? issueHref(l.repo_id, l.number) : null,
      };
    }),
    ...verified.rows.map((v) => ({
      at: v.created_at,
      icon: 'award' as const,
      source: 'Contributor roles',
      title: v.role_name ? `${v.discord_name} verified as ${v.role_name}` : `${v.discord_name} verified`,
      detail: [v.github_login ? `@${v.github_login}` : null, v.contributions !== null ? plural(v.contributions, 'contribution') : null].filter(Boolean).join(' · ') || 'with GitHub',
      href: `${b}/contributors?result=verified`,
    })),
  ];
  items.sort((x, y) => y.at.getTime() - x.at.getTime());
  const sources = [show.tickets && 'new tickets', show.issues && 'issues opened on GitHub', show.triage && 'triage suggestions', show.verified && 'verifications'].filter((s): s is string => Boolean(s));
  return { items: items.slice(0, LATEST_COUNT), sources };
}

function feedRow(e: FeedItem): SafeHtml {
  const inner = html`<span class="feed-src" aria-hidden="true">${icon(e.icon, 14)}</span><span class="feed-text"><span class="sr-only">${e.source}: </span><span class="feed-t">${e.title}</span><span class="feed-sep" aria-hidden="true"> · </span><span class="feed-d">${e.detail}</span></span>${when(e.at)}`;
  return html`<li>${e.href ? html`<a class="feed-row" href="${e.href}">${inner}</a>` : html`<div class="feed-row">${inner}</div>`}</li>`;
}

function latestCard(feed: { items: FeedItem[]; sources: string[] }, everything: boolean): SafeHtml {
  const list = feed.sources.map((s, i) => (i ? (i === feed.sources.length - 1 ? ` and ${s}` : `, ${s}`) : s.charAt(0).toUpperCase() + s.slice(1))).join('');
  return html`<section class="card" aria-labelledby="latest">
    <div class="card-h"><div><h2 id="latest">Latest</h2><div class="desc">${everything ? 'From every tool, newest first' : 'From the tools you can open, newest first'}</div></div></div>
    ${feed.items.length
      ? html`<ul class="feed">${feed.items.map(feedRow)}</ul>`
      : empty('inbox', 'Nothing yet', `${list} show up here as they happen.`)}
  </section>`;
}

/** A moderator's access, one row per tool: Edit, View, or which pages ("2 of 5 pages"). */
function accessCard(m: MemberAccess): SafeHtml {
  const row = (tool: Tool) => {
    const t = toolAccess(m, tool);
    const areas = areasOf(tool);
    // Some pages of a tool, not all at one level (the Inbox alone counts: it's always at least View).
    const some = t.open > 0 && t.level !== 'edit' && t.level !== 'view';
    const value = !t.open ? null : t.level === 'edit' ? 'Edit' : t.level === 'view' ? 'View' : `${t.open} of ${plural(t.pages, 'page')}${t.edit ? ` · ${t.edit} editable` : ''}`;
    const pages = some ? areas.filter((a) => levelOf(m.access, a) !== 'none').map((a) => `${AREAS[a].name}: ${levelOf(m.access, a)}`).join(' · ') : '';
    const title = areas.map((a) => `${AREAS[a].name}: ${levelOf(m.access, a).replace('none', 'no access')}`).join(' · ');
    return html`<div class="line sm my-access${pages ? ' two' : ''}" title="${title}">${icon(TOOL_ICONS[tool], 16, 'muted')}<span class="grow small">${areas.length === 1 ? AREAS[areas[0]!].name : TOOL_NAMES[tool]}</span>${value
      ? html`<span class="locked">${icon('circle-check', 14, 'ok')}${value}</span>`
      : locked('No access')}${pages ? html`<span class="ma-pages">${pages}</span>` : ''}</div>`;
  };
  return html`<section class="card" aria-labelledby="your-access">
    <div class="card-h"><div><h2 id="your-access">Your access</h2><div class="desc">Set by admins in Members &amp; permissions.</div></div></div>
    <div>${TOOLS.map(row)}</div>
  </section>`;
}

export function registerWorkspaceRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  // ---- Overview ---------------------------------------------------------------------------------

  app.get('/w/:wid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const m = ctx.membership;
    const p = ctx.progress!;
    const manage = can(m, 'manage');
    const [gh, dc, apps, counts] = await Promise.all([getGitHubConnection(deps.db, wid), getDiscordConnection(deps.db, wid), listApps(deps.db, wid), countByStatus(deps.db, wid)]);
    const repos = new Map(apps.map((a) => [a.repo_id, a.repo_name]));
    const shared: Shared = { web, ctx, dc, apps, repos, counts };
    // One card per tool this person can open a page of.
    const tools = OVERVIEW_TOOLS.filter((t) => firstPage(m, t) !== null);
    const [cards, feed] = await Promise.all([Promise.all(tools.map((t) => CARDS[t](shared))), latestFeed(shared)]);
    const enabledApps = apps.filter((a) => a.enabled);
    const act = can(m, 'inbox.edit');

    const attentionNotice = p.attention
      ? notice('warn', `${plural(p.attention, 'ticket')} need${p.attention === 1 ? 's' : ''} attention`,
          act
            ? [counts.uncertain ? `${counts.uncertain} couldn’t be confirmed on GitHub` : '', counts.failed ? `${counts.failed} failed` : ''].filter(Boolean).join(' and ') + '.'
            : 'You can view them. Retrying and closing them needs Edit on the Inbox.',
          { action: linkBtn(`${b}/tickets?status=attention`, act ? 'Review' : 'View', { size: 'sm' }) })
      : '';
    const grid = html`<div class="g2 tool-grid">${cards.map((c) => toolCard(ctx, c))}</div>`;

    if (!manage) {
      // Moderators: the same cards, for the tools they can open, and what they're allowed to do.
      const body = html`
        ${pageHeader({ title: 'Overview', description: `${ctx.workspace.name} · You're a moderator` })}
        ${attentionNotice}
        ${grid}
        <div class="g-2-1">
          ${latestCard(feed, false)}
          ${accessCard(m)}
        </div>`;
      return web.render(reply, ctx, 'Overview', 'overview', body);
    }

    const steps: { state: StepState; icon: IconName; name: string; detail: string; href: string; cta: string }[] = [
      {
        state: p.github, icon: 'github', name: 'GitHub', href: `${b}/setup/github`, cta: 'Connect GitHub',
        detail: gh ? `${gh.account_login} · ${gh.repository_selection === 'all' ? 'all repositories' : 'selected repositories'}${gh.status !== 'active' ? ` · ${gh.status}` : ''}` : 'Install the GitHub App on the account that owns your repositories.',
      },
      {
        state: p.discord, icon: 'message-circle', name: 'Discord', href: `${b}/setup/discord`, cta: 'Connect Discord',
        detail: dc ? `${dc.guild_name} · ${dc.status === 'active' ? 'bot ready' : 'bot removed'}` : 'Add the bot to your Discord server.',
      },
      {
        state: p.apps, icon: 'boxes', name: 'Apps & repositories', href: `${b}/apps`, cta: 'Add apps',
        detail: apps.length ? `${plural(enabledApps.length, 'app')} enabled` : 'Choose the apps members can pick and where each one files issues.',
      },
    ];
    const done = steps.filter((s) => s.state === 'done').length;
    const stepRow = (s: (typeof steps)[number]) => html`<a class="line setup-row" href="${s.href}">${icon(s.icon, 16, 'muted')}<span class="grow"><span class="name">${s.name}</span><span class="small muted"> · ${s.detail}</span></span>${s.state === 'done'
      ? icon('circle-check', 14, 'ok')
      : s.state === 'problem' ? icon('triangle-alert', 14, 'warn') : icon('circle-dashed', 14, 'faint')}</a>`;
    const setupDone = done === steps.length;
    const nextStep = steps.find((s) => s.state !== 'done');

    const body = html`
      ${pageHeader({
        title: 'Overview',
        description: setupDone ? `${ctx.workspace.name} · GitHub, Discord and ${plural(enabledApps.length, 'app')} are set up.` : `${ctx.workspace.name}${dc ? ` · ${dc.guild_name} on Discord` : ''}`,
      })}
      ${!deps.github || !deps.discord
        ? notice('warn', 'Deployment setup incomplete', 'Some provider credentials aren’t configured on the server, so parts of setup are unavailable.', { action: linkBtn(`${b}/deployment`, 'Open Deployment', { size: 'sm' }) })
        : ''}
      ${!setupDone ? html`<div class="card">
          <div class="card-h"><div><h2>Finish setup</h2><div class="desc">${String(done)} of ${String(steps.length)} steps done. Tickets start flowing once all three are connected.</div></div>${nextStep ? linkBtn(nextStep.href, nextStep.cta, { variant: 'primary', size: 'sm' }) : ''}</div>
          <div>${steps.map(stepRow)}</div></div>` : ''}
      ${attentionNotice}
      ${grid}
      ${latestCard(feed, true)}
      ${setupDone ? html`<details class="card setup-done">
          <summary>${icon('circle-check', 16, 'ok')}<span>Setup complete</span><span class="small muted truncate">GitHub · Discord · ${plural(enabledApps.length, 'app')}</span>${icon('chevron-down', 16, 'chev')}</summary>
          <div>${steps.map(stepRow)}</div></details>` : ''}`;
    return web.render(reply, ctx, 'Overview', 'overview', body);
  });

  // ---- Workspace settings -----------------------------------------------------------------------

  app.get('/w/:wid/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const ws = ctx.workspace;
    const body = html`
      ${pageHeader({ title: 'Settings', description: 'Workspace-wide settings and keys shared by the tools. Each tool’s own settings are on its pages.' })}
      <form method="post" action="${ctx.base}/settings" class="card" data-dirty>
        ${csrfField(ctx.csrf)}
        <div class="card-h"><h2>Workspace</h2></div>
        ${setting('Workspace name', 'Shown in the sidebar and on invitations.', html`<input id="name" type="text" name="name" value="${ws.name}" required maxlength="80">`, { for: 'name' })}
        ${setting('Keep ticket text', 'Encrypted copies kept for troubleshooting and retries. Unresolved tickets keep theirs for at least 90 days.',
          html`<input type="number" id="retention_days" name="retention_days" value="${String(ws.retention_days)}" min="1" max="365" required aria-label="Days to keep ticket text"><span class="connector">days</span>`)}
        <div class="card-f"><div class="end">
          <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
          ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
        </div></div>
      </form>
      ${await claudeCard(web, ctx)}`;
    return web.render(reply, ctx, 'Settings', 'settings', body);
  });

  const settingsSchema = z.object({
    name: z.string().trim().min(1, 'Enter a workspace name.').max(80),
    retention_days: z.coerce.number().int().min(1).max(365),
  });

  app.post('/w/:wid/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      setFlash(reply, 'error', 'Enter a workspace name and keep ticket text for 1 to 365 days.');
      return reply.redirect(`${ctx.base}/settings`);
    }
    await updateWorkspaceGeneral(deps.db, ctx.workspace.id, { name: parsed.data.name, retentionDays: parsed.data.retention_days });
    setFlash(reply, 'success', 'Settings saved');
    return reply.redirect(`${ctx.base}/settings`);
  });

  // ---- Deployment (one-time provider registration) ----------------------------------------------

  app.get('/w/:wid/provider-setup', async (req, reply) => reply.redirect(`/w/${(req.params as { wid: string }).wid}/deployment`));

  app.get('/w/:wid/deployment', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const c = deps.config;
    const [discordCheck, githubCheck, claude] = await Promise.all([
      checkDiscordCredentials(deps),
      checkGitHubCredentials(deps),
      keyStatus(web, ctx.workspace.id, { fresh: (req.query as { recheck?: string }).recheck === 'claude' }),
    ]);
    const state = (missing: string[], check: CredentialCheck) =>
      missing.length ? pill('Incomplete', 'warn') : check.ok ? pill('Working', 'ok') : pill('Credentials rejected', 'danger');
    const detail = (missing: string[], check: CredentialCheck) => (missing.length ? `Missing: ${missing.join(', ')}` : check.detail);
    const allOk = !c.missing.discord.length && !c.missing.github.length && discordCheck.ok && githubCheck.ok && claude.state !== 'rejected';
    const provider = (o: { icon: IconName; name: string; missing: string[]; check: CredentialCheck; label: string }) => html`<div class="line provider">
      <span class="tile">${icon(o.icon)}</span>
      <div class="grow"><div class="name">${o.name}</div><div class="sub">${detail(o.missing, o.check)}</div></div>
      ${state(o.missing, o.check)}${iconBtn('refresh-cw', `Re-test ${o.label} credentials`, { size: 'sm', href: `${ctx.base}/deployment` })}</div>`;
    const env = (names: string[]) => html`<div class="tags">${names.map((n) => html`<code>${n}</code>`)}</div>`;
    const body = html`
      ${pageHeader({
        title: 'Deployment',
        after: allOk ? pill('All configured', 'ok') : pill('Needs attention', 'warn'),
        description: 'One-time provider registration, done by whoever runs the server. Secret values are never shown here.',
      })}
      <div class="card">
        <div class="card-h"><h2>Providers</h2></div>
        ${provider({ icon: 'bot', name: 'Discord application', missing: c.missing.discord, check: discordCheck, label: 'Discord' })}
        ${provider({ icon: 'github', name: 'GitHub App', missing: c.missing.github, check: githubCheck, label: 'GitHub' })}
        <div class="line provider"><span class="tile">${icon('sparkles')}</span>
          <div class="grow"><div class="name">Claude API</div><div class="sub">${keySummary(claude, ctx.base)}${claude.source === 'workspace' && c.anthropicApiKey ? ' ANTHROPIC_API_KEY on the server is a fallback for workspaces without a key.' : ''}</div></div>
          ${keyPill(claude)}${claude.state === 'missing' ? linkBtn(`${ctx.base}/settings#claude`, 'Add key', { size: 'sm', trail: 'arrow-right' }) : iconBtn('refresh-cw', 'Re-test the Claude key', { size: 'sm', href: `${ctx.base}/deployment?recheck=claude` })}</div>
      </div>


      <div class="card">
        <div class="card-h"><div><h2>Discord Developer Portal</h2><div class="desc">Applications › your app.</div></div>${linkBtn('https://discord.com/developers/applications', 'Open portal', { variant: 'ghost', size: 'sm', trail: 'arrow-up-right', external: true })}</div>
        ${setting('Interactions endpoint URL', 'General Information. Discord sends panel clicks and forms here.', copyField('discord-interactions', web.publicUrl('/discord/interactions'), 'Interactions endpoint URL'), { top: true })}
        ${setting('OAuth2 redirect', 'OAuth2 › Redirects. Used for console sign-in and for adding the bot.', copyField('discord-redirect', web.publicUrl('/oauth/discord/callback'), 'OAuth2 redirect'), { top: true })}
        ${setting('Terms of Service URL', 'General Information. Required to verify the bot.', copyField('discord-terms', web.publicUrl('/terms'), 'Terms of Service URL'), { top: true })}
        ${setting('Privacy Policy URL', html`General Information. Required to verify the bot.${c.legal.contactEmail ? '' : html` ${tag('Set LEGAL_CONTACT_EMAIL', { icon: 'triangle-alert', title: 'The legal pages need a contact email. Set LEGAL_CONTACT_EMAIL (and LEGAL_OPERATOR_NAME) in .env.' })}`}`, copyField('discord-privacy', web.publicUrl('/privacy'), 'Privacy Policy URL'), { top: true })}
        ${setting('Bot', 'Keep Public Bot off unless other workspaces on this deployment should add it. No privileged intents are needed.', tag('No intents'))}
        ${setting('Server variables', 'Set in .env on the server.', env(['DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN']), { stacked: true })}
      </div>

      <div class="card">
        <div class="card-h"><div><h2>GitHub App</h2><div class="desc">Settings › Developer settings › GitHub Apps.</div></div>${linkBtn('https://github.com/settings/apps', 'Open settings', { variant: 'ghost', size: 'sm', trail: 'arrow-up-right', external: true })}</div>
        ${setting('Callback URL', 'Must be the first callback URL. Turn on “Request user authorization (OAuth) during installation”.', copyField('github-callback', web.publicUrl('/oauth/github/callback'), 'Callback URL'), { top: true })}
        ${setting('Webhook URL', html`Optional but recommended, so uninstalls show up right away. ${c.github?.webhookSecret ? tag('Webhook secret set', { icon: 'circle-check' }) : tag('No webhook secret')}`, copyField('github-webhook', web.publicUrl('/github/webhook'), 'Webhook URL'), { top: true })}
        ${setting('Repository permissions', 'Nothing else is needed, and no extra events.', html`<div class="tags">${tag('Issues: read and write')}${tag('Metadata: read')}${tag('Pull requests: read')}${tag('Contents: read')}</div>`, { top: true })}
        ${setting('Server variables', 'Set in .env on the server. The private key can be a path, such as secrets/sec.pem.', env(['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']), { stacked: true })}
        <div class="card-note">The full guide is in <code>docs/PROVIDER_SETUP.md</code>. After changing <code>.env</code> or <code>secrets/sec.pem</code>, run <code>pm2 restart all --update-env</code>.</div>
      </div>`;
    return web.render(reply, ctx, 'Deployment', 'deployment', body);
  });
}

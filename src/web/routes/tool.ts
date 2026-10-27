/**
 * The four tools in the sidebar (Discord tickets, GitHub issues, AI triage, Contributor roles):
 * where each of their pages lives, which ones someone can open, and the header and tabs every
 * page of a tool shares. Addresses from before the tools had their own place still work.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { announcementCounts, getAnnouncementSettings } from '../../announcements/settings.js';
import { checkContributorPanel, getContributorSettings } from '../../domain/contributors.js';
import type { Queryable } from '../../db/database.js';
import { checkPanel, type PanelState } from '../../domain/panel.js';
import { AREAS, areasOf, can, firstArea, hasEdit, TOOL_NAMES, type Area, type MemberAccess, type Tool } from '../../domain/permissions.js';
import { getDiscordConnection, listApps } from '../../domain/store.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { questionCounts } from '../../triage/knowledge.js';
import { getTriageSettings, monthlyUsage } from '../../triage/settings.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { chip, pageHeader, pill, plural, postBtn, tabs, timeAgo, viewOnlyTag, type IconName } from '../ui.js';

/** The tools that have their own item in the sidebar, in order. */
export type ToolName = 'tickets' | 'issues' | 'repos' | 'analytics' | 'triage' | 'contributors' | 'announcements' | 'bot';

/** Each tool's icon, in the sidebar, on the overview and on Members. */
export const TOOL_ICONS: Record<Tool, IconName> = { tickets: 'ticket', issues: 'circle-dot', repos: 'chart-no-axes-column-increasing', analytics: 'chart-line', triage: 'sparkles', contributors: 'award', announcements: 'megaphone', bot: 'bot', setup: 'boxes', workspace: 'activity' };

/** Every page's address under /w/:wid. */
export const AREA_PATHS: Record<Area, string> = {
  'inbox': '/tickets',
  'panel': '/tickets/panel',
  'types': '/tickets/types',
  'files': '/tickets/files',
  'ticket-settings': '/tickets/settings',
  'issues': '/issues',
  'issues-github': '/issues/github',
  'issues-sync': '/issues/sync',
  'repo-status': '/repos',
  'analytics': '/analytics',
  'triage.overview': '/triage/overview',
  'triage.review': '/triage',
  'triage.actions': '/triage/actions',
  'triage.labels': '/triage/labels',
  'triage.prompt': '/triage/prompt',
  'triage.knowledge': '/triage/knowledge',
  'triage.runs': '/triage/runs',
  'triage.activity': '/triage/activity',
  'verifications': '/contributors',
  'contributor-roles': '/contributors/roles',
  'contributor-panel': '/contributors/panel',
  'announcements': '/announcements',
  'announcement-settings': '/announcements/settings',
  'announcement-pings': '/announcements/pings',
  'known-issues': '/bot/known-issues',
  'apps': '/apps',
  'health': '/health',
};

/** A page's address. */
export function areaHref(ctx: Pick<WorkspaceRequestContext, 'base'> | string, area: Area): string {
  return `${typeof ctx === 'string' ? ctx : ctx.base}${AREA_PATHS[area]}`;
}

/** An app's TRIAGE.md page (AI triage › Knowledge). */
export function knowledgeHref(ctx: Pick<WorkspaceRequestContext, 'base'>, appId: string): string {
  return `${ctx.base}${AREA_PATHS['triage.knowledge']}/${appId}`;
}

/**
 * The link from Claude's question on a ticket or issue to its app's TRIAGE.md, for someone who
 * can open Knowledge (null otherwise).
 */
export function knowledgeLink(ctx: Pick<WorkspaceRequestContext, 'base' | 'membership'>, appId: string | null | undefined): { href: string; edit: boolean } | null {
  return appId && canOpen(ctx.membership, 'triage.knowledge') ? { href: `${knowledgeHref(ctx, appId)}?tab=all`, edit: can(ctx.membership, 'triage.knowledge.edit') } : null;
}

/** Whether this person can open a page (its route checks the same). */
export function canOpen(m: MemberAccess, area: Area): boolean {
  return can(m, `${area}.view`);
}

/** Whether this person can open an issue's own page: it needs one of the GitHub issues pages. */
export function canOpenIssue(m: MemberAccess): boolean {
  return canOpen(m, 'issues') || canOpen(m, 'issues-github');
}

/** The first page of a tool this person can open, in tab order (null: none). */
export function firstPage(m: MemberAccess, tool: Tool): Area | null {
  return firstArea(m, tool);
}

/** A Discord panel's state as a pill: Live, Panel deleted, Check panel or Not published. */
export function panelPill(state: PanelState['state']): SafeHtml {
  return state === 'published' ? pill('Live', 'ok') : state === 'missing' ? pill('Panel deleted', 'warn') : state === 'unknown' ? pill('Check panel', 'warn') : pill('Not published', 'neutral');
}

/**
 * Issues in a repository the workspace still has an app for (on issue_triage aliased t). Written as
 * EXISTS so counts of what's waiting still use issue_triage_waiting_idx.
 */
export const IN_WORKSPACE_REPOS = 'EXISTS (SELECT 1 FROM apps a WHERE a.workspace_id = t.workspace_id AND a.repo_id = t.repo_id)';

/**
 * How up to date the workspace's repositories are: "3 repositories · synced 2 minutes ago".
 * `oldest` is when the least recently synced one was synced (everything is at least that fresh).
 */
export async function repoSyncState(db: Queryable, repoIds: readonly number[]): Promise<{ problem: boolean; loading: boolean; oldest: Date | null; text: string }> {
  const { rows } = await db.query<{ status: string; last_synced_at: Date | null }>('SELECT status, last_synced_at FROM issue_index_repos WHERE repo_id IN (SELECT value FROM json_each($1))', [JSON.stringify(repoIds)]);
  const problem = rows.some((r) => r.status === 'error');
  const loading = rows.length < repoIds.length || rows.some((r) => r.status === 'loading');
  const oldest = rows.length && rows.every((r) => r.last_synced_at) ? new Date(Math.min(...rows.map((r) => r.last_synced_at!.getTime()))) : null;
  const state = problem ? 'sync problem' : loading ? 'first load running' : oldest ? `synced ${timeAgo(oldest)}` : 'not synced yet';
  return { problem, loading, oldest, text: repoIds.length ? `${plural(repoIds.length, 'repository', 'repositories')} · ${state}` : 'No repositories yet' };
}

/** Where a tool's sidebar item and breadcrumb go: the first of its pages this person can open. */
export function toolHref(ctx: Pick<WorkspaceRequestContext, 'base' | 'membership'>, tool: Tool): string | null {
  const first = firstPage(ctx.membership, tool);
  return first ? areaHref(ctx, first) : null;
}

/** A link to a page, or just its text for someone who can't open it. */
export function pageLink(ctx: Pick<WorkspaceRequestContext, 'base' | 'membership'>, area: Area, text: SafeHtml | string, hash = ''): SafeHtml | string {
  return canOpen(ctx.membership, area) ? html`<a href="${areaHref(ctx, area)}${hash}">${text}</a>` : text;
}

/** Why a page is View only, for its tag. */
const VIEW_ONLY: Partial<Record<Area, string>> = {
  'inbox': 'You can read tickets. Checking GitHub, retrying, linking and closing need Edit on the Inbox. Ask an admin or the owner.',
  'files': 'You can see the stored files. Scanning and deleting them needs Edit on Files. Ask an admin or the owner.',
  'issues-sync': 'You can see how up to date each repository is. Sync now needs Edit on Sync. Ask an admin if you need it.',
  'repo-status': 'You can see each repository’s status. Choosing the repositories and refreshing need Edit on Repo status. Ask an admin if you need it.',
  'analytics': 'You can see the analytics. Turning recording on or off needs Edit on Analytics. Ask an admin if you need it.',
  'triage.review': 'You can see the suggestions. Applying and dismissing them needs Edit on Review. Ask an admin if you need it.',
  'triage.actions': 'You can see the triage settings. Ask an admin if you need to change them.',
  'triage.labels': 'You can see the custom labels. Ask an admin if you need to change them.',
  'triage.prompt': 'You can see the prompt. Ask an admin if you need to change it.',
  'triage.knowledge': 'You can read each app’s TRIAGE.md and Claude’s questions. Writing them needs Edit on Knowledge. Ask an admin if you need it.',
  'triage.runs': 'You can see re-runs and their results. Ask an admin if you need to start, stop or apply them.',
  'verifications': 'You can see verifications. Ask an admin if you need to revoke roles.',
  'panel': 'You can see the panel, its health and preview. Changing, publishing and removing it need Edit on Panel. Ask an admin if you need it.',
  'types': 'You can see the ticket types and their forms. Ask an admin if you need to change them.',
  'ticket-settings': 'You can see the spam and duplicate limits. Ask an admin if you need to change them.',
  'contributor-roles': 'You can see the roles and what counts. Ask an admin if you need to change them.',
  'contributor-panel': 'You can see the panel and its preview. Ask an admin if you need to change, publish or remove it.',
  'announcements': 'You can see the releases and their posts. Posting, editing and skipping them need Edit on Posts. Ask an admin if you need it.',
  'announcement-settings': 'You can see how announcements are set up. Ask an admin if you need to change it.',
  'announcement-pings': 'You can see the pings message and its preview. Ask an admin if you need to change, publish or remove it.',
  'known-issues': 'You can see the known-issues board and its settings. Changing them, pinning or hiding issues, and publishing need Edit on Known issues. Ask an admin if you need it.',
  'health': 'You can see how the server is doing. Switching Dev mode needs Edit on Server health. Ask an admin if you need it.',
};

export function viewOnlyText(area: Area): string {
  return VIEW_ONLY[area] ?? `You can see ${AREAS[area].name}. Ask an admin if you need to change it.`;
}

/** Shown in place of a link when someone can't open a page. */
export function lockedText(area: Area): string {
  return `You don’t have access to ${AREAS[area].name}. Ask an admin if you need it.`;
}

type Actions = SafeHtml | (SafeHtml | false | null | undefined)[] | null | undefined;
const list = (a: Actions): (SafeHtml | false | null | undefined)[] => (Array.isArray(a) ? a : a ? [a] : []);

/** Each tool's status, description and header actions. */
async function toolState(web: Web, ctx: WorkspaceRequestContext, tool: ToolName, current: Area): Promise<{ status: SafeHtml | ''; description: string; actions: SafeHtml[]; counts: Partial<Record<Area, number>> }> {
  const { db } = web.deps;
  const wid = ctx.workspace.id;
  const m = ctx.membership;
  if (tool === 'tickets') {
    const [state, conn] = await Promise.all([checkPanel(web.deps, wid, { live: false }), getDiscordConnection(db, wid)]);
    return {
      status: panelPill(state.state),
      description: `Members open tickets from ${conn?.tickets_channel_name ? `#${conn.tickets_channel_name}` : 'a panel'} in Discord. Each one is filed as a GitHub issue in the app’s repository.`,
      actions: [],
      counts: { inbox: ctx.progress?.attention ?? 0 },
    };
  }
  if (tool === 'issues') {
    const repoIds = [...new Set((await listApps(db, wid)).map((a) => a.repo_id))];
    const [{ problem, loading, text }, { rows: waiting }] = await Promise.all([
      repoSyncState(db, repoIds),
      db.query<{ n: number }>(`SELECT count(*) AS n FROM issue_triage t WHERE t.workspace_id = $1 AND t.status = 'done' AND t.suggestion_count > 0 AND ${IN_WORKSPACE_REPOS}`, [wid]),
    ]);
    const syncHref = current !== 'issues-sync' && canOpen(m, 'issues-sync') ? areaHref(ctx, 'issues-sync') : undefined;
    return {
      status: '',
      description: 'Every issue in your connected repositories, open and closed, wherever it was opened.',
      actions: [
        chip(text, { tone: problem || !repoIds.length ? 'warn' : loading ? null : 'ok', href: syncHref, title: syncHref ? 'See each repository on the Sync page' : undefined }),
        can(m, 'issues-sync.edit') && repoIds.length
          ? postBtn(`${ctx.base}/issues/sync`, 'Sync now', ctx.csrf, { icon: 'refresh-cw', loading: 'Syncing…', fields: { back: areaHref(ctx, current) } })
          : null,
      ].filter((x): x is SafeHtml => Boolean(x)),
      counts: { 'issues-github': Number(waiting[0]?.n ?? 0) },
    };
  }
  if (tool === 'triage') {
    const [settings, usage, questions] = await Promise.all([
      getTriageSettings(db, wid),
      monthlyUsage(db, wid),
      canOpen(m, 'triage.knowledge') ? questionCounts(db, wid) : null,
    ]);
    const c = settings.config;
    const anyOn = settings.enabled || settings.githubEnabled;
    const full = usage.triaged >= c.monthlyLimit;
    return {
      status: !anyOn ? pill('Off', 'neutral') : settings.paused ? pill('Paused', 'warn') : pill('On', 'ok'),
      description: 'Claude reads every new Discord ticket and every issue opened on GitHub, and flags priority, duplicates, spam and labels.',
      actions: [chip(`${c.model} · ${usage.triaged.toLocaleString('en-US')} of ${c.monthlyLimit.toLocaleString('en-US')} this month`, { tone: anyOn && full ? 'warn' : null, title: 'Tickets and issues triaged this month, re-runs included, and the monthly limit' })],
      // Knowledge: questions Claude asked since each app's TRIAGE.md was last saved.
      counts: { 'triage.review': ctx.progress?.review ?? 0, 'triage.knowledge': [...(questions?.values() ?? [])].reduce((n, q) => n + q.fresh, 0) },
    };
  }
  if (tool === 'bot') {
    // Each feature's page shows whether it's on; the header only says what the tool is.
    return {
      status: '',
      description: 'Extra things the bot does in your Discord. Each one is off until you turn it on.',
      actions: [],
      counts: {},
    };
  }
  if (tool === 'announcements') {
    const [s, counts] = await Promise.all([getAnnouncementSettings(db, wid), announcementCounts(db, wid)]);
    return {
      status: !s.enabled ? pill('Off', 'neutral') : s.mode === 'auto' ? pill('Automatic', 'ok') : pill('Review first', 'ok'),
      description: `Posts each app’s new GitHub releases in Discord${s.channelName ? ` (#${s.channelName})` : ''}, with release notes Claude makes friendlier and an optional role ping.`,
      actions: [],
      counts: { announcements: counts.waiting + counts.failed },
    };
  }
  const [settings, conn] = await Promise.all([getContributorSettings(db, wid), getDiscordConnection(db, wid)]);
  const panel = await checkContributorPanel(web.deps, wid, conn, { live: false });
  return {
    status: !settings.enabled ? pill('Off', 'neutral') : panelPill(panel.state),
    description: `Members verify with GitHub${settings.channel_name ? ` in #${settings.channel_name}` : ''} and get a role for their contributions.`,
    actions: [],
    counts: {},
  };
}

/**
 * The header and tabs of a tool's page: the tool's name and status, then one tab per page in
 * AREAS order. Pages this person can't open are shown locked; a page they can see but not
 * change gets a "View only" tag.
 */
export async function toolHeader(web: Web, ctx: WorkspaceRequestContext, tool: ToolName, current: Area, o: { actions?: Actions; after?: Actions; description?: SafeHtml | string } = {}): Promise<SafeHtml> {
  const m = ctx.membership;
  const state = await toolState(web, ctx, tool, current);
  const viewOnly = hasEdit(current) && !can(m, `${current}.edit`);
  return html`${pageHeader({
    title: TOOL_NAMES[tool],
    after: [state.status, viewOnly ? viewOnlyTag(viewOnlyText(current)) : '', ...list(o.after)],
    description: o.description ?? state.description,
    actions: [...state.actions, ...list(o.actions)],
  })}
  ${tabs(TOOL_NAMES[tool], areasOf(tool).map((a) => ({
    href: areaHref(ctx, a),
    label: AREAS[a].name,
    current: a === current,
    count: state.counts[a] || undefined,
    tone: a === 'inbox' ? 'warn' as const : 'accent' as const,
    locked: canOpen(m, a) ? undefined : lockedText(a),
  })))}`;
}

/**
 * A tool's landing page: someone who can't open it but can open another page of the tool goes
 * there instead (a moderator with only Activity opening /triage lands on /triage/activity).
 */
export async function landOn(web: Web, req: FastifyRequest, reply: FastifyReply, area: Area): Promise<WorkspaceRequestContext | null> {
  const ctx = await web.requireWorkspace(req, reply, { permission: 'view' });
  if (!ctx) return null;
  if (canOpen(ctx.membership, area)) return ctx;
  const first = firstPage(ctx.membership, AREAS[area].tool);
  if (first) {
    reply.redirect(areaHref(ctx, first));
    return null;
  }
  // The usual "no access" page.
  return web.requireWorkspace(req, reply, { permission: `${area}.view` });
}

/** Every method, so forms posted from a page opened before the move still arrive (307 keeps the body). */
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Old addresses from when GitHub issues and AI triage were tabs of Tickets. */
export function registerMovedRoutes(app: FastifyInstance): void {
  const moved = (from: string, to: (rest: string) => string) => {
    app.route({
      method: [...METHODS],
      url: `/w/:wid${from}`,
      handler: async (req, reply) => {
        const p = req.params as { wid: string; '*'?: string };
        const rest = (p['*'] ?? '').split('/').map(encodeURIComponent).join('/');
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        // Links and bookmarks move for good; anything else is sent on with its body.
        return reply.redirect(`/w/${encodeURIComponent(p.wid)}${to(rest)}${qs}`, req.method === 'GET' || req.method === 'HEAD' ? 301 : 307);
      },
    });
  };
  moved('/tickets/triage', () => '/triage/actions');
  moved('/tickets/triage/*', (rest) => (rest ? `/triage/${rest}` : '/triage/actions'));
  moved('/tickets/issues', () => '/issues');
  moved('/tickets/issues/triage', () => '/issues/github');
  moved('/tickets/issues/sync', () => '/issues/sync');
  moved('/tickets/issues/*', (rest) => (rest ? `/issues/${rest}` : '/issues'));
}

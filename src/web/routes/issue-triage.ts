/**
 * Issues › Triage: issues opened directly on GitHub that triage looked at, and a page per issue
 * with the same Triage card as tickets (What Apply does, Apply, Dismiss). The issue text is
 * shown live from GitHub; only its triage result is stored here.
 */
import type { FastifyInstance } from 'fastify';
import { can } from '../../domain/permissions.js';
import { getGitHubConnection, listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { userNames } from '../../domain/workspaces.js';
import { GitHubApiError, type IssueDetail } from '../../github/client.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import type { IssueTriageRow, Subject } from '../../triage/engine.js';
import { getTriageSettings, parseTriageConfig, type TriageConfig } from '../../triage/settings.js';
import { actionMatcher, CONFIDENCE_STEPS, confidenceFilter, TRIAGE_STATES, triageFilter, triageFilterGroups } from '../../triage/state.js';
import { bulkBanner, bulkBar } from './triage-bulk.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { avatar, empty, formatDate, icon, labelTag, linkBtn, notice, pageHeader, pill, segLinks, selectWrap, tag, timeAgo, when } from '../ui.js';
import { ticketsHeader, triageCard, triageCell } from './tickets.js';

const PAGE = 50;
const LIVE_TIMEOUT_MS = 5000;

type Show = 'review' | 'partial' | 'applied' | 'reviewed' | 'nothing' | 'queued' | 'skipped' | 'all';
const SHOWS: { key: Show; label: string; where: string }[] = [
  ...(['review', 'partial', 'applied', 'reviewed', 'nothing', 'queued'] as const).map((k) => ({ key: k, label: TRIAGE_STATES[k].label, where: triageFilter(`s:${k}`, parseTriageConfig({}))!.where(() => '') })),
  { key: 'skipped', label: 'Skipped or failed', where: `t.status IN ('skipped', 'failed')` },
  { key: 'all', label: 'All', where: '1' },
];

type Row = IssueTriageRow & { title: string | null; html_url: string | null; issue_state: string | null; issue_state_reason: string | null; opened_at: Date | null; issue_updated_at: Date | null; author: string | null; author_avatar: string | null; owner: string | null; name: string | null };

/** One row of an Issues table (both views). */
export interface IssueTableRow {
  repoId: number;
  number: number;
  title: string;
  closed: boolean;
  /** GitHub's reason: completed, not_planned, duplicate. */
  closedReason?: string | null;
  url: string;
  repoName: string;
  app: string | null;
  author: string | null;
  authorAvatar: string | null;
  /** The ticket came from Discord: the author is the member there (GitHub shows the bot). */
  viaDiscord?: boolean;
  updatedAt: Date | null;
  /** Where the title goes: the ticket, the triage page, or GitHub. */
  href: string;
  external: boolean;
  triage: SafeHtml | string;
  /** Extra line under the title (search match, duplicate of). */
  extra?: SafeHtml | string;
  select?: { value: string; match: boolean } | null;
}

/** A repository shared by many apps: the first two, then "+N more". */
function shortApps(apps: string | null): string | null {
  const list = (apps ?? '').split(', ').filter(Boolean);
  return list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2} more` : apps;
}

/** The Issues table: like the inbox, a table on desktop and stacked rows on phones. */
export function issueTable(rows: IssueTableRow[], o: { select?: boolean } = {}): SafeHtml {
  const target = (r: IssueTableRow) => (r.external ? raw('target="_blank" rel="noopener noreferrer"') : '');
  const closedText = (r: IssueTableRow) => (r.closedReason === 'not_planned' ? 'Closed · not planned' : r.closedReason === 'duplicate' ? 'Closed · duplicate' : 'Closed');
  const closedTag = (r: IssueTableRow) => (r.closed ? html` ${tag(closedText(r))}` : '');
  return html`<div class="table-wrap only-desktop"><table>
      <thead><tr>${o.select ? html`<th class="check-col"><input type="checkbox" class="rule-check" data-select-all="bulk-triage" aria-label="Select every issue on this page"></th>` : ''}<th>Issue</th><th>Reporter</th><th>Triage</th><th>GitHub issue</th><th class="num">Updated</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class="click">
        ${o.select ? html`<td class="check-col">${r.select ? html`<input type="checkbox" class="rule-check" name="ticket" value="${r.select.value}" form="bulk-triage" ${r.select.match ? raw('data-match') : ''} aria-label="Select issue #${String(r.number)}">` : ''}</td>` : ''}
        <td><a class="cell-title" href="${r.href}" ${target(r)}>${r.title}</a>${closedTag(r)}<div class="sub">${[shortApps(r.app), r.repoName].filter(Boolean).join(' · ')}</div>${r.extra ?? ''}</td>
        <td>${r.author ? html`<span class="who-cell">${avatar(r.author, 20, { src: r.authorAvatar })}<span class="small">${r.author}</span>${r.viaDiscord ? html`<span title="Reported in Discord">${icon('message-circle', 14, 'faint')}</span>` : ''}</span>` : html`<span class="em">—</span>`}</td>
        <td>${r.triage}</td>
        <td><a class="inline gap-4 nowrap" href="${r.url}" target="_blank" rel="noopener noreferrer">${icon('circle-dot', 14, r.closed ? 'faint' : 'muted')}${r.repoName}#${String(r.number)}</a></td>
        <td class="num">${r.updatedAt ? when(r.updatedAt) : html`<span class="em">—</span>`}</td></tr>`)}</tbody></table></div>
    <ul class="list only-mobile">${rows.map((r) => html`<li><a class="list-row" href="${r.href}" ${target(r)}>
      <span class="l1">${r.title}</span>${r.closed ? tag(closedText(r)) : ''}
      <span class="l2 tri-line-m">${r.triage}</span>
      <span class="l2">${[shortApps(r.app), `${r.repoName}#${r.number}`, r.author, r.updatedAt ? timeAgo(r.updatedAt) : null].filter(Boolean).join(' · ')}</span></a></li>`)}</ul>`;
}

type IssueQuery = { show?: string; f?: string; conf?: string };

/** The Triage list's filters as SQL on issue_triage t (the first parameter is the workspace). */
function issueFilters(wid: string, q: IssueQuery, config: TriageConfig) {
  const show = SHOWS.find((x) => x.key === q.show) ?? SHOWS[0]!;
  // More filters: priority, what triage flagged, labels (status is the tabs).
  const extra = q.f && !q.f.startsWith('s:') ? triageFilter(q.f, config) : null;
  const confSpec = confidenceFilter(q.conf);
  const params: unknown[] = [wid];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = `t.workspace_id = $1 AND ${show.where}${extra ? ` AND ${extra.where(bind)}` : ''}${confSpec ? ` AND ${confSpec.where(bind)}` : ''}`;
  return { show, extra, confSpec, where, params, bind };
}

/** Everything in the Triage list with these filters (bulk Apply "all in this list"). */
export async function issueTriageSubjects(web: Web, wid: string, q: IssueQuery, limit: number): Promise<Subject[]> {
  const settings = await getTriageSettings(web.deps.db, wid);
  const f = issueFilters(wid, q, settings.config);
  const { rows } = await web.deps.db.query<{ repo_id: number; number: number }>(`SELECT t.repo_id, t.number FROM issue_triage t WHERE ${f.where} LIMIT ${f.bind(limit)}`, f.params);
  return rows.map((r) => ({ kind: 'issue', repoId: r.repo_id, number: r.number }));
}

/** "All issues" and "Triage" inside the Issues tab. */
export function issuesNav(ctx: WorkspaceRequestContext, current: 'all' | 'triage', toReview?: number): SafeHtml {
  return html`<div class="subnav">${segLinks('Issues', [
    { href: `${ctx.base}/tickets/issues/triage`, label: 'Opened on GitHub · Triage', count: toReview || undefined, current: current === 'triage' },
    { href: `${ctx.base}/tickets/issues`, label: 'All issues', current: current === 'all' },
  ])}</div>`;
}

/** How many issues opened on GitHub wait for review (the Triage count), or null when this was never used. */
export async function issueTriageCount(web: Web, workspaceId: string): Promise<number | null> {
  const { rows } = await web.deps.db.query<{ n: number; total: number }>(
    `SELECT sum(status = 'done' AND suggestion_count > 0) AS n, count(*) AS total FROM issue_triage WHERE workspace_id = $1`,
    [workspaceId],
  );
  const settings = await getTriageSettings(web.deps.db, workspaceId);
  return rows[0]?.total || settings.githubEnabled ? Number(rows[0]?.n ?? 0) : null;
}

function eventText(e: { kind: string; detail: Record<string, unknown> }, names: Map<string, string>): { by: string | null; text: SafeHtml } {
  const d = e.detail;
  const by = typeof d.by === 'string' ? names.get(d.by) ?? 'An admin' : null;
  const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as string[]) : []);
  const summary = [list('applied').length ? `applied ${list('applied').join(', ')}` : '', list('suggested').length ? `suggested ${list('suggested').join(', ')}` : ''].filter(Boolean).join(' · ');
  switch (e.kind) {
    case 'triage_done':
      return { by: null, text: html`Triage ${summary || 'found nothing to flag'}` };
    case 'triage_rerun':
      return { by, text: html`Triage re-run ${summary || 'found nothing to flag'}${by ? html` · by <span class="actor">${by}</span>` : ''}` };
    case 'triage_applied':
      return { by, text: html`<span class="actor">${by}</span> applied the triage suggestion: ${list('actions').join(', ')}` };
    case 'triage_dismissed':
      return { by, text: html`<span class="actor">${by}</span> dismissed the triage suggestion: ${list('actions').join(', ')}` };
    default:
      return { by, text: html`${e.kind}` };
  }
}

export function registerIssueTriageRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  /** The workspace's repositories (only issues in these can be shown). */
  async function repoOf(workspaceId: string, repoId: number) {
    const a = (await listApps(deps.db, workspaceId)).filter((x) => x.repo_id === repoId);
    return a.length ? { owner: a[0]!.repo_owner, name: a[0]!.repo_name, apps: a.map((x) => x.name) } : null;
  }

  app.get('/w/:wid/tickets/issues/triage', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'issues.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const q = req.query as IssueQuery & { page?: string };
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    const settings = await getTriageSettings(deps.db, wid);
    const { show, extra, confSpec, where, params, bind } = issueFilters(wid, q, settings.config);
    const { rows: counts } = await deps.db.query<Record<string, number>>(
      `SELECT ${SHOWS.map((x) => `sum(${x.where.replace(/\bt\./g, '')}) AS "${x.key}"`).join(', ')} FROM issue_triage WHERE workspace_id = $1`,
      [wid],
    );
    const count = (k: Show) => Number(counts[0]?.[k] ?? 0);
    const [{ rows: total }, { rows }] = await Promise.all([deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM issue_triage t WHERE ${where}`, [...params]), deps.db.query<Row>(
      `SELECT t.*, x.title, x.html_url, x.state AS issue_state, x.state_reason AS issue_state_reason, x.created_at AS opened_at, x.updated_at AS issue_updated_at, x.author, x.author_avatar,
         COALESCE(ir.owner, a.repo_owner) AS owner, COALESCE(ir.name, a.repo_name) AS name
       FROM issue_triage t
       LEFT JOIN issue_index x ON x.repo_id = t.repo_id AND x.number = t.number
       LEFT JOIN issue_index_repos ir ON ir.repo_id = t.repo_id
       LEFT JOIN (SELECT repo_id, min(repo_owner) AS repo_owner, min(repo_name) AS repo_name FROM apps WHERE workspace_id = $1 GROUP BY repo_id) a ON a.repo_id = t.repo_id
       WHERE ${where} ORDER BY COALESCE(x.created_at, t.created_at) DESC LIMIT ${bind(PAGE + 1)} OFFSET ${bind((page - 1) * PAGE)}`,
      params,
    )]);
    // Bulk Apply/Dismiss: people who can act pick issues with a matching suggestion.
    const act = can(ctx.membership, 'tickets.act');
    const matcher = actionMatcher({ triage: extra?.value, conf: confSpec?.value }, settings.config);
    const matches = (r: Row) => r.status === 'done' && (r.suggestions ?? []).some(matcher.test);
    const shownRows = rows.slice(0, PAGE);
    const anySelectable = act && shownRows.length > 0;
    const hasMore = rows.length > PAGE;
    const link = (o: { show?: Show; page?: number }) => {
      const p = new URLSearchParams();
      const s = o.show ?? show.key;
      if (s !== 'review') p.set('show', s);
      if (extra) p.set('f', extra.value);
      if (confSpec) p.set('conf', confSpec.value);
      if (o.page && o.page > 1) p.set('page', String(o.page));
      const qs = p.toString();
      return `${b}/tickets/issues/triage${qs ? `?${qs}` : ''}`;
    };
    const apps = await listApps(deps.db, wid);
    const appsOf = (repoId: number) => apps.filter((a) => a.repo_id === repoId).map((a) => a.name).join(', ') || null;
    const table = issueTable(shownRows.map((r) => ({
      repoId: r.repo_id,
      number: r.number,
      title: r.title ?? `Issue #${r.number}`,
      closed: r.issue_state === 'closed',
      closedReason: r.issue_state_reason,
      url: r.html_url ?? `https://github.com/${r.owner}/${r.name}/issues/${r.number}`,
      repoName: r.name ?? '',
      app: appsOf(r.repo_id),
      author: r.author,
      authorAvatar: r.author_avatar,
      updatedAt: r.issue_updated_at ?? r.updated_at,
      href: `${b}/tickets/issues/${String(r.repo_id)}/${String(r.number)}`,
      external: false,
      triage: triageCell(r),
      extra: r.status === 'skipped' || r.status === 'failed' ? html`<div class="sub">${r.status === 'skipped' ? r.skip_reason : r.error}</div>` : '',
      select: anySelectable ? { value: `gh:${r.repo_id}:${r.number}`, match: matches(r) } : null,
    })), { select: anySelectable });

    const body = html`
      ${await ticketsHeader(web, ctx, 'issues')}
      ${issuesNav(ctx, 'triage', count('review'))}
      <div class="stack">
        ${!settings.githubEnabled ? notice('info', 'Triage of issues opened on GitHub is off', can(ctx.membership, 'triage.actions.edit') ? html`Turn it on in <a href="${b}/tickets/triage">Triage › Actions</a>${can(ctx.membership, 'triage.runs.edit') ? html`, or use <a href="${b}/tickets/triage/runs">Re-run</a> for issues already open` : ''}.` : 'An admin can turn it on in Triage › Actions.') : ''}
        <div class="card">
          <div class="card-h"><div><h2>Issues opened on GitHub</h2><div class="desc">Issues people opened directly on GitHub (not through Discord) that triage looked at. Open one to see what triage suggests and what applying it does.</div></div></div>
          <div class="toolbar">${segLinks('Show', SHOWS.map((x) => ({ href: link({ show: x.key, page: 1 }), label: x.label, count: count(x.key), current: x.key === show.key })))}
            <form method="get" action="${b}/tickets/issues/triage" class="tools">${show.key !== 'review' ? html`<input type="hidden" name="show" value="${show.key}">` : ''}
              ${selectWrap(html`<select name="f" aria-label="More filters" data-autosubmit><option value="">All priorities and flags</option>${triageFilterGroups(settings.config).filter((g) => g.label !== 'Triage status').map((g) => html`<optgroup label="${g.label}">${g.options.map((o) => html`<option value="${o.value}" ${o.value === extra?.value ? raw('selected') : ''}>${o.label}</option>`)}</optgroup>`)}</select>`, { sm: true })}
              ${selectWrap(html`<select name="conf" aria-label="Filter by triage confidence" data-autosubmit><option value="">Any confidence</option>${CONFIDENCE_STEPS.map((c) => html`<option value="${String(c)}" ${String(c) === confSpec?.value ? raw('selected') : ''}>Confidence ${String(c)}%+</option>`)}</select>`, { sm: true })}
              <button type="submit" class="btn sm nojs">Show</button></form></div>
          ${act ? await bulkBanner(web, ctx) : ''}
          ${anySelectable ? bulkBar(ctx, { matcher, selectable: shownRows.length, matching: Number(total[0]?.n ?? 0), from: 'issues', hidden: { show: show.key, f: extra?.value, conf: confSpec?.value }, back: link({ page }) }) : ''}
          <div class="card-b flush">${shownRows.length
            ? table
            : empty('inbox', show.key === 'review' ? 'Nothing to review' : 'No issues here', show.key === 'review' ? 'Triage suggestions for issues opened on GitHub show up here.' : 'Nothing matches this filter.')}</div>
          ${page > 1 || hasMore ? html`<div class="pager"><span>Page ${String(page)}</span><div class="row">
            ${page > 1 ? linkBtn(link({ page: page - 1 }), 'Previous', { size: 'sm', icon: 'chevron-left' }) : ''}${hasMore ? linkBtn(link({ page: page + 1 }), 'Next', { size: 'sm', trail: 'chevron-right' }) : ''}</div></div>` : ''}
        </div>
      </div>`;
    return web.render(reply, ctx, 'Triage · Issues', 'tickets', body);
  });

  app.get('/w/:wid/tickets/issues/:repoId/:number', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'issues.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const p = req.params as { repoId: string; number: string };
    const repoId = Number(p.repoId);
    const number = Number(p.number);
    const repo = Number.isInteger(repoId) && Number.isInteger(number) && number > 0 ? await repoOf(wid, repoId) : null;
    if (!repo) return reply.callNotFound();
    const b = ctx.base;
    const t = await web.triage.getIssueResult(wid, repoId, number);
    const { rows: ticket } = await deps.db.query<{ id: string }>('SELECT id FROM submissions WHERE workspace_id = $1 AND repo_id = $2 AND issue_number = $3', [wid, repoId, number]);
    // Issues filed through Discord have their ticket page.
    if (ticket[0]) return reply.redirect(`${b}/tickets/${ticket[0].id}`);

    // The issue itself, live from GitHub.
    let live: { kind: 'ok'; issue: IssueDetail } | { kind: 'missing' } | { kind: 'error' } = { kind: 'error' };
    if (deps.github) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const conn = await getGitHubConnection(deps.db, wid);
        if (conn) {
          const issue = await Promise.race([
            deps.github.getIssueDetail(conn.installation_id, repo.owner, repo.name, number),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), LIVE_TIMEOUT_MS); }),
          ]);
          live = { kind: 'ok', issue };
        }
      } catch (err) {
        if (err instanceof GitHubApiError && (err.status === 404 || err.status === 410)) live = { kind: 'missing' };
      } finally {
        clearTimeout(timer);
      }
    }
    const { rows: events } = t ? await deps.db.query<{ id: number; kind: string; detail: Record<string, unknown>; at: Date }>('SELECT * FROM issue_triage_events WHERE triage_id = $1 ORDER BY id DESC LIMIT 50', [t.id]) : { rows: [] };
    const names = await userNames(deps.db, events.map((e) => (typeof e.detail.by === 'string' ? e.detail.by : null)));
    const url = `https://github.com/${repo.owner}/${repo.name}/issues/${number}`;
    const issue = live.kind === 'ok' ? live.issue : null;
    const text = issue ? issue.body.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 20_000) : '';
    const actionBase = `${b}/tickets/issues/${repoId}/${number}`;

    const body = html`
      ${pageHeader({
        title: issue?.title ?? `Issue #${number}`,
        crumbs: [{ href: `${b}/tickets/issues`, label: 'Issues' }, { href: `${b}/tickets/issues/triage`, label: 'Triage' }, { label: `#${number}` }],
        after: [issue ? (issue.state === 'open' ? pill('Open', 'ok') : pill('Closed', 'closed')) : live.kind === 'missing' ? pill('Deleted on GitHub', 'warn') : '', pill('Opened on GitHub', 'neutral')],
        description: `${repo.owner}/${repo.name}${issue?.author ? ` · opened by ${issue.author}` : ''}${issue ? ` ${timeAgo(issue.createdAt)}` : ''}`,
        actions: [linkBtn(url, 'Open on GitHub', { external: true, trail: 'arrow-up-right' })],
      })}
      <div class="detail-grid">
        <div class="a-desc a-col"><div class="card"><div class="card-h"><h2>Description</h2></div>
          <div class="card-b">${issue
            ? text ? html`<p class="ticket-text">${text}</p>` : html`<p class="small muted">No description.</p>`
            : live.kind === 'missing'
              ? html`<p class="small muted">The issue was deleted on GitHub.</p>`
              : html`<p class="small muted">Couldn’t load the issue from GitHub right now. Reload to try again, or <a href="${url}" target="_blank" rel="noopener noreferrer">open it on GitHub</a>.</p>`}</div>
          ${issue ? html`<div class="card-note">Shown live from GitHub. It isn’t stored here.</div>` : ''}
        </div></div>

        <div class="a-activity card"><div class="card-h"><h2>Activity</h2></div>
          <div class="card-b">${events.length
            ? html`<ol class="activity">${events.map((e) => {
                const v = eventText(e, names);
                return html`<li>${v.by ? avatar(v.by, 24) : html`<span class="marker">${icon('bot', 14, 'muted')}</span>`}<div>${v.text}</div><time class="when" datetime="${e.at.toISOString()}" title="${formatDate(e.at)}">${timeAgo(e.at)}</time></li>`;
              })}</ol>`
            : html`<p class="small muted">Nothing yet.</p>`}</div>
        </div>

        <div class="a-details a-col"><aside class="card"><div class="card-h"><h2>Details</h2></div>
          <dl class="props">
            <dt>Repository</dt><dd><a class="mono" href="https://github.com/${repo.owner}/${repo.name}" target="_blank" rel="noopener noreferrer">${repo.owner}/${repo.name}</a></dd>
            <dt>App</dt><dd>${repo.apps.join(', ')}</dd>
            ${issue?.labels.length ? html`<dt>Labels</dt><dd>${issue.labels.map((l) => labelTag(l))}</dd>` : ''}
            ${issue ? html`<dt>Opened</dt><dd>${when(issue.createdAt)}</dd>` : ''}
          </dl></aside>
          ${t ? triageCard(t, { repo_owner: repo.owner, repo_name: repo.name }, { act: can(ctx.membership, 'tickets.act'), csrf: ctx.csrf, actionBase }) : html`<div class="card"><div class="card-h"><div class="title">${icon('bot', 16)}<h2>Triage</h2></div></div><div class="card-b tight"><p class="small muted">Not triaged. Issues opened on GitHub are triaged when they’re opened while triage for them is on, or by a re-run.</p></div></div>`}
        </div>
      </div>`;
    return web.render(reply, ctx, issue?.title ?? `Issue #${number}`, 'tickets', body);
  });

  for (const verb of ['apply', 'dismiss'] as const) {
    app.post(`/w/:wid/tickets/issues/:repoId/:number/triage/${verb}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
      if (!ctx) return reply;
      const p = req.params as { repoId: string; number: string };
      const repoId = Number(p.repoId);
      const number = Number(p.number);
      const kind = String((req.body as { kind?: string }).kind ?? '');
      try {
        if (!(await repoOf(ctx.workspace.id, repoId))) throw new UserFacingError('That issue isn’t in this workspace’s repositories.', 404);
        const action = verb === 'apply'
          ? await web.triage.applyIssueSuggestion(ctx.workspace.id, repoId, number, kind, ctx.user.id)
          : await web.triage.dismissIssueSuggestion(ctx.workspace.id, repoId, number, kind, ctx.user.id);
        setFlash(reply, 'success', verb === 'apply' ? `Applied on GitHub${action.close ? ' and closed the issue' : ''}` : 'Suggestion dismissed');
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        setFlash(reply, 'error', err.message);
      }
      return reply.redirect(`${ctx.base}/tickets/issues/${repoId}/${number}`);
    });
  }
}

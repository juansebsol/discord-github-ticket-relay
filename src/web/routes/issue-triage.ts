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
import type { IssueTriageRow } from '../../triage/engine.js';
import { getTriageSettings, parseTriageConfig } from '../../triage/settings.js';
import { TRIAGE_STATES, triageFilter, triageFilterGroups } from '../../triage/state.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { avatar, empty, formatDate, icon, labelTag, linkBtn, notice, pageHeader, pill, segLinks, selectWrap, timeAgo, when } from '../ui.js';
import { ticketsHeader, triageCard, triageCell } from './tickets.js';

const PAGE = 50;
const LIVE_TIMEOUT_MS = 5000;

type Show = 'review' | 'applied' | 'reviewed' | 'nothing' | 'queued' | 'skipped' | 'all';
const SHOWS: { key: Show; label: string; where: string }[] = [
  ...(['review', 'applied', 'reviewed', 'nothing', 'queued'] as const).map((k) => ({ key: k, label: TRIAGE_STATES[k].label, where: triageFilter(`s:${k}`, parseTriageConfig({}))!.where(() => '') })),
  { key: 'skipped', label: 'Skipped or failed', where: `t.status IN ('skipped', 'failed')` },
  { key: 'all', label: 'All', where: '1' },
];

type Row = IssueTriageRow & { title: string | null; html_url: string | null; issue_state: string | null; opened_at: Date | null; owner: string | null; name: string | null };

/** "All issues" and "Triage" inside the Issues tab. */
export function issuesNav(ctx: WorkspaceRequestContext, current: 'all' | 'triage', toReview?: number): SafeHtml {
  return html`<div class="subnav">${segLinks('Issues', [
    { href: `${ctx.base}/tickets/issues`, label: 'All issues', current: current === 'all' },
    { href: `${ctx.base}/tickets/issues/triage`, label: 'Opened on GitHub · Triage', count: toReview || undefined, current: current === 'triage' },
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
    const q = req.query as { show?: string; page?: string; f?: string };
    const show = SHOWS.find((x) => x.key === q.show) ?? SHOWS[0]!;
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    const settings = await getTriageSettings(deps.db, wid);
    // More filters: priority, what triage flagged, labels (status is the tabs above).
    const extra = q.f && !q.f.startsWith('s:') ? triageFilter(q.f, settings.config) : null;
    const { rows: counts } = await deps.db.query<Record<string, number>>(
      `SELECT ${SHOWS.map((x) => `sum(${x.where.replace(/\bt\./g, '')}) AS "${x.key}"`).join(', ')} FROM issue_triage WHERE workspace_id = $1`,
      [wid],
    );
    const count = (k: Show) => Number(counts[0]?.[k] ?? 0);
    const params: unknown[] = [wid, PAGE + 1, (page - 1) * PAGE];
    const bind = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const extraSql = extra ? ` AND ${extra.where(bind)}` : '';
    const { rows } = await deps.db.query<Row>(
      `SELECT t.*, x.title, x.html_url, x.state AS issue_state, x.created_at AS opened_at, COALESCE(ir.owner, a.repo_owner) AS owner, COALESCE(ir.name, a.repo_name) AS name
       FROM issue_triage t
       LEFT JOIN issue_index x ON x.repo_id = t.repo_id AND x.number = t.number
       LEFT JOIN issue_index_repos ir ON ir.repo_id = t.repo_id
       LEFT JOIN (SELECT repo_id, min(repo_owner) AS repo_owner, min(repo_name) AS repo_name FROM apps WHERE workspace_id = $1 GROUP BY repo_id) a ON a.repo_id = t.repo_id
       WHERE t.workspace_id = $1 AND ${show.where}${extraSql} ORDER BY COALESCE(x.created_at, t.created_at) DESC LIMIT $2 OFFSET $3`,
      params,
    );
    const hasMore = rows.length > PAGE;
    const link = (o: { show?: Show; page?: number }) => {
      const p = new URLSearchParams();
      const s = o.show ?? show.key;
      if (s !== 'review') p.set('show', s);
      if (extra) p.set('f', extra.value);
      if (o.page && o.page > 1) p.set('page', String(o.page));
      const qs = p.toString();
      return `${b}/tickets/issues/triage${qs ? `?${qs}` : ''}`;
    };
    const list = rows.slice(0, PAGE).map((r) => html`<li class="issue-row">
        <span class="issue-ic">${icon(r.issue_state === 'closed' ? 'circle-check' : 'circle-dot', 16, r.issue_state === 'closed' ? 'muted' : 'ok')}</span>
        <div class="grow">
          <div class="issue-t"><a href="${b}/tickets/issues/${String(r.repo_id)}/${String(r.number)}">${r.title ?? `Issue #${r.number}`}</a> <span class="muted nowrap">#${String(r.number)}</span></div>
          <div class="sub">${[r.owner && r.name ? `${r.owner}/${r.name}` : null, r.opened_at ? `opened ${timeAgo(r.opened_at)}` : null, r.status === 'skipped' ? r.skip_reason : r.status === 'failed' ? r.error : null].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="issue-meta">${triageCell(r)}</div>
      </li>`);
    const body = html`
      ${await ticketsHeader(web, ctx, 'issues')}
      ${issuesNav(ctx, 'triage', count('review'))}
      <div class="stack">
        ${!settings.githubEnabled ? notice('info', 'Triage of issues opened on GitHub is off', can(ctx.membership, 'manage') ? html`Turn it on in <a href="${b}/tickets/triage">Triage › Actions</a>, or use <a href="${b}/tickets/triage/runs">Re-run</a> for issues already open.` : 'An admin can turn it on in Triage.') : ''}
        <div class="card">
          <div class="card-h"><div><h2>Issues opened on GitHub</h2><div class="desc">Issues people opened directly on GitHub (not through Discord) that triage looked at. Open one to see what triage suggests and what applying it does.</div></div></div>
          <div class="toolbar">${segLinks('Show', SHOWS.map((x) => ({ href: link({ show: x.key, page: 1 }), label: x.label, count: count(x.key), current: x.key === show.key })))}
            <form method="get" action="${b}/tickets/issues/triage" class="tools">${show.key !== 'review' ? html`<input type="hidden" name="show" value="${show.key}">` : ''}
              ${selectWrap(html`<select name="f" aria-label="More filters" data-autosubmit><option value="">All priorities and flags</option>${triageFilterGroups(settings.config).filter((g) => g.label !== 'Triage status').map((g) => html`<optgroup label="${g.label}">${g.options.map((o) => html`<option value="${o.value}" ${o.value === extra?.value ? raw('selected') : ''}>${o.label}</option>`)}</optgroup>`)}</select>`, { sm: true })}
              <button type="submit" class="btn sm nojs">Show</button></form></div>
          <div class="card-b flush">${list.length
            ? html`<ul class="list issues">${list}</ul>`
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

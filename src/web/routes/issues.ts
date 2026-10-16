/**
 * GitHub issues › All issues and › Sync: search every issue in the connected repositories (a
 * copy kept in sync in the background), and how up to date each repository's copy is.
 */
import type { FastifyInstance } from 'fastify';
import {
  consoleQuery,
  ensureRepos,
  ftsQuery,
  indexStatus,
  IssueIndexer,
  recentIssues,
  requestSync,
  searchIndex,
  type IndexedIssue,
  type RepoStatus,
  type SearchHit,
} from '../../domain/issue-index.js';
import { listApps } from '../../domain/store.js';
import { escapeHtml, html, raw, type SafeHtml } from '../../lib/html.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { empty, icon, linkBtn, pill, plural, segLinks, selectWrap, tag, when } from '../ui.js';
import { triageCell, type TriageSummary } from './tickets.js';
import { issueTable } from './issue-triage.js';
import { areaHref, landOn, toolHeader } from './tool.js';
import { workspacePath } from './triage-bulk.js';
import { triageSummaries } from '../../triage/engine.js';

const PAGE_SIZE = 50;

type StateFilter = 'open' | 'closed' | 'all';

/** FTS snippet markers (\u0001 … \u0002) become <mark> after escaping everything else. */
function snippetHtml(s: string | null): SafeHtml | string {
  if (!s) return '';
  return raw(escapeHtml(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'));
}

function repoState(r: RepoStatus): SafeHtml {
  if (r.status === 'loading') {
    const pct = r.newest_number ? Math.min(99, Math.floor((r.indexed / Math.max(1, r.newest_number)) * 100)) : 0;
    return html`${pill(`Loading · ${String(pct)}%`, 'neutral')}`;
  }
  if (r.status === 'error') return pill('Sync problem', 'warn');
  return pill('Up to date', 'ok');
}

export function registerIssueRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  async function workspaceRepos(wid: string) {
    const apps = await listApps(deps.db, wid);
    const byRepo = new Map<number, { owner: string; name: string; apps: string[] }>();
    for (const a of apps) {
      const r = byRepo.get(a.repo_id) ?? { owner: a.repo_owner, name: a.repo_name, apps: [] };
      r.apps.push(a.name);
      byRepo.set(a.repo_id, r);
    }
    return byRepo;
  }

  // ---- All issues ------------------------------------------------------------------------------

  app.get('/w/:wid/issues', async (req, reply) => {
    const ctx = await landOn(web, req, reply, 'issues');
    if (!ctx) return reply;
    const b = ctx.base;
    const wid = ctx.workspace.id;
    const q = req.query as { q?: string; state?: string; repo?: string; page?: string };
    const repos = await workspaceRepos(wid);
    await ensureRepos(deps.db);
    const status = await indexStatus(deps.db, [...repos.keys()]);
    const repoFilter = repos.has(Number(q.repo)) ? Number(q.repo) : null;
    const repoIds = repoFilter ? [repoFilter] : [...repos.keys()];
    const state: StateFilter = q.state === 'closed' || q.state === 'all' ? q.state : 'open';
    const search = (q.q ?? '').trim().slice(0, 200);
    const page = Math.max(1, Number(q.page) || 1);

    let rows: (IndexedIssue | SearchHit)[] = [];
    let related = false;
    if (repoIds.length) {
      const st = state === 'all' ? undefined : state;
      if (search) {
        const exact = consoleQuery(search);
        rows = exact ? await searchIndex(deps.db, { repoIds, query: exact, limit: PAGE_SIZE, state: st }).catch(() => []) : [];
        if (!rows.length) {
          // No issue has every word: show the closest ones instead.
          const loose = ftsQuery(search);
          rows = loose ? await searchIndex(deps.db, { repoIds, query: loose, limit: PAGE_SIZE, state: st }).catch(() => []) : [];
          related = rows.length > 0;
        }
      } else {
        rows = await recentIssues(deps.db, { repoIds, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE, state: st });
      }
    }
    const hasMore = !search && rows.length > PAGE_SIZE;
    rows = rows.slice(0, PAGE_SIZE);

    // Issues this app filed link to their ticket in the console.
    const { rows: tickets } = await deps.db.query<{ id: string; repo_id: number; issue_number: number; reporter_display_name: string }>(
      `SELECT id, repo_id, issue_number, reporter_display_name FROM submissions WHERE workspace_id = $1 AND issue_number IS NOT NULL
         AND issue_number IN (SELECT value FROM json_each($2))`,
      [wid, JSON.stringify(rows.map((r) => r.number))],
    );
    const ticketOf = new Map(tickets.map((t) => [`${t.repo_id}:${t.issue_number}`, t.id]));
    const reporterOf = new Map(tickets.map((t) => [t.id, t.reporter_display_name]));
    // Triage: a ticket's (from Discord), or an issue opened on GitHub's.
    const ticketTriage = await triageSummaries(deps.db, wid, tickets.map((t) => t.id));
    const { rows: triaged } = await deps.db.query<TriageSummary & { repo_id: number; number: number }>(
      `SELECT repo_id, number, status, priority, is_duplicate, is_spam, is_support, suggestion_count, suggestions, dismissed_count,
         json_array_length(COALESCE(applied_actions, '[]')) AS applied_count
       FROM issue_triage WHERE workspace_id = $1 AND number IN (SELECT value FROM json_each($2))`,
      [wid, JSON.stringify(rows.map((r) => r.number))],
    );
    const issueTriage = new Map(triaged.map((t) => [`${t.repo_id}:${t.number}`, t]));

    const link = (o: { state?: StateFilter; page?: number; q?: string; repo?: number | null }) => {
      const params = new URLSearchParams();
      const s = o.state ?? state;
      if (s !== 'open') params.set('state', s);
      const text = o.q ?? search;
      if (text) params.set('q', text);
      const r = o.repo === undefined ? repoFilter : o.repo;
      if (r) params.set('repo', String(r));
      if (o.page && o.page > 1) params.set('page', String(o.page));
      const qs = params.toString();
      return `${b}/issues${qs ? `?${qs}` : ''}`;
    };

    const totalIndexed = status.reduce((n, r) => n + r.indexed, 0);
    const loading = status.some((r) => r.status === 'loading') || status.length < repos.size;

    const table = issueTable(rows.map((r) => {
      const key = `${r.repo_id}:${r.number}`;
      const ticket = ticketOf.get(key);
      const own = issueTriage.get(key);
      const repo = repos.get(r.repo_id);
      // Only when the description itself matched (the title is already shown).
      const snippet = 'snippet' in r && r.snippet?.includes('\u0001') ? r.snippet : null;
      return {
        repoId: r.repo_id,
        number: r.number,
        title: r.title,
        closed: r.state === 'closed',
        closedReason: r.state_reason,
        url: r.html_url,
        repoName: repo?.name ?? '',
        app: r.app_name ?? repo?.apps.join(', ') ?? null,
        // A Discord ticket's GitHub author is this app's bot: show the member instead.
        author: ticket ? reporterOf.get(ticket) ?? r.author : r.author,
        authorAvatar: ticket ? null : r.author_avatar,
        viaDiscord: Boolean(ticket),
        updatedAt: r.updated_at,
        href: ticket ? `${b}/tickets/${ticket}` : own ? `${b}/issues/${String(r.repo_id)}/${String(r.number)}` : r.html_url,
        external: !ticket && !own,
        triage: ticket ? html`${triageCell(ticketTriage.get(ticket), true) || tag('Discord ticket', { icon: 'message-circle' })}` : own ? triageCell(own) : html`<span class="em">—</span>`,
        extra: html`${r.duplicate_of ? html`<div class="sub">Duplicate of <a href="https://github.com/${repo?.owner ?? ''}/${repo?.name ?? ''}/issues/${String(r.duplicate_of)}" target="_blank" rel="noopener noreferrer">#${String(r.duplicate_of)}</a></div>` : ''}${snippet ? html`<p class="issue-snip">${snippetHtml(snippet)}</p>` : ''}`,
      };
    }));

    const body = html`
      ${await toolHeader(web, ctx, 'issues', 'issues')}
      <div class="card">
        <div class="toolbar">
          ${segLinks('Filter by state', [
            { href: link({ state: 'open', page: 1 }), label: 'Open', current: state === 'open' },
            { href: link({ state: 'closed', page: 1 }), label: 'Closed', current: state === 'closed' },
            { href: link({ state: 'all', page: 1 }), label: 'All', current: state === 'all' },
          ])}
          <form method="get" action="${b}/issues" class="tools" role="search">
            ${state !== 'open' ? html`<input type="hidden" name="state" value="${state}">` : ''}
            <span class="search sm">${icon('search', 14)}<input type="search" name="q" value="${search}" placeholder="Search ${plural(totalIndexed, 'issue')}" aria-label="Search issues"></span>
            ${repos.size > 1 ? selectWrap(html`<select name="repo" aria-label="Repository" data-autosubmit><option value="">All repositories</option>${[...repos.entries()].map(([id, r]) => html`<option value="${String(id)}" ${id === repoFilter ? raw('selected') : ''}>${r.owner}/${r.name}</option>`)}</select>`, { sm: true }) : ''}
            <button type="submit" class="btn sm">Search</button>
          </form>
        </div>
        ${related ? html`<div class="notice flat info">${icon('info')}<div><div class="n-text">No issue has all of those words. Showing the closest matches.</div></div><span></span></div>` : ''}
        <div class="card-b flush">${rows.length
          ? table
          : search
            ? empty('search-x', 'No matching issues', 'Try fewer or different words, or another state.', linkBtn(link({ q: '', page: 1 }), 'Clear search'))
            : empty('inbox', totalIndexed ? 'No issues here' : 'No issues yet', totalIndexed ? 'Nothing matches this filter.' : !repos.size ? 'Add an app first: its repository’s issues are copied here.' : loading ? 'The first load is running. Issues appear here as they’re copied.' : 'Issues from your repositories appear here once they’re copied.')}</div>
        ${loading && repos.size && totalIndexed ? html`<div class="card-note">The first load is still running, so some older issues aren’t here yet.</div>` : ''}
        ${!search && (page > 1 || hasMore) ? html`<div class="pager"><span>Page ${String(page)}</span><div class="row">
          ${page > 1 ? linkBtn(link({ page: page - 1 }), 'Previous', { size: 'sm', icon: 'chevron-left' }) : ''}${hasMore ? linkBtn(link({ page: page + 1 }), 'Next', { size: 'sm', trail: 'chevron-right' }) : ''}</div></div>` : ''}
        ${search ? html`<div class="card-note">${rows.length ? `Best matches first${rows.length === PAGE_SIZE ? `, top ${PAGE_SIZE}` : ''}. Titles count more than descriptions; “crash” also finds “crashes”.` : ''}</div>` : ''}
      </div>`;
    return web.render(reply, ctx, 'GitHub issues', 'issues', body, { width: 'full' });
  });

  // ---- Sync ----------------------------------------------------------------------------------

  app.get('/w/:wid/issues/sync', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'issues-sync.view' });
    if (!ctx) return reply;
    const repos = await workspaceRepos(ctx.workspace.id);
    await ensureRepos(deps.db);
    const status = await indexStatus(deps.db, [...repos.keys()]);
    const loading = status.some((r) => r.status === 'loading') || status.length < repos.size;
    const statusCard = html`<div class="card">
      <div class="card-h"><div><h2>Issue database</h2><div class="desc">A copy of every issue in your repositories, open and closed, kept in sync every couple of minutes. Search and triage use it.</div></div></div>
      ${repos.size
        ? html`<div class="card-b flush"><div class="table-wrap"><table>
            <thead><tr><th class="col-main">Repository</th><th>Status</th><th class="num">Issues</th><th class="num">Open</th><th class="num">Last sync</th></tr></thead>
            <tbody>${[...repos.entries()].map(([id, r]) => {
              const st = status.find((x) => x.repo_id === id);
              return html`<tr>
                <td><div class="who-cell">${icon('folder-git-2', 16, 'muted')}<div><a class="cell-title mono" href="https://github.com/${r.owner}/${r.name}/issues" target="_blank" rel="noopener noreferrer">${r.owner}/${r.name}</a><div class="sub">${r.apps.join(', ')}</div></div></div></td>
                <td>${st ? repoState(st) : pill('Starting', 'neutral')}${st?.last_error ? html`<div class="sub">${st.last_error}</div>` : st?.status === 'loading' ? html`<div class="sub">${plural(st.indexed, 'issue')} copied so far</div>` : ''}</td>
                <td class="num">${String(st?.indexed ?? 0)}</td>
                <td class="num">${String(st?.open ?? 0)}</td>
                <td class="num">${st?.last_synced_at ? when(st.last_synced_at) : html`<span class="em">—</span>`}</td></tr>`;
            })}</tbody></table></div></div>
          ${loading ? html`<div class="card-note">The first load runs in the background, oldest issues first. Search and triage use what’s loaded so far, and triage also checks GitHub directly until it’s done.</div>` : ''}`
        : empty('folder-git-2', 'No repositories yet', 'Add an app first: its repository’s issues are copied here.')}
    </div>`;

    const body = html`
      ${await toolHeader(web, ctx, 'issues', 'issues-sync')}
      ${statusCard}`;
    return web.render(reply, ctx, 'Sync · GitHub issues', 'issues', body, { width: 'full' });
  });

  /** Back to the GitHub issues page Sync now was pressed on. */
  const backTo = (ctx: WorkspaceRequestContext, back: unknown) => workspacePath(ctx, back, ['/issues']) ?? areaHref(ctx, 'issues-sync');

  /** Sync now: picks up the latest changes; a first load that's still running continues in the background. */
  app.post('/w/:wid/issues/sync', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'issues-sync.edit' });
    if (!ctx) return reply;
    await ensureRepos(deps.db);
    const repos = [...(await workspaceRepos(ctx.workspace.id)).keys()];
    const indexer = new IssueIndexer(deps);
    const before = await indexStatus(deps.db, repos);
    let problem = false;
    for (const r of before) {
      if (r.status === 'loading') continue;
      const after = await indexer.sync(r.repo_id, { pages: 3, fullCheck: false });
      if (after?.status === 'error') problem = true;
    }
    await requestSync(deps.db, before.filter((r) => r.status === 'loading').map((r) => r.repo_id));
    const loadingLeft = before.some((r) => r.status === 'loading');
    setFlash(reply, problem ? 'error' : 'success', problem
      ? 'Some repositories couldn’t be synced. See their status on the Sync tab.'
      : loadingLeft ? 'Synced. The first load continues in the background.' : 'Up to date with GitHub.');
    return reply.redirect(backTo(ctx, (req.body as { back?: unknown }).back));
  });
}


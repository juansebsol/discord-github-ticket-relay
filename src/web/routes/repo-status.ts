/**
 * Repo status: every watched repository at a glance (open PRs and issues, what landed lately,
 * builds and their downloads), and Fix first: the open issues that most need fixing, across the
 * repositories, with the reasons behind each score. Read in the background (repo-status/tracker).
 */
import type { FastifyInstance } from 'fastify';
import { can } from '../../domain/permissions.js';
import { getInstallationRepos } from '../../domain/repos.js';
import { getGitHubConnection } from '../../domain/store.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { DEFAULT_PERIOD, mostReported, PERIODS, periodOf, periodStart, type PeriodId, type Reported } from '../../repo-status/reports.js';
import { fixesFor, listPulls, type IssueFix, type PullItem, type PullLists } from '../../repo-status/pulls.js';
import type { UrgentIssue } from '../../repo-status/score.js';
import {
  ALL_TIME,
  DEFAULT_WINDOW,
  EVERY_MINUTES,
  getStatusSettings,
  requestRefresh,
  saveStatusSettings,
  SINCE_BUILD,
  statusIcon,
  statusRepos,
  statusRows,
  WINDOWS,
  type Activity,
  type RepoRef,
  type RepoStats,
  type StatusRow,
} from '../../repo-status/tracker.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { avatar, csrfField, empty, formatDate, icon, linkBtn, localTime, notice, pageHeader, pill, plural, postBtn, segLinks, selectWrap, setting, submitBtn, switchInput, tag, timeAgo } from '../ui.js';
import { viewOnlyTag } from '../ui.js';

const n = (x: number) => x.toLocaleString('en-US');

/** "now", "5m", "4h", "3d": how long ago, as short as the table needs. */
function short(at: string | Date | null | undefined, now = Date.now()): string {
  if (!at) return '—';
  const ms = now - new Date(at).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** The windows the activity group offers (since the latest build and all time last). */
const WINDOW_OPTIONS: { id: string; label: string }[] = [...WINDOWS.map((w) => ({ id: w.id as string, label: w.label })), { id: SINCE_BUILD, label: 'Since last build' }, { id: ALL_TIME, label: 'All time' }];

type Freshness = 'off' | 'reading' | 'fresh' | 'stale';

interface Row {
  repo: RepoRef;
  row: StatusRow | undefined;
  stats: RepoStats | null;
  stale: boolean;
}

export function registerRepoStatusRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const base = (ctx: WorkspaceRequestContext) => `${ctx.base}/repos`;

  /** The workspace's repositories with what was last read for each, and how fresh it is. */
  async function load(ctx: WorkspaceRequestContext) {
    const s = await getStatusSettings(deps.db, ctx.workspace.id);
    const repos = await statusRepos(deps.db, ctx.workspace.id, s);
    const known = await statusRows(deps.db, repos.map((r) => r.id));
    const staleMs = Math.max(2 * s.everyMinutes, 15) * 60_000;
    const now = Date.now();
    const rows: Row[] = repos.map((repo) => {
      const row = known.get(repo.id);
      return { repo, row, stats: row?.stats ?? null, stale: !row?.fetched_at || now - row.fetched_at.getTime() > staleMs };
    });
    const read = rows.filter((r) => r.row?.fetched_at);
    const oldest = read.length ? new Date(Math.min(...read.map((r) => r.row!.fetched_at!.getTime()))) : null;
    const reading = rows.some((r) => r.row?.lease_until_at && r.row.lease_until_at.getTime() > now);
    const freshness: Freshness = !s.enabled ? 'off' : !read.length || reading ? 'reading' : rows.some((r) => r.stale) ? 'stale' : 'fresh';
    const budget = rows.map((r) => r.row).filter((r): r is StatusRow => Boolean(r?.budget !== null && r?.fetched_at)).sort((a, b) => b.fetched_at!.getTime() - a.fetched_at!.getTime())[0];
    // The next read: the stalest repository comes due an interval after its last read.
    const next = s.enabled && oldest ? new Date(Math.max(now, oldest.getTime() + s.everyMinutes * 60_000)) : null;
    return { s, rows, oldest, freshness, budget: budget?.budget ?? null, next };
  }

  const freshPill = (f: Freshness) => f === 'fresh' ? pill('Fresh', 'ok') : f === 'stale' ? pill('Stale', 'warn') : f === 'reading' ? pill('Reading…', 'neutral') : pill('Off', 'neutral');

  /** The Repos table: one row per repository, sortable, with the activity window picked in its header. */
  function table(ctx: WorkspaceRequestContext, rows: Row[]): SafeHtml {
    const now = Date.now();
    const maxUrgency = Math.max(1, ...rows.map((r) => r.stats?.urgency ?? 0));
    const gh = (r: RepoRef) => `https://github.com/${r.owner}/${r.name}`;
    // Each window's start, for the links to GitHub's lists (app.js keeps them in step with the window).
    const starts: Record<string, string> = Object.fromEntries(WINDOWS.map((w) => [w.id, new Date(now - w.minutes * 60_000).toISOString().slice(0, 19) + 'Z']));
    const act = (st: RepoStats | null) => Object.fromEntries(WINDOW_OPTIONS.map((w) => {
      const a: Activity | null | undefined = st?.activity[w.id];
      return [w.id, a ? [a.commits, a.prs, a.merged, a.issues, a.people] : null];
    }));
    /** A count: muted when there's none, linked to GitHub's list when there is. `k` marks an activity cell app.js refills. */
    const cell = (v: number | null | undefined, href?: string, o: { k?: number; first?: boolean } = {}) => {
      const cls = ['num', o.first ? 'rs-l' : '', v === null || v === undefined ? 'muted' : v === 0 ? 'zero' : ''].filter(Boolean).join(' ');
      const k = o.k === undefined ? '' : raw(` data-k="${o.k}"`);
      const inner = v === null || v === undefined ? '—' : v > 0 && href ? html`<a class="rs-n" href="${href}" target="_blank" rel="noopener noreferrer">${n(v)}</a>` : n(v);
      return html`<td class="${cls}"${k}>${inner}</td>`;
    };
    const since = starts[DEFAULT_WINDOW]!;
    const time = (at: string | Date | null | undefined) => (at ? new Date(at).getTime() : undefined);
    /** GitHub's list of what a window's activity counts (app.js builds the same links when the window changes). */
    const actLink = (repo: RepoRef, st: RepoStats, k: number, from: string) => [
      `${gh(repo)}/commits/${st.defaultBranch ?? 'main'}?since=${from}`,
      `${gh(repo)}/pulls?q=${encodeURIComponent(`is:pr created:>=${from}`)}`,
      `${gh(repo)}/pulls?q=${encodeURIComponent(`is:pr is:merged merged:>=${from}`)}`,
      `${gh(repo)}/issues?q=${encodeURIComponent(`is:issue created:>=${from}`)}`,
    ][k];
    // Most urgent first (the page opens sorted by Urgency); repositories not read yet go last.
    rows = [...rows].sort((x, y) => (y.stats?.urgency ?? -1) - (x.stats?.urgency ?? -1) || x.repo.name.localeCompare(y.repo.name));
    const totals = { urgency: 0, critical: 0, prs: 0, issues: 0, unreleased: 0, downloads: 0, total: 0 };
    const body = rows.map(({ repo, row, stats: st, stale }) => {
      const a = st?.activity[DEFAULT_WINDOW] ?? null;
      const b = st?.build ?? null;
      if (st) {
        totals.urgency += st.urgency;
        totals.critical += st.critical;
        totals.prs += st.openPrs;
        totals.issues += st.openIssues;
        totals.unreleased += b?.unreleased ?? 0;
        totals.downloads += b?.downloads ?? 0;
        totals.total += b?.totalDownloads ?? 0;
      }
      const level = st?.urgency ? Math.min(4, Math.ceil((st.urgency / maxUrgency) * 4)) : 0;
      const dot = row?.error ? html`<span class="rs-dot failed" title="${row.error}"></span>` : !st ? html`<span class="rs-dot" title="Not read yet"></span>` : stale ? html`<span class="rs-dot stale" title="${`Last read ${timeAgo(row!.fetched_at!)}`}"></span>` : html`<span class="rs-dot ok" title="${`Read ${timeAgo(row!.fetched_at!)}`}"></span>`;
      const sortVals = {
        name: repo.name.toLowerCase(), urgency: st?.urgency, critical: st?.critical, prs: st?.openPrs, issues: st?.openIssues,
        oldest: time(st?.oldestOpenPrAt), commit: time(st?.lastCommitAt), issue: time(st?.lastIssueAt), pr: time(st?.newestPrAt),
        build: b?.tag.toLowerCase(), built: time(b?.at), unreleased: b?.unreleased ?? undefined, dls: b?.downloads, total: b?.totalDownloads,
      };
      return html`<tr data-repo="${String(repo.id)}" data-sort='${JSON.stringify(sortVals)}' data-act='${JSON.stringify(act(st))}' data-gh="${gh(repo)}" data-branch="${st?.defaultBranch ?? 'main'}" data-built="${b?.at ? new Date(b.at).toISOString().slice(0, 19) + 'Z' : ''}" class="${stale && st ? 'is-stale' : ''}">
        <th scope="row" class="rs-repo">${dot}${row?.has_icon ? html`<img class="rs-icon" src="${base(ctx)}/icon/${String(repo.id)}" alt="" width="20" height="20" loading="lazy">` : avatar(repo.name, 20, { square: true })}<a href="${gh(repo)}" target="_blank" rel="noopener noreferrer">${repo.name}</a></th>
        ${st ? html`<td class="num rs-urg"><a class="rs-score u${String(level)}" href="${base(ctx)}?view=fix&amp;repo=${encodeURIComponent(repo.name)}" title="The sum of its top five open-issue scores. Open them in Fix first.">${n(st.urgency)}</a></td>
          <td class="num rs-crit${st.critical ? ' has' : ''}">${n(st.critical)}</td>
          ${cell(st.openPrs, `${gh(repo)}/pulls`)}${cell(st.openIssues, `${gh(repo)}/issues`)}
          <td class="num" title="${st.oldestOpenPrAt ? formatDate(new Date(st.oldestOpenPrAt)) : ''}">${short(st.oldestOpenPrAt, now)}</td>
          <td class="num rs-l" title="${st.lastCommitAt ? formatDate(new Date(st.lastCommitAt)) : ''}">${short(st.lastCommitAt, now)}</td>
          <td class="num" title="${st.lastIssueAt ? formatDate(new Date(st.lastIssueAt)) : ''}">${short(st.lastIssueAt, now)}</td>
          <td class="num" title="${st.newestPrAt ? formatDate(new Date(st.newestPrAt)) : ''}">${short(st.newestPrAt, now)}</td>
          ${cell(a?.commits, actLink(repo, st, 0, since), { k: 0, first: true })}${cell(a?.prs, actLink(repo, st, 1, since), { k: 1 })}${cell(a?.merged, actLink(repo, st, 2, since), { k: 2 })}${cell(a?.issues, actLink(repo, st, 3, since), { k: 3 })}${cell(a?.people, undefined, { k: 4 })}
          ${b
            ? html`<td class="rs-l rs-build"><a href="${b.url}" target="_blank" rel="noopener noreferrer">${b.tag}</a>${b.prerelease ? html` <span class="rs-pre">PRE</span>` : ''}</td>
              <td class="num" title="${b.at ? formatDate(new Date(b.at)) : ''}">${short(b.at, now)}</td>
              <td class="num">${b.unreleased === null ? '—' : b.compareUrl && b.unreleased ? html`<a class="rs-n" href="${b.compareUrl}" target="_blank" rel="noopener noreferrer" title="${b.estimate ? 'An estimate: the build’s tag isn’t on the default branch' : `Commits on ${st.defaultBranch ?? 'main'} since ${b.tag}`}">${b.estimate ? '~' : ''}${n(b.unreleased)}</a>` : n(b.unreleased)}</td>
              <td class="num">${n(b.downloads)}</td><td class="num">${n(b.totalDownloads)}</td>`
            : html`<td class="rs-l muted">—</td><td class="num muted">—</td><td class="num muted">—</td><td class="num muted">0</td><td class="num muted">0</td>`}`
          : html`<td class="rs-wait" colspan="18">${row?.error ? html`<span class="rs-err-text">${row.error}</span>` : 'Not read yet. The first read takes a minute or two.'}</td>`}
      </tr>`;
    });
    const t = (rowsSum: (a: Activity) => number) => rows.reduce((s, r) => s + (r.stats?.activity[DEFAULT_WINDOW] ? rowsSum(r.stats.activity[DEFAULT_WINDOW]!) : 0), 0);
    const col = (key: string, label: string, o: { title?: string; first?: boolean; group?: string } = {}) =>
      html`<th scope="col" class="${['num', o.first ? 'rs-l' : ''].filter(Boolean).join(' ')}" aria-sort="${key === 'urgency' ? 'descending' : 'none'}" ${o.title ? html`title="${o.title}"` : ''}><button type="button" data-sort-key="${key}">${label}${icon('arrow-down', 12, 'rs-arrow')}</button></th>`;
    return html`<div class="rs-scroll"><table class="rs-table" data-rs-table data-starts='${JSON.stringify(starts)}'>
      <thead>
        <tr class="rs-groups">
          <th class="rs-repo"></th>
          <th colspan="2" class="rs-l">Fix first</th>
          <th colspan="3" class="rs-l">Open</th>
          <th colspan="3" class="rs-l">Latest</th>
          <th colspan="5" class="rs-l rs-window"><label class="sr-only" for="rs-window">Activity window</label><span class="rs-window-pick">${selectWrap(html`<select id="rs-window" data-rs-window>${WINDOW_OPTIONS.map((w) => html`<option value="${w.id}" ${w.id === DEFAULT_WINDOW ? raw('selected') : ''}>${w.label}</option>`)}</select>`, { sm: true })}</span></th>
          <th colspan="5" class="rs-l">Builds</th>
        </tr>
        <tr class="rs-cols">
          <th scope="col" class="rs-repo" aria-sort="none"><button type="button" data-sort-key="name">Repo${icon('arrow-down', 12, 'rs-arrow')}</button></th>
          ${col('urgency', 'Urgency', { first: true, title: 'The sum of the top five open-issue scores' })}${col('critical', 'Critical', { title: 'Open issues naming a crash, hang, freeze, data loss, launch failure or security problem' })}
          ${col('prs', 'PRs', { first: true })}${col('issues', 'Issues')}${col('oldest', 'Oldest PR')}
          ${col('commit', 'Commit', { first: true, title: 'The last commit to the default branch' })}${col('issue', 'Issue', { title: 'The newest issue' })}${col('pr', 'PR', { title: 'The newest pull request' })}
          ${col('a0', 'Commits', { first: true, title: 'Commits to the default branch' })}${col('a1', 'PRs', { title: 'Pull requests opened' })}${col('a2', 'Merged')}${col('a3', 'Issues', { title: 'Issues opened' })}${col('a4', 'People', { title: 'People committing to the default branch' })}
          ${col('build', 'Build', { first: true })}${col('built', 'Built')}${col('unreleased', 'Unreleased', { title: 'Commits on the default branch since the build' })}${col('dls', 'Build DLs', { title: 'Downloads of the latest build (checksums and updater files left out)' })}${col('total', 'Total DLs', { title: 'Downloads across every release' })}
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <th scope="row" class="rs-repo">${plural(rows.length, 'repo')}</th>
        <td class="num rs-l">${n(totals.urgency)}</td><td class="num">${n(totals.critical)}</td>
        <td class="num rs-l">${n(totals.prs)}</td><td class="num">${n(totals.issues)}</td><td></td>
        <td class="rs-l"></td><td></td><td></td>
        <td class="num rs-l" data-t="0">${n(t((x) => x.commits))}</td><td class="num" data-t="1">${n(t((x) => x.prs))}</td><td class="num" data-t="2">${n(t((x) => x.merged))}</td><td class="num" data-t="3">${n(t((x) => x.issues))}</td><td class="num" data-t="4">${n(t((x) => x.people ?? 0))}</td>
        <td class="rs-l"></td><td></td><td class="num">${n(totals.unreleased)}</td><td class="num">${n(totals.downloads)}</td><td class="num">${n(totals.total)}</td>
      </tr></tfoot>
    </table></div>`;
  }

  /** Fix first: open issues across the repositories, best score first, with why. */
  function fixFirst(ctx: WorkspaceRequestContext, rows: Row[], only: string | null, fixes: Map<string, IssueFix>): SafeHtml {
    const all = rows.flatMap((r) => (r.stats?.urgent ?? []).map((u) => ({ u, repo: r.repo })));
    const list = all.filter((x) => !only || x.repo.name === only).sort((a, b) => b.u.score - a.u.score || (b.u.createdAt ?? '').localeCompare(a.u.createdAt ?? '')).slice(0, 150);
    const filters = [{ href: `${base(ctx)}?view=fix`, label: 'All', count: all.length, current: !only },
      ...rows.filter((r) => r.stats?.urgent.length).sort((a, b) => b.stats!.urgency - a.stats!.urgency)
        .map((r) => ({ href: `${base(ctx)}?view=fix&repo=${encodeURIComponent(r.repo.name)}`, label: r.repo.name, count: r.stats!.urgent.length, current: only === r.repo.name }))];
    const item = ({ u, repo }: { u: UrgentIssue; repo: RepoRef }) => html`<li class="rs-fx${u.critical ? ' critical' : ''}">
      <span class="rs-score u${String(u.score >= 80 ? 4 : u.score >= 50 ? 3 : u.score >= 25 ? 2 : 1)}" title="Its score: why is under the title">${n(u.score)}</span>
      <div class="rs-fx-b">
        <a class="rs-fx-t" href="${u.url}" target="_blank" rel="noopener noreferrer">${u.critical ? icon('flame', 14, 'rs-flame') : ''}${u.title}</a>
        <div class="rs-fx-m"><span class="mono">${repo.name}#${String(u.number)}</span>${u.createdAt ? html` · opened ${timeAgo(new Date(u.createdAt))}` : ''}${u.labels.length ? html` · ${u.labels.slice(0, 4).join(', ')}` : ''}</div>
        <div class="rs-fx-why">${fixChip(fixes.get(`${repo.id}:${u.number}`))}${u.reasons.map((x) => html`<span class="rs-why">${x}</span>`)}</div>
      </div>
    </li>`;
    return html`<div class="rs-fix">
      <div class="rs-fix-h">${segLinks('Repositories', filters)}</div>
      ${list.length
        ? html`<ol class="rs-fxs">${list.map(item)}</ol>`
        : html`<div class="card">${empty('circle-check', 'Nothing to fix first', only ? `No open issue in ${only} scores above zero.` : 'No open issue scores above zero.')}</div>`}
      <p class="small muted rs-fix-note">Scores: a crash, hang, freeze, data loss, launch failure or security problem +40 · broken +15 · bug label +15 · filed by someone outside the team +10 · reactions and comments up to +40 · names the latest build +10 · opened in the last day +8 (3 days +4) · a request, question or docs −25 · untouched for 30 days −5. Issues labelled wontfix, duplicate or invalid are left out.</p>
    </div>`;
  }

  /** Most reported: the issues Discord tickets are about, most tickets first (reported once, folded away). */
  function mostReportedView(ctx: WorkspaceRequestContext, all: Reported[], only: string | null, period: PeriodId, fixes: Map<string, IssueFix>): SafeHtml {
    const href = (o: { repo?: string | null; period?: PeriodId }) => {
      const p = new URLSearchParams({ view: 'reported' });
      const per = o.period ?? period;
      if (per !== DEFAULT_PERIOD) p.set('period', per);
      const repo = o.repo === undefined ? only : o.repo;
      if (repo) p.set('repo', repo);
      return `${base(ctx)}?${p.toString()}`;
    };
    const shown = all.filter((x) => !only || x.repo.name === only);
    const many = shown.filter((x) => x.reports.length > 1);
    const once = shown.filter((x) => x.reports.length === 1);
    const perRepo = new Map<string, number>();
    for (const x of all) if (x.reports.length > 1) perRepo.set(x.repo.name, (perRepo.get(x.repo.name) ?? 0) + 1);
    const repoFilter = perRepo.size > 1 || only
      ? segLinks('Repositories', [
          { href: href({ repo: null }), label: 'All', count: all.filter((x) => x.reports.length > 1).length, current: !only },
          ...[...perRepo].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ href: href({ repo: name }), label: name, count, current: only === name })),
        ])
      : '';
    const periodFilter = segLinks('Period', PERIODS.map((p) => ({ href: href({ period: p.id }), label: p.label, current: p.id === period })));
    const review = can(ctx.membership, 'triage.review.view');
    const state = (x: Reported) => x.state === 'open' ? pill('Open', 'ok')
      : x.state === 'closed' ? pill(x.stateReason === 'not_planned' ? 'Not planned' : x.stateReason === 'duplicate' ? 'Closed as duplicate' : 'Closed', 'closed') : '';
    const since = periodOf(period).days === null ? 'yet' : `in the last ${periodOf(period).label}`;
    const item = (x: Reported) => html`<li class="rs-fx rs-rp">
      <span class="rs-count" title="${`${plural(x.reports.length, 'Discord ticket')} about it ${since === 'yet' ? 'so far' : since}`}"><b>${n(x.reports.length)}</b>${x.reports.length === 1 ? 'report' : 'reports'}</span>
      <div class="rs-fx-b">
        <div class="rs-rp-h"><a class="rs-fx-t" href="${x.url}" target="_blank" rel="noopener noreferrer">${x.title}</a>${state(x)}</div>
        <div class="rs-fx-m"><span class="mono">${x.repo.name}#${String(x.number)}</span> · ${plural(x.people, 'person', 'people')} · last reported ${timeAgo(x.lastAt)}${x.reports.length > 1 ? html` · first ${timeAgo(x.firstAt)}` : ''}</div>
        ${x.suggested || x.github || x.afterClosed || fixes.has(`${x.repo.id}:${x.number}`) ? html`<div class="rs-fx-why">
          ${fixChip(fixes.get(`${x.repo.id}:${x.number}`))}
          ${x.afterClosed ? html`<span class="rs-why warn" title="Reported again after it was closed as fixed: the fix may not have worked, or not shipped yet">${plural(x.afterClosed, 'report')} since it was closed</span>` : ''}
          ${x.suggested ? (review
            ? html`<a class="rs-why sug" href="${ctx.base}/triage" title="Claude thinks these tickets are about this issue. Apply or dismiss that in AI triage › Review.">${n(x.suggested)} waiting for review</a>`
            : html`<span class="rs-why sug" title="Claude thinks these tickets are about this issue; nobody has reviewed that yet">${n(x.suggested)} waiting for review</span>`) : ''}
          ${x.github ? html`<span class="rs-why" title="Issues opened directly on GitHub about it (not counted in the reports)">${plural(x.github, 'issue')} opened on GitHub</span>` : ''}
        </div>` : ''}
        <details class="rs-rp-d" id="${`rp-${x.repo.id}-${x.number}`}">
          <summary>${x.reports.length === 1 ? 'See the ticket' : `See the ${x.reports.length} tickets`}</summary>
          <ul class="rs-rp-list">${x.reports.slice(0, 50).map((r) => html`<li>
            <a href="${ctx.base}/tickets/${r.id}">${r.title ?? r.ref}</a>
            <span class="muted">${r.reporter} · ${timeAgo(r.at)}</span>
            ${r.suggested ? html`<span class="rs-why sug">Suggested, not reviewed</span>` : r.issue !== x.number ? html`<span class="muted small" title="${`It filed #${r.issue}, a duplicate of #${x.number}`}">via #${String(r.issue)}</span>` : ''}
          </li>`)}</ul>
          ${x.reports.length > 50 ? html`<p class="small muted">And ${n(x.reports.length - 50)} more.</p>` : ''}
        </details>
      </div>
    </li>`;
    return html`<div class="rs-fix">
      <div class="rs-fix-h rs-rp-filters">${repoFilter}${periodFilter}</div>
      ${many.length
        ? html`<ol class="rs-fxs">${many.map(item)}</ol>`
        : html`<div class="card">${empty('message-square', shown.length ? 'No issue was reported more than once' : 'No reports yet', shown.length ? `Nothing was reported by more than one ticket ${since === 'yet' ? 'yet' : since}.` : `No Discord tickets ${since === 'yet' ? 'yet' : since}${only ? ` for ${only}` : ''}. Issues show up here as tickets come in.`)}</div>`}
      ${once.length ? html`<details class="rs-once" id="rs-once"><summary>Reported once <span class="n">${n(once.length)}</span></summary><ol class="rs-fxs">${once.slice(0, 150).map(item)}</ol></details>` : ''}
      <p class="small muted rs-fix-note">A ticket counts for the issue it filed or, when it’s a duplicate (applied by triage or marked on GitHub), for the original. Duplicates Claude suggested that nobody has reviewed yet count too, shown as waiting for review. Spam isn’t counted. Nothing is changed on GitHub.</p>
    </div>`;
  }

  /** Pull requests: open ones (most reported first), merged ones waiting for a release, and merged ones. */
  function pullsView(ctx: WorkspaceRequestContext, lists: PullLists, reportsOf: Map<string, number>, which: 'open' | 'waiting' | 'merged', only: string | null): SafeHtml {
    const href = (o: { which?: string; repo?: string | null }) => {
      const p = new URLSearchParams({ view: 'pulls' });
      const w = o.which ?? which;
      if (w !== 'open') p.set('list', w);
      const repo = o.repo === undefined ? only : o.repo;
      if (repo) p.set('repo', repo);
      return `${base(ctx)}?${p.toString()}`;
    };
    const mine = (list: PullItem[]) => list.filter((x) => !only || x.repo.name === only);
    const reports = (x: PullItem) => x.issues.reduce((s, i) => s + (reportsOf.get(`${x.repo.id}:${i.number}`) ?? 0), 0);
    const shown = mine(lists[which]);
    if (which === 'open') shown.sort((a, b) => reports(b) - reports(a) || b.pull.updated_at.getTime() - a.pull.updated_at.getTime());
    const repoNames = [...new Set([...lists.open, ...lists.waiting, ...lists.merged].map((x) => x.repo.name))];
    const lists_ = segLinks('Pull requests', [
      { href: href({ which: 'open' }), label: 'Open', count: mine(lists.open).length, current: which === 'open' },
      ...(lists.waiting.length || which === 'waiting' ? [{ href: href({ which: 'waiting' }), label: 'Waiting for a release', count: mine(lists.waiting).length, current: which === 'waiting' }] : []),
      { href: href({ which: 'merged' }), label: 'Merged', count: mine(lists.merged).length, current: which === 'merged' },
    ]);
    const repoFilter = repoNames.length > 1 || only
      ? segLinks('Repositories', [{ href: href({ repo: null }), label: 'All', current: !only }, ...repoNames.map((name) => ({ href: href({ repo: name }), label: name, current: only === name }))])
      : '';
    const item = (x: PullItem) => {
      const p = x.pull;
      const r = reports(x);
      const ic = p.state === 'open' ? (p.draft ? 'git-pull-request-draft' : 'git-pull-request') : 'git-merge';
      const when = p.state === 'open'
        ? html`opened ${timeAgo(p.created_at)} · updated ${timeAgo(p.updated_at)}`
        : html`merged ${timeAgo(p.merged_at!)}${x.release ? html` · in <span class="mono">${x.release.tag}</span>` : x.release === null && which === 'waiting' ? ' · not released yet' : ''}`;
      return html`<li class="rs-fx rs-pr">
        <span class="rs-pr-ic ${p.state === 'open' ? (p.draft ? 'draft' : 'open') : 'merged'}" title="${p.state === 'open' ? (p.draft ? 'Draft' : 'Open') : 'Merged'}">${icon(ic, 16)}</span>
        <div class="rs-fx-b">
          <div class="rs-rp-h"><a class="rs-fx-t" href="${p.html_url}" target="_blank" rel="noopener noreferrer">${p.title}</a>${p.draft ? pill('Draft', 'neutral') : ''}${r ? html`<span class="rs-why sug" title="Discord tickets about the issues it’s for, duplicates included">${plural(r, 'Discord report')}</span>` : ''}</div>
          <div class="rs-fx-m"><span class="mono">${x.repo.name}#${String(p.number)}</span>${p.author ? html` · ${p.author}` : ''} · ${when}</div>
          ${x.issues.length ? html`<ul class="rs-pr-for">${x.issues.slice(0, 4).map((i) => {
            const count = reportsOf.get(`${x.repo.id}:${i.number}`) ?? 0;
            return html`<li><span class="muted">${i.closes ? (p.state === 'open' ? 'Fixes' : 'Fixed') : 'For'}</span> <a href="https://github.com/${x.repo.owner}/${x.repo.name}/issues/${String(i.number)}" target="_blank" rel="noopener noreferrer">#${String(i.number)}</a>${i.title ? html` <span class="rs-pr-it">${i.title}</span>` : ''}${count && x.issues.length > 1 ? html` <a class="rs-why" href="${base(ctx)}?view=reported&amp;period=all&amp;repo=${encodeURIComponent(x.repo.name)}" title="Discord tickets about it, all time">${plural(count, 'report')}</a>` : ''}</li>`;
          })}</ul>` : ''}
        </div>
      </li>`;
    };
    const none = which === 'open' ? ['No open pull requests', 'Nothing is waiting for review in these repositories.']
      : which === 'waiting' ? ['Nothing waiting for a release', 'Every merged pull request is in a release.']
        : ['Nothing merged in the last 90 days', 'Merged pull requests show up here for 90 days.'];
    return html`<div class="rs-fix">
      <div class="rs-fix-h rs-rp-filters">${lists_}${repoFilter}</div>
      ${shown.length ? html`<ol class="rs-fxs">${shown.slice(0, 200).map(item)}</ol>` : html`<div class="card">${empty('git-pull-request', none[0]!, none[1]!)}</div>`}
      <p class="small muted rs-fix-note">From the issue sync, every couple of minutes: pull requests by bots and chores (dependency bumps, CI, tests) are left out. A pull request is for an issue when it says so (“Fixes #12”) or names it (“for #12”). Reports are the Discord tickets about those issues, duplicates included.</p>
    </div>`;
  }

  /** A chip for an issue a pull request is about: being worked on, waiting for a release, or fixed. */
  function fixChip(f: IssueFix | undefined): SafeHtml | string {
    if (!f) return '';
    const p = f.pull;
    if (f.status === 'open') return html`<a class="rs-why sug" href="${p.html_url}" target="_blank" rel="noopener noreferrer" title="${p.title}">${p.draft ? 'Draft' : 'Open'} PR #${String(p.number)}</a>`;
    if (f.status === 'waiting') return html`<a class="rs-why ok" href="${p.html_url}" target="_blank" rel="noopener noreferrer" title="${`${p.title}: merged, not in a release yet`}">Fixed in #${String(p.number)}, not released</a>`;
    return html`<a class="rs-why ok" href="${p.html_url}" target="_blank" rel="noopener noreferrer" title="${p.title}">Fixed in #${String(p.number)}${f.release ? ` (${f.release.tag})` : ''}</a>`;
  }

  function footer(l: Awaited<ReturnType<typeof load>>): SafeHtml {
    return html`<div class="rs-foot">
      <span>${l.next ? html`Next read ${localTime(l.next)} · every ${plural(l.s.everyMinutes, 'minute')}` : l.s.enabled ? 'Reading…' : 'Off'}</span>
      ${l.budget !== null ? html`<span title="GraphQL points left this hour (filing uses a separate budget)">GitHub budget ${n(l.budget)}</span>` : ''}
    </div>`;
  }

  // ---- The page ----------------------------------------------------------------------------------

  app.get('/w/:wid/repos', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'repo-status.view' });
    if (!ctx) return reply;
    const q = req.query as { view?: string; repo?: string; partial?: string; period?: string; list?: string };
    const edit = can(ctx.membership, 'repo-status.edit');
    const l = await load(ctx);
    const view = q.view === 'fix' ? 'fix' : q.view === 'reported' ? 'reported' : q.view === 'pulls' ? 'pulls' : 'repos';
    const period = view === 'reported' ? periodOf(q.period).id : DEFAULT_PERIOD;
    const repos = l.rows.map((r) => r.repo);
    const reports = l.s.enabled ? await mostReported(deps.db, deps.box, ctx.workspace.id, repos, periodStart(period)) : [];
    const pulls = l.s.enabled ? await listPulls(deps.db, repos) : { open: [], waiting: [], merged: [] };
    const which = q.list === 'waiting' ? 'waiting' : q.list === 'merged' ? 'merged' : 'open';
    // The pull requests about the issues on the page.
    const fixes = new Map<string, IssueFix>();
    if (view === 'fix' || view === 'reported') {
      for (const r of l.rows) {
        const numbers = view === 'fix' ? (r.stats?.urgent ?? []).map((u) => u.number) : reports.filter((x) => x.repo.id === r.repo.id).map((x) => x.number);
        for (const [num, f] of await fixesFor(deps.db, r.repo.id, numbers)) fixes.set(`${r.repo.id}:${num}`, f);
      }
    }
    const reportsAll = view === 'pulls'
      ? new Map((await mostReported(deps.db, deps.box, ctx.workspace.id, repos, null)).map((x) => [`${x.repo.id}:${x.number}`, x.reports.length]))
      : new Map<string, number>();
    const live = html`<div class="rs-live">
      <div class="rs-bar">
        ${segLinks('View', [
          { href: base(ctx), label: 'Repos', count: l.rows.length, current: view === 'repos' },
          { href: `${base(ctx)}?view=fix`, label: 'Fix first', count: l.rows.reduce((s, r) => s + (r.stats?.urgent.length ?? 0), 0), current: view === 'fix' },
          { href: `${base(ctx)}?view=reported`, label: 'Most reported', count: reports.filter((x) => x.reports.length > 1).length, current: view === 'reported' },
          { href: `${base(ctx)}?view=pulls`, label: 'Pull requests', count: pulls.open.length, current: view === 'pulls' },
        ])}
        <span class="rs-fresh">${freshPill(l.freshness)}${l.oldest ? html`<span class="small muted">Data as of ${localTime(l.oldest)} (${timeAgo(l.oldest)})</span>` : ''}</span>
      </div>
      ${l.rows.filter((r) => r.row?.error).map((r) => html`<div class="rs-err">${notice('warn', `${r.repo.owner}/${r.repo.name}`, r.row!.error!)}</div>`)}
      ${view === 'fix'
        ? fixFirst(ctx, l.rows, q.repo ?? null, fixes)
        : view === 'reported'
          ? mostReportedView(ctx, reports, q.repo ?? null, period, fixes)
          : view === 'pulls'
            ? pullsView(ctx, pulls, reportsAll, which, q.repo ?? null)
          : html`<section class="card rs-card" aria-label="Repositories">${table(ctx, l.rows)}${footer(l)}</section>`}
    </div>`;
    if (q.partial === '1') return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(live.toString());

    const conn = await getGitHubConnection(deps.db, ctx.workspace.id);
    const actions = edit
      ? [l.s.enabled ? postBtn(`${base(ctx)}/refresh`, 'Refresh', ctx.csrf, { icon: 'refresh-cw', loading: 'Refreshing…', title: 'Read every repository again now, one at a time' }) : null, linkBtn(`${base(ctx)}/settings`, 'Settings', { icon: 'settings' })]
      : [viewOnlyTag('You can see each repository’s status. Choosing the repositories and refreshing need Edit on Repo status. Ask an admin if you need it.')];
    const body = html`
      ${pageHeader({
        title: 'Repo status',
        description: l.s.enabled
          ? `Open PRs and issues, what landed lately and each build, for ${plural(l.rows.length, 'repository', 'repositories')}. Read from GitHub every ${plural(l.s.everyMinutes, 'minute')}, one repository at a time.`
          : 'Open PRs and issues, what landed lately and each build, and what to fix first, per repository.',
        actions,
      })}
      ${!conn
        ? html`<div class="card">${empty('github', 'Connect GitHub first', 'Repo status reads the repositories the GitHub App can access.')}</div>`
        : !l.s.enabled
          ? html`<section class="card rs-off">
              <div class="card-b">
                <h2>See every repository at a glance</h2>
                <p class="muted">Open PRs and issues, the last commit, what was merged in the last hours, each latest build with its unreleased commits and downloads, and which open issues to fix first, scored from what they say and who’s piling on. ${l.rows.length === 1 ? `It starts with ${l.rows[0]!.repo.name}, your apps’ repository.` : l.rows.length ? `It starts with your apps’ ${l.rows.length} repositories: ${l.rows.slice(0, 6).map((r) => r.repo.name).join(', ')}${l.rows.length > 6 ? '…' : ''}.` : ''}</p>
                <p class="small muted">Read in the background with GitHub’s GraphQL API, which has its own hourly budget: filing tickets isn’t affected. Nothing is written to the repositories.</p>
                ${edit ? html`<div class="row">${postBtn(`${base(ctx)}/settings`, 'Turn on', ctx.csrf, { variant: 'primary', icon: 'chart-no-axes-column-increasing', fields: { enabled: '1', keep: '1' } })}${linkBtn(`${base(ctx)}/settings`, 'Choose the repositories', { variant: 'ghost' })}</div>` : html`<p class="small muted">An admin can turn it on.</p>`}
              </div>
            </section>`
          : html`<div data-live="30000" data-live-src="${`${base(ctx)}?${new URLSearchParams({ partial: '1', ...(view !== 'repos' ? { view } : {}), ...(view !== 'repos' && q.repo ? { repo: q.repo } : {}), ...(view === 'reported' && period !== DEFAULT_PERIOD ? { period } : {}), ...(view === 'pulls' && which !== 'open' ? { list: which } : {}) }).toString()}`}">${live}</div>`}`;
    return web.render(reply, ctx, 'Repo status', 'repos', body, { width: 'full' });
  });

  // A repository's app icon (only for repositories this workspace watches).
  app.get('/w/:wid/repos/icon/:repoId', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'repo-status.view' });
    if (!ctx) return reply;
    const id = Number((req.params as { repoId: string }).repoId);
    const s = await getStatusSettings(deps.db, ctx.workspace.id);
    const mine = (await statusRepos(deps.db, ctx.workspace.id, s)).some((r) => r.id === id);
    const png = mine ? await statusIcon(deps.db, id) : null;
    if (!png) return reply.code(404).send();
    return reply.header('Cache-Control', 'private, max-age=3600').type('image/png').send(png);
  });

  app.post('/w/:wid/repos/refresh', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'repo-status.edit' });
    if (!ctx) return reply;
    await requestRefresh(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'Reading every repository again, one at a time. The table updates as each one comes in.');
    return reply.redirect(base(ctx));
  });

  // ---- Settings ----------------------------------------------------------------------------------

  app.get('/w/:wid/repos/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'repo-status.edit' });
    if (!ctx) return reply;
    const s = await getStatusSettings(deps.db, ctx.workspace.id);
    const current = await statusRepos(deps.db, ctx.workspace.id, s);
    const conn = await getGitHubConnection(deps.db, ctx.workspace.id);
    const { rows: apps } = await deps.db.query<{ repo_id: number; name: string }>('SELECT repo_id, name FROM apps WHERE workspace_id = $1 ORDER BY position, lower(name)', [ctx.workspace.id]);
    let available: { id: number; owner: string; name: string; archived: boolean }[] = [];
    let loadError: string | null = null;
    if (conn && deps.github) {
      try {
        available = (await getInstallationRepos(deps, conn.installation_id)).map((r) => ({ id: r.id, owner: r.owner, name: r.name, archived: r.archived }));
      } catch (err) {
        loadError = (err as Error).message;
      }
    }
    // Watched first, in their order, then the others by name.
    const chosen = new Set(current.map((r) => r.id));
    const list = [...current.map((r) => ({ ...r, archived: available.find((a) => a.id === r.id)?.archived ?? false })), ...available.filter((a) => !chosen.has(a.id)).sort((a, b) => a.name.localeCompare(b.name))];
    const usedBy = (id: number) => apps.filter((x) => x.repo_id === id).map((x) => x.name);
    const body = html`
      ${pageHeader({ crumbs: [{ href: base(ctx), label: 'Repo status' }, { label: 'Settings' }], title: 'Repo status settings' })}
      <form method="post" action="${base(ctx)}/settings" class="stack">
        ${csrfField(ctx.csrf)}<input type="hidden" name="repos_set" value="1">
        <section class="card">
          ${setting('Repo status', 'Reads the repositories below in the background, with GitHub’s GraphQL API. Filing tickets uses a separate budget, so it isn’t affected.', switchInput({ name: 'enabled', checked: s.enabled, label: 'Repo status on' }), { switchRow: true })}
          ${setting('Read every', 'How old a repository’s data gets before it’s read again. Each read costs about 7 of GitHub’s 5,000 GraphQL points an hour per installation.', selectWrap(html`<select id="rs-every" name="every">${EVERY_MINUTES.map((m) => html`<option value="${String(m)}" ${m === s.everyMinutes ? raw('selected') : ''}>${plural(m, 'minute')}</option>`)}</select>`), { for: 'rs-every' })}
        </section>
        <section class="card" aria-labelledby="rs-repos-h">
          <div class="card-h"><div><h2 id="rs-repos-h">Repositories</h2><div class="desc">The ones the GitHub App can access. Your apps’ repositories are picked to start with.</div></div></div>
          ${loadError ? html`<div class="card-b tight">${notice('warn', 'Couldn’t list the repositories', loadError)}</div>` : ''}
          <ul class="rs-pick">${list.map((r) => html`<li><label class="check"><input type="checkbox" name="repo" value="${`${String(r.id)}:${r.owner}/${r.name}`}" ${chosen.has(r.id) ? raw('checked') : ''}> <span class="mono">${r.owner}/${r.name}</span>${usedBy(r.id).length ? tag(usedBy(r.id).join(', '), { cls: 'subtle' }) : ''}${r.archived ? tag('Archived', { cls: 'subtle' }) : ''}</label></li>`)}</ul>
          <div class="card-f"><span class="small muted">${list.length ? `${plural(chosen.size, 'repository', 'repositories')} picked` : 'No repositories yet.'}</span><div class="end">${linkBtn(base(ctx), 'Cancel', { variant: 'ghost' })}${submitBtn('Save', { variant: 'primary' })}</div></div>
        </section>
      </form>`;
    return web.render(reply, ctx, 'Repo status settings', 'repos', body);
  });

  app.post('/w/:wid/repos/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'repo-status.edit' });
    if (!ctx) return reply;
    const f = (req.body ?? {}) as { enabled?: string; every?: string; repo?: string | string[]; repos_set?: string; keep?: string };
    const s = await getStatusSettings(deps.db, ctx.workspace.id);
    const every = f.every === undefined ? s.everyMinutes : Number(f.every);
    if (!(EVERY_MINUTES as readonly number[]).includes(every)) {
      setFlash(reply, 'error', 'Choose how often from the list.');
      return reply.redirect(`${base(ctx)}/settings`);
    }
    let repos = s.repos;
    if (f.repos_set) {
      const picked = (Array.isArray(f.repo) ? f.repo : f.repo ? [f.repo] : []).map((v) => /^(\d+):([^/]+)\/(.+)$/.exec(v)).filter((m): m is RegExpExecArray => Boolean(m));
      repos = picked.map((m) => ({ id: Number(m[1]), owner: m[2]!, name: m[3]! }));
    }
    const enabled = f.keep ? Boolean(f.enabled) || s.enabled : Boolean(f.enabled);
    await saveStatusSettings(deps.db, ctx.workspace.id, { enabled, repos, everyMinutes: every });
    setFlash(reply, 'success', enabled ? (s.enabled ? 'Saved.' : 'Repo status is on. The first read of each repository takes a minute or two.') : 'Saved. Repo status is off.');
    return reply.redirect(base(ctx));
  });
}

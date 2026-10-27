/**
 * Analytics: downloads over time (recorded every 30 minutes from when it's turned on), with their
 * platforms, architectures, formats and versions, next to tickets, issues, pull requests and
 * stars over the same time, and release health (tickets per 1,000 downloads). One row of filters
 * scopes everything: the app, the range (today by default) and the step (30 minutes to a day).
 * Charts are drawn by app.js from the numbers on the page; each has a table view.
 */
import type { FastifyInstance } from 'fastify';
import { analyticsData, type AnalyticsData, type Breakdown, type Metric, type Series } from '../../analytics/queries.js';
import { analyticsRepos, getAnalyticsSettings, setAnalyticsEnabled } from '../../analytics/recorder.js';
import { RANGES, safeTimeZone, windowOf, type Window } from '../../analytics/time.js';
import { can } from '../../domain/permissions.js';
import { getGitHubConnection, listApps } from '../../domain/store.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { empty, localTime, notice, pageHeader, plural, postBtn, segLinks, selectWrap, timeAgo, viewOnlyTag } from '../ui.js';

const n = (x: number) => x.toLocaleString('en-US');
/** 1,284 · 12.9K · 4.2M */
export function compact(x: number): string {
  if (x < 10_000) return n(x);
  if (x < 1_000_000) return `${(x / 1000).toFixed(x < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(x / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
/** A change: +12 · −3 · 0 */
const signed = (x: number) => (x > 0 ? `+${compact(x)}` : x < 0 ? `−${compact(-x)}` : '0');

/** Up is good, down is good, or neither (the delta stays neutral). */
export type Better = 'up' | 'down' | null;

export function delta(total: number, prev: number | null, compare: string, better: Better): SafeHtml {
  if (prev === null) return html`<div class="an-d muted">—<span class="an-vs">not recorded ${compare}</span></div>`;
  if (prev === 0 && total === 0) return html`<div class="an-d muted">Same<span class="an-vs">as ${compare}</span></div>`;
  if (prev === 0) return html`<div class="an-d muted">New<span class="an-vs">none ${compare}</span></div>`;
  const pct = Math.round(((total - prev) / prev) * 100);
  if (pct === 0) return html`<div class="an-d muted">Same<span class="an-vs">as ${compare}</span></div>`;
  const dir = pct > 0 ? 'up' : 'down';
  const tone = better === null ? '' : better === dir ? ' good' : ' bad';
  return html`<div class="an-d${tone}"><span class="an-arrow" aria-hidden="true">${dir === 'up' ? '▲' : '▼'}</span><span class="sr-only">${dir === 'up' ? 'Up' : 'Down'} </span>${n(Math.abs(pct))}% <span class="muted an-vs">vs ${compare}</span></div>`;
}

export function registerAnalyticsRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const base = (ctx: WorkspaceRequestContext) => `${ctx.base}/analytics`;

  /** Bucket labels in the viewer's time zone, for table views ("Oct 21, 9:30 PM", or "Oct 21" by day). */
  function labeler(w: Window, tz: string) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return (ms: number) => (w.step.id === '1d' ? day.format(new Date(ms)) : time.format(new Date(ms)));
  }

  /** A chart app.js draws (columns, stacked when there are several series), and its table view. */
  function chart(w: Window, tz: string, o: { id: string; title: string; series: (Series & { slot: number })[]; unit: string; small?: boolean; caption?: string }): SafeHtml {
    const data = {
      buckets: w.buckets, end: w.end, until: w.until, step: w.step.id, unit: o.unit, small: Boolean(o.small),
      series: o.series.map((s) => ({ name: s.name, slot: s.slot, values: s.values })),
    };
    const label = labeler(w, tz);
    const rows = w.buckets.map((b, i) => ({ b, values: o.series.map((s) => s.values[i] ?? null) })).filter((r) => r.values.some((v) => v !== null && v > 0));
    const many = o.series.length > 1;
    return html`<figure class="an-chart${o.small ? ' small' : ''}" aria-label="${o.title}">
      <div class="an-plot" data-an-chart='${JSON.stringify(data)}' aria-label="${`${o.title}: chart. Open the table below for the numbers.`}"></div>
      ${many ? html`<div class="an-legend" aria-hidden="true">${o.series.map((s) => html`<span><i class="an-key s${String(s.slot)}"></i>${s.name}</span>`)}</div>` : ''}
      <details class="an-tv"><summary>${o.caption ?? 'Table'}</summary>
        ${rows.length
          ? html`<div class="table-wrap"><table class="an-table"><thead><tr><th scope="col">${w.step.id === '1d' ? 'Day' : 'From'}</th>${o.series.map((s) => html`<th scope="col" class="num">${many ? s.name : o.unit}</th>`)}${many ? html`<th scope="col" class="num">Total</th>` : ''}</tr></thead>
              <tbody>${rows.map((r) => html`<tr><td>${label(r.b)}</td>${r.values.map((v) => html`<td class="num">${v === null ? '—' : n(v)}</td>`)}${many ? html`<td class="num">${n(r.values.reduce<number>((t, v) => t + (v ?? 0), 0))}</td>` : ''}</tr>`)}</tbody></table></div>`
          : html`<p class="small muted">Nothing in this period.</p>`}
      </details>
    </figure>`;
  }

  /** A ranked list of bars (one colour, or the platform's), with the share of the total. */
  /**
   * A horizontal bar chart app.js draws: names on the left, bars on one axis from zero (so a bar's
   * length is its value), the value and its share at the tip. Without scripts, the plain list.
   */
  function hbars(items: { label: string; value: number; slot?: number; note?: string | null; noteUp?: boolean }[], o: { empty: string; colored?: boolean; share?: boolean; max?: number }): SafeHtml {
    const total = items.reduce((t, b) => t + b.value, 0);
    if (!total && !items.some((b) => b.note)) return html`<p class="small muted an-none">${o.empty}</p>`;
    const shown = items.slice(0, o.max ?? 10);
    const share = o.share !== false && total > 0;
    const pct = (v: number) => { const p = (v / total) * 100; return p < 1 && v > 0 ? '<1%' : `${Math.round(p)}%`; };
    const data = { items: shown.map((b) => ({ label: b.label, value: b.value, slot: o.colored && b.slot ? b.slot : 1, share: share ? pct(b.value) : null, note: b.note ?? null, up: Boolean(b.noteUp) })) };
    return html`<figure class="an-hb" data-an-hbar='${JSON.stringify(data)}'>
      <ul class="an-hb-list">${shown.map((b) => html`<li><span>${b.label}</span><span class="num">${n(b.value)}${share ? html` <span class="muted">${pct(b.value)}</span>` : ''}${b.note ? html` <span class="${b.noteUp ? 'an-up' : 'muted'}">${b.note}</span>` : ''}</span></li>`)}</ul>
    </figure>`;
  }

  function bars(items: Breakdown[], o: { empty: string; colored?: boolean }): SafeHtml {
    return hbars(items, o);
  }

  /** Each app's star total (GitHub's count) and how much it changed in the period. */
  function starList(rows: AnalyticsData['starsByApp'], o: { gained?: boolean } = { gained: true }): SafeHtml {
    if (!rows.some((r) => r.total !== null || r.gained)) return html`<p class="small muted an-none">Star totals show up after the first read.</p>`;
    return hbars(rows.map((r) => ({ label: r.label, value: r.total ?? 0, note: o.gained ? signed(r.gained) : null, noteUp: r.gained > 0 })), { empty: 'No stars yet.', share: false, max: 30 });
  }

  function tile(label: string, value: string, d: SafeHtml, title?: string, sub?: SafeHtml | string): SafeHtml {
    return html`<div class="an-kpi" ${title ? html`title="${title}"` : ''}><div class="an-kl">${label}</div><div class="an-kv">${value}</div>${sub ? html`<div class="an-ks">${sub}</div>` : ''}${d}</div>`;
  }

  function body(ctx: WorkspaceRequestContext, w: Window, tz: string, d: AnalyticsData, repoChoice: string, apps: { id: number; name: string }[], metric: 'downloads' | 'stars'): SafeHtml {
    const compare = w.range.compare;
    // All: totals since the beginning, no timeline and nothing to compare with.
    const lifetime = w.range.id === 'all';
    const vs = (total: number, prev: number | null, better: Better) => (lifetime ? html`<div class="an-d muted">All time</div>` : delta(total, prev, compare, better));
    const href = (o: { range?: string; step?: string | null; app?: string; metric?: string }) => {
      const p = new URLSearchParams();
      if ((o.metric ?? metric) === 'stars') p.set('metric', 'stars');
      const range = o.range ?? w.range.id;
      if (range !== 'today') p.set('range', range);
      const step = o.step === undefined ? (o.range ? null : w.step.id) : o.step;
      if (step && step !== windowOf(range, undefined, tz).step.id) p.set('step', step);
      const appId = o.app ?? repoChoice;
      if (appId !== 'all') p.set('app', appId);
      const qs = p.toString();
      return `${base(ctx)}${qs ? `?${qs}` : ''}`;
    };
    const perK = d.downloads.total > 0 ? (d.tickets.total / d.downloads.total) * 1000 : null;
    const prevPerK = d.downloads.prev ? (d.tickets.prev ?? 0) / d.downloads.prev * 1000 : null;
    // One repository (picked, or the only one): downloads by platform; several: all of them together.
    const single = d.downloads.series.length > 1;
    const noDownloads = !lifetime && metric === 'downloads' && (!d.recordingSince || (d.downloads.total === 0 && d.recordingSince.getTime() > w.start));
    const noStars = !lifetime && metric === 'stars' && !d.starErrors.length && (!d.starsSince || (d.stars.total === 0 && d.starsSince.getTime() > w.start));
    const per = `per ${w.step.id === '1d' ? 'day' : w.step.label}`;
    const switcher = html`<nav class="seg sm an-metric" aria-label="Chart">${([['downloads', 'Downloads'], ['stars', 'Stars']] as const).map(([id, label]) => html`<a class="seg-item" href="${href({ metric: id })}" ${id === metric ? raw('aria-current="true"') : ''}>${label}</a>`)}</nav>`;
    const appLabel = single ? apps.find((a) => String(a.id) === repoChoice)?.name ?? apps[0]?.name ?? 'this app' : 'all apps';
    return html`
      <form method="get" action="${base(ctx)}" class="an-filters" aria-label="Filters">
        ${w.range.id !== 'today' ? html`<input type="hidden" name="range" value="${w.range.id}">` : ''}
        ${metric === 'stars' ? html`<input type="hidden" name="metric" value="stars">` : ''}
        <label class="sr-only" for="an-app">App</label>
        ${selectWrap(html`<select id="an-app" name="app" data-autosubmit><option value="all" ${repoChoice === 'all' ? raw('selected') : ''}>All apps</option>${apps.map((a) => html`<option value="${String(a.id)}" ${String(a.id) === repoChoice ? raw('selected') : ''}>${a.name}</option>`)}</select>`, { sm: true })}
        <noscript><button class="btn sm" type="submit">Apply</button></noscript>
        ${segLinks('Range', RANGES.map((r) => ({ href: href({ range: r.id }), label: r.label, current: r.id === w.range.id })))}
        <nav class="seg an-steps${lifetime ? ' off' : ''}" aria-label="Step" ${lifetime ? raw('title="All shows totals, not a timeline: pick a range to see it over time"') : ''}>${w.steps.map((s) => s.ok
          ? html`<a class="seg-item" href="${href({ step: s.id })}" ${s.id === w.step.id ? raw('aria-current="true"') : ''}>${s.label}</a>`
          : html`<span class="seg-item off" aria-disabled="true" ${lifetime ? '' : html`title="${`Too fine for ${w.range.label.toLowerCase()}`}"`}>${s.label}</span>`)}</nav>
      </form>

      ${noDownloads ? html`<div class="an-note">${notice('info', d.recordingSince ? 'Downloads are being recorded' : 'Downloads start recording in a minute', d.recordingSince
        ? html`Recording began ${localTime(d.recordingSince)}: GitHub only keeps running totals, so nothing is known from before. The first numbers show up after the next half hour.`
        : 'The first read of each repository is a starting point; downloads show up from the half hour after.')}</div>` : ''}
      ${metric === 'stars' && d.starErrors.length ? html`<div class="an-note">${notice('warn', 'Stars couldn’t be read', html`${d.starErrors.length === 1 ? html`${d.starErrors[0]!.app}: ${d.starErrors[0]!.error}` : html`For ${d.starErrors.map((e) => e.app).join(', ')}. ${d.starErrors[0]!.error}`} Trying again every 30 minutes; downloads aren’t affected.`)}</div>` : ''}
      ${noStars ? html`<div class="an-note">${notice('info', d.starsSince ? 'Stars are being recorded' : 'Stars start recording in a minute', d.starsSince
        ? html`Counting began ${localTime(d.starsSince)}: GitHub gives the app each repository’s star count, so stars are counted from how it changes, every 30 minutes. Nothing is known from before.`
        : 'The first read of each repository’s star count is a starting point; changes show up from the half hour after.')}</div>` : ''}

      <div class="an-kpis">
        ${tile('Downloads', compact(d.downloads.total), vs(d.downloads.total, d.downloads.prev, 'up'), lifetime ? 'GitHub’s own totals for every release file (checksums and update data left out)' : 'Release files downloaded from GitHub (checksums and update data left out)')}
        ${tile('Discord tickets', compact(d.tickets.total), vs(d.tickets.total, d.tickets.prev, null), 'Reports members filed through your Discord panel (each becomes a GitHub issue)')}
        ${tile('Tickets per 1K downloads', perK === null ? '—' : perK.toFixed(perK < 10 ? 1 : 0), perK === null ? html`<div class="an-d muted">—<span class="an-vs">no downloads yet</span></div>` : lifetime ? vs(0, null, null) : delta(Math.round(perK * 10), prevPerK === null ? null : Math.round(prevPerK * 10), compare, 'down'), 'Discord tickets per 1,000 downloads. Fewer is better: a bad build shows up here first')}
        ${tile('Issues opened', compact(d.issuesOpened.total), vs(d.issuesOpened.total, d.issuesOpened.prev, null), 'Every new GitHub issue in these repositories: the ones filed from Discord tickets, and the ones opened on GitHub', `${n(d.issuesOpened.fromDiscord)} from Discord · ${n(Math.max(0, d.issuesOpened.total - d.issuesOpened.fromDiscord))} on GitHub`)}
        ${tile('Issues closed', compact(d.issuesClosed.total), vs(d.issuesClosed.total, d.issuesClosed.prev, 'up'))}
        ${tile('PRs merged', compact(d.pullsMerged.total), vs(d.pullsMerged.total, d.pullsMerged.prev, 'up'))}
        ${tile('Stars', lifetime ? compact(d.stars.total) : signed(d.stars.total), vs(d.stars.total, d.stars.prev, 'up'), lifetime ? 'GitHub’s own star count' : 'How much GitHub’s star count changed: stars given, less stars taken back')}
      </div>

      <section class="card an-card" aria-labelledby="an-main-h">
        <div class="an-ch"><h2 id="an-main-h" class="sr-only">${metric === 'stars' ? 'Stars' : 'Downloads'}</h2>${switcher}<span class="small muted">${lifetime
          ? metric === 'stars' ? 'all time · by app · GitHub’s count' : `all time · ${single ? 'by version' : 'by app'} · GitHub’s totals`
          : metric === 'stars'
            ? `stars gained · ${appLabel} · ${per}`
            : `${single ? 'by platform' : 'all apps'} · ${per}`}</span></div>
        ${lifetime
          ? metric === 'stars'
            ? starList(d.starsByApp, { gained: false })
            : bars(single ? d.downloads.versions : d.downloads.byApp, { empty: 'Downloads show up after the first read.' })
          : metric === 'stars'
            ? chart(w, tz, { id: 'stars', title: 'Stars gained', unit: 'Stars gained', series: [{ key: 'stars', name: 'Stars gained', values: d.stars.values, slot: 1 }] })
            : chart(w, tz, { id: 'downloads', title: 'Downloads', unit: 'Downloads', series: single ? d.downloads.series.map((s, i) => ({ ...s, slot: i + 1 })) : [{ ...d.downloads.series[0]!, slot: 1 }] })}
      </section>

      ${metric === 'stars' ? (lifetime ? '' : html`<div class="an-grid">
        <section class="card an-card" aria-labelledby="an-sb-h"><div class="an-ch"><h2 id="an-sb-h">Stars by app</h2><span class="small muted">total, and change in this period</span></div>${starList(d.starsByApp, { gained: Boolean(d.starsSince) })}
          <p class="small muted an-foot">Totals are GitHub’s own count, read every 30 minutes with the downloads. The change is how much each total moved in this period: a star taken back counts −1.</p></section>
      </div>`) : html`<div class="an-grid">
        ${single || lifetime ? '' : html`<section class="card an-card" aria-labelledby="an-apps-h"><div class="an-ch"><h2 id="an-apps-h">By app</h2></div>${bars(d.downloads.byApp, { empty: 'No downloads in this period.' })}</section>`}
        <section class="card an-card" aria-labelledby="an-pl-h"><div class="an-ch"><h2 id="an-pl-h">Platforms</h2></div>${bars(d.downloads.platforms, { empty: 'No downloads in this period.', colored: true })}</section>
        <section class="card an-card" aria-labelledby="an-ar-h"><div class="an-ch"><h2 id="an-ar-h">Processor</h2></div>${bars(d.downloads.archs, { empty: 'No downloads in this period.' })}</section>
        <section class="card an-card" aria-labelledby="an-fo-h"><div class="an-ch"><h2 id="an-fo-h">Formats</h2></div>${bars(d.downloads.formats, { empty: 'No downloads in this period.' })}</section>
        ${single && lifetime ? '' : html`<section class="card an-card" aria-labelledby="an-ve-h"><div class="an-ch"><h2 id="an-ve-h">Versions</h2></div>${bars(d.downloads.versions, { empty: 'No downloads in this period.' })}</section>`}
      </div>`}

      ${lifetime ? '' : html`<section class="card an-card" aria-labelledby="an-act-h">
        <div class="an-ch"><h2 id="an-act-h">Activity</h2><span class="small muted">per ${w.step.id === '1d' ? 'day' : w.step.label}</span></div>
        <div class="an-multi">
          ${([['Discord tickets', d.tickets], ['Issues opened (Discord + GitHub)', d.issuesOpened], ['Issues closed', d.issuesClosed], ['PRs merged', d.pullsMerged], ['Stars', d.stars]] as [string, Metric][]).map(([title, m]) => html`<div class="an-mini">
            <div class="an-mh"><span>${title}</span><b>${n(m.total)}</b></div>
            ${chart(w, tz, { id: title, title, unit: title, small: true, series: [{ key: title, name: title, values: m.values, slot: 1 }] })}
          </div>`)}
        </div>
      </section>`}

      <section class="card an-card" aria-labelledby="an-rel-h">
        <div class="an-ch"><h2 id="an-rel-h">Release health</h2><span class="small muted">Discord tickets while each release was the latest, per 1,000 of its downloads</span></div>
        ${d.releases.length
          ? html`<div class="table-wrap"><table class="an-table an-rel"><thead><tr>${single ? '' : html`<th scope="col">App</th>`}<th scope="col">Release</th><th scope="col">Published</th><th scope="col" class="num">Downloads</th><th scope="col" class="num">Tickets</th><th scope="col" class="num" title="Fewer is better">Per 1K downloads</th></tr></thead>
              <tbody>${d.releases.map((r) => html`<tr>
                ${single ? '' : html`<td>${r.app}</td>`}
                <td><a href="https://github.com/${r.repo.owner}/${r.repo.name}/releases/tag/${encodeURIComponent(r.release)}" target="_blank" rel="noopener noreferrer" class="mono">${r.release}</a>${r.latest ? html` <span class="tag subtle">Latest</span>` : ''}${r.prerelease ? html` <span class="tag subtle">Pre-release</span>` : ''}</td>
                <td>${r.publishedAt ? localTime(r.publishedAt) : '—'}</td>
                <td class="num">${n(r.downloads)}</td>
                <td class="num">${n(r.tickets)}</td>
                <td class="num">${r.perThousand === null ? '—' : r.perThousand === 0 ? '0' : r.perThousand.toFixed(r.perThousand < 10 ? 1 : 0)}</td>
              </tr>`)}</tbody></table></div>
              <p class="small muted an-foot">Downloads are GitHub’s totals for each release (checksums left out). A release still being downloaded keeps adding to both columns.</p>`
          : html`<p class="small muted an-none">Releases show up after the first read.</p>`}
      </section>

      <p class="small muted an-foot">${lifetime ? html`All: GitHub’s own totals for downloads and stars, and every Discord ticket, issue and merged pull request kept. ` : ''}${d.recordingSince ? html`Downloads recorded every 30 minutes since ${localTime(d.recordingSince)}${d.lastRead ? html`, last read ${timeAgo(d.lastRead)}` : ''}.` : 'Downloads start recording within a minute.'} ${d.starsSince ? html` Stars counted since ${localTime(d.starsSince)}.` : ''} Times are in your time zone (${tz}). Tickets, issues and pull requests go back as far as they’re kept.</p>`;
  }

  app.get('/w/:wid/analytics', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'analytics.view' });
    if (!ctx) return reply;
    const q = req.query as { range?: string; step?: string; app?: string; metric?: string };
    const edit = can(ctx.membership, 'analytics.edit');
    const s = await getAnalyticsSettings(deps.db, ctx.workspace.id);
    const tz = safeTimeZone((req.cookies as Record<string, string | undefined>).tr_tz);
    const repos = await analyticsRepos(deps.db, ctx.workspace.id);
    const appRows = await listApps(deps.db, ctx.workspace.id);
    const appNames = new Map<number, string>();
    for (const a of appRows) appNames.set(a.repo_id, appNames.has(a.repo_id) ? `${appNames.get(a.repo_id)}, ${a.name}` : a.name);
    const choices = repos.map((r) => ({ id: r.id, name: appNames.get(r.id) ?? r.name }));
    const repoChoice = choices.some((c) => String(c.id) === q.app) ? q.app! : 'all';
    const conn = await getGitHubConnection(deps.db, ctx.workspace.id);
    const actions = edit
      ? [s.enabled ? postBtn(`${base(ctx)}/enabled`, 'Turn off', ctx.csrf, { variant: 'ghost', fields: { enabled: '0' }, confirm: { title: 'Stop recording downloads?', body: 'What’s recorded stays. While it’s off, downloads aren’t recorded, and that time can’t be filled in later.', label: 'Turn off', danger: true } }) : null]
      : [viewOnlyTag('You can see the analytics. Turning recording on or off needs Edit on Analytics. Ask an admin if you need it.')];
    let content: SafeHtml;
    if (!conn) content = html`<div class="card">${empty('github', 'Connect GitHub first', 'Analytics reads the releases of the repositories the GitHub App can access.')}</div>`;
    else if (!s.enabled) {
      content = html`<section class="card rs-off">
        <div class="card-b">
          <h2>See downloads every half hour, and what comes with them</h2>
          <p class="muted">Downloads per app, platform, processor, format and version, from 30 minutes to 12 months at a time, next to tickets, issues, pull requests and stars. Release health shows tickets per 1,000 downloads, so a bad build stands out.</p>
          <p class="small muted">GitHub only keeps running totals, so downloads are recorded from when you turn this on: every 30 minutes, for the ${plural(repos.length, 'repository', 'repositories')} Repo status watches. It reads releases and star counts with GitHub’s GraphQL API (two small calls per repository each half hour); filing isn’t affected. Stars are counted from then too; tickets, issues and pull requests go back as far as they’re kept.</p>
          ${edit ? html`<div class="row">${postBtn(`${base(ctx)}/enabled`, 'Turn on', ctx.csrf, { variant: 'primary', icon: 'chart-line', fields: { enabled: '1' } })}</div>` : html`<p class="small muted">An admin can turn it on.</p>`}
        </div>
      </section>`;
    } else if (!repos.length) {
      content = html`<div class="card">${empty('chart-line', 'No repositories yet', 'Analytics covers the repositories Repo status watches: your apps’ repositories, or the ones picked in Repo status settings.')}</div>`;
    } else {
      const w = windowOf(q.range, q.step, tz);
      const picked = repoChoice === 'all' ? repos : repos.filter((r) => String(r.id) === repoChoice);
      const data = await analyticsData(deps.db, ctx.workspace.id, picked, w, appNames);
      content = html`<div class="an" data-an-tz="${tz}">${body(ctx, w, tz, data, repoChoice, choices, q.metric === 'stars' ? 'stars' : 'downloads')}</div>`;
    }
    const page = html`
      ${pageHeader({ title: 'Analytics', description: 'Downloads, tickets, issues, pull requests and stars over time.', actions })}
      ${content}`;
    return web.render(reply, ctx, 'Analytics', 'analytics', page, { width: 'full' });
  });

  app.post('/w/:wid/analytics/enabled', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'analytics.edit' });
    if (!ctx) return reply;
    const on = String((req.body as { enabled?: string } | undefined)?.enabled ?? '') === '1';
    await setAnalyticsEnabled(deps.db, ctx.workspace.id, on);
    setFlash(reply, 'success', on ? 'Analytics is on. Downloads are recorded every 30 minutes from now.' : 'Analytics is off. What was recorded stays.');
    return reply.redirect(base(ctx));
  });
}

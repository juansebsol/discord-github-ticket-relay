/**
 * AI triage › Overview: every label on the open issues right now (priority, triage's own labels,
 * each custom label category with what still has none of its labels, and the team's own), and
 * what triage did over a period: tickets and issues it read, what it applied and suggested, how
 * sure it was, what it skipped and what it cost. One app or all of them; 7 days to all time.
 * Each label links to its open issues on GitHub.
 */
import type { FastifyInstance } from 'fastify';
import { safeTimeZone, windowOf, type Window } from '../../analytics/time.js';
import { can } from '../../domain/permissions.js';
import { listApps } from '../../domain/store.js';
import { html, raw, SafeHtml } from '../../lib/html.js';
import { openLabels, openMissing, type OpenLabels } from '../../triage/label-stats.js';
import { triageOverview, type TriageOverview } from '../../triage/overview.js';
import { FLAGS, getTriageSettings, groupKind, PRIORITIES, tokenCost, type TriageConfig } from '../../triage/settings.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { empty, icon, labelTag, linkBtn, meter, meterDefs, notice, plural, segLinks, selectWrap } from '../ui.js';
import { compact, delta, type Better } from './analytics.js';
import { areaHref, canOpen, toolHeader } from './tool.js';
import { FLAG_COPY } from './triage.js';

const RANGES = ['7d', '30d', '90d', '12m', 'all'] as const;
const RANGE_NAMES: Record<(typeof RANGES)[number], string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '12 months', all: 'All' };
const n = (x: number) => x.toLocaleString('en-US');
const pct = (part: number, whole: number) => {
  if (!whole) return '0%';
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
};

/** Where the priority bar's colours come from, most urgent first. */
const PRIORITY_TONE: Record<(typeof PRIORITIES)[number], string> = { critical: 'p-crit', high: 'p-high', medium: 'p-med', low: 'p-low' };

type Part = { pct: number; cls?: string; hatch?: 'warn' | 'muted' };

/** A row of a grouped table: what it is, its number, its bar (out of 100) and its share. */
interface TableRow {
  label: SafeHtml | string;
  count: SafeHtml | string;
  bar: Part[];
  share: string;
  /** What the search finds it by (lowercase); without it a search hides it. */
  find?: string;
  /** What the row opens, and how it's read out; `external` opens GitHub in a new tab. */
  link?: { href: string; aria: string; external: boolean };
  zero?: boolean;
}

/** A group of a grouped table, which opens and closes; `summary` shows while it's closed. */
interface TableGroup {
  key: string;
  name: string;
  /** Its name on the filter. */
  short?: string;
  kind: SafeHtml | string;
  open: boolean;
  /** After the name: how much of it is covered, or a colour key. */
  extra?: SafeHtml | string;
  summary?: SafeHtml | string;
  action?: SafeHtml | null;
  rows: TableRow[];
  empty: string;
}

/**
 * Groups of rows as one table, every bar on the same 0–100% scale. app.js adds a filter by group
 * and, with `find` (the search box's words), a search. Markup among the groups is shown as it is.
 * The page needs `meterDefs()` once for the striped bars.
 */
function groupTable(o: { name: string; head: [string, string, string]; items: (TableGroup | SafeHtml)[]; find?: string; nothing?: string }): SafeHtml {
  const groups = o.items.filter((g): g is TableGroup => !(g instanceof SafeHtml));
  const row = (r: TableRow) => {
    const cells = html`<span class="lt-l">${r.label}</span><span class="lt-n">${r.count}</span>
      <span class="lt-bar"><span class="lt-track">${meter(r.bar)}</span><span class="lt-pct">${r.share}</span></span>
      <span class="lt-go">${r.link ? icon(r.link.external ? 'arrow-up-right' : 'chevron-right', 14) : ''}</span>`;
    const cls = `lt-row${r.zero ? ' zero' : ''}`;
    return html`<li ${r.find ? html`data-lt-name="${r.find}"` : ''}>${r.link
      ? html`<a class="${cls}" href="${r.link.href}" aria-label="${r.link.aria}" ${r.link.external ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${cells}</a>`
      : html`<div class="${cls}">${cells}</div>`}</li>`;
  };
  const group = (g: TableGroup) => html`<details class="lt-group" data-lt-group="${g.key}" ${g.open ? raw('open') : ''}>
      <summary class="lt-gh">
        <span class="lt-chev" aria-hidden="true">${icon('chevron-right', 14)}</span>
        <span class="lt-gname">${g.name}</span>
        <span class="lt-kind">${g.kind}</span>
        ${g.extra ?? ''}
        ${g.summary ? html`<span class="lt-sum">${g.summary}</span>` : ''}
        ${g.action ? html`<span class="lt-act">${g.action}</span>` : ''}
      </summary>
      ${g.rows.length ? html`<ul class="lt-rows">${g.rows.map(row)}</ul>` : html`<p class="lt-nil">${g.empty}</p>`}
    </details>`;
  return html`<div class="lt" data-lt>
    <div class="lt-tools" data-lt-tools hidden>
      <div class="seg" role="group" aria-label="${`Show in ${o.name}`}">${[{ key: 'all', label: 'All' }, ...groups.map((g) => ({ key: g.key, label: g.short ?? g.name }))].map((x) => html`<button type="button" class="seg-item" data-lt-show="${x.key}" aria-pressed="${x.key === 'all' ? 'true' : 'false'}">${x.label}</button>`)}</div>
      ${o.find ? html`<span class="search sm">${icon('search', 14)}<input type="search" placeholder="${o.find}" aria-label="${o.find}" data-lt-find></span>` : ''}
    </div>
    <div class="lt-table">
      <div class="lt-head" aria-hidden="true"><span>${o.head[0]}</span><span class="lt-n">${o.head[1]}</span><span class="lt-bar"><span class="lt-scale"><i>0</i><i class="t25">25%</i><i class="t50">50%</i><i class="t75">75%</i><i class="t100">100%</i></span><span class="lt-pct">${o.head[2]}</span></span><span></span></div>
      ${o.items.map((g) => (g instanceof SafeHtml ? g : group(g)))}
      ${o.find ? html`<p class="lt-nil lt-nomatch" data-lt-none hidden>${o.nothing ?? 'Nothing matches.'}</p>` : ''}
    </div>
  </div>`;
}

/** A bar's length for `part` of `whole`: at least a sliver when there's any. */
const of = (part: number, whole: number) => (part > 0 && whole > 0 ? Math.max(0.6, (part / whole) * 100) : 0);

/** A closed group's line: the biggest few, after how many there are when `noun` names them. */
function topSummary(items: { name: string; n: number }[], noun?: string): SafeHtml | string {
  if (!items.length) return '';
  const top = [...items].sort((x, y) => y.n - x.n).slice(0, 3);
  const parts = top.map((t) => html`${t.name} <b>${n(t.n)}</b>`);
  return html`${noun ? `${plural(items.length, noun)} · ` : ''}${parts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}${items.length > 3 ? ` · +${String(items.length - 3)} more` : ''}`;
}

/** How much of a group is covered: a small bar, the share and a word. */
function coverage(part: number, whole: number, word: string, hatch: 'warn' | 'muted', title: string): SafeHtml {
  const done = whole ? (part / whole) * 100 : 0;
  return html`<span class="lt-cov${done < 50 ? ' low' : ''}" title="${title}"><span class="lt-cov-bar">${meter([{ pct: done, cls: 'lt-cov-fill' }, { pct: 100 - done, hatch }])}</span><b>${pct(part, whole)}</b> ${word}</span>`;
}

/** A column chart app.js draws (as on Analytics), stacked by series, with a table view. */
function chart(w: Window, o: { title: string; unit: string; series: { name: string; slot: number; values: number[] }[] }): SafeHtml {
  const data = { buckets: w.buckets, end: w.end, until: w.until, step: w.step.id, unit: o.unit, small: false, series: o.series.map((s) => ({ ...s, values: s.values.map((v, i) => (w.buckets[i]! >= w.until ? null : v)) })) };
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const rows = w.buckets.map((b, i) => ({ b, values: o.series.map((s) => s.values[i] ?? 0) })).filter((r) => r.values.some((v) => v > 0));
  return html`<figure class="an-chart" aria-label="${o.title}">
      <div class="an-plot" data-an-chart='${JSON.stringify(data)}' aria-label="${`${o.title}: chart. Open the table below for the numbers.`}"></div>
      <div class="an-legend" aria-hidden="true">${o.series.map((s) => html`<span><i class="an-key s${String(s.slot)}"></i>${s.name}</span>`)}</div>
      <details class="an-tv"><summary>Table</summary>
        ${rows.length
          ? html`<div class="table-wrap"><table class="an-table"><thead><tr><th scope="col">Day</th>${o.series.map((s) => html`<th scope="col" class="num">${s.name}</th>`)}<th scope="col" class="num">Total</th></tr></thead>
              <tbody>${rows.map((r) => html`<tr><td>${day.format(new Date(r.b + 12 * 3_600_000))}</td>${r.values.map((v) => html`<td class="num">${n(v)}</td>`)}<td class="num">${n(r.values.reduce((t, v) => t + v, 0))}</td></tr>`)}</tbody></table></div>`
          : html`<p class="small muted">Nothing in this period.</p>`}
      </details>
    </figure>`;
}

function tile(o: { label: string; value: string; sub?: SafeHtml | string; d?: SafeHtml; title: string; href?: string | null }): SafeHtml {
  const inner = html`<div class="an-kl">${o.label}</div><div class="an-kv">${o.value}</div>${o.sub ? html`<div class="an-ks">${o.sub}</div>` : ''}${o.d ?? ''}`;
  return o.href ? html`<a class="an-kpi ov-kpi" href="${o.href}" title="${o.title}">${inner}</a>` : html`<div class="an-kpi" title="${o.title}">${inner}</div>`;
}

/** The name of an action kind on this page. */
function actionTitle(c: TriageConfig, kind: string, category: string | null): string {
  if (kind === 'priority') return 'Priority';
  if (kind.startsWith('group:')) return c.labelGroups.find((g) => groupKind(g.id) === kind)?.name ?? category ?? 'Custom labels';
  return FLAG_COPY[kind as (typeof FLAGS)[number]]?.title ?? kind;
}

export function registerTriageOverviewRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/triage/overview', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.overview.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const q = req.query as { app?: string; range?: string };
    const tz = safeTimeZone((req.cookies as Record<string, string | undefined>).tr_tz);
    const range = RANGES.find((r) => r === q.range) ?? '30d';
    const [settings, apps] = await Promise.all([getTriageSettings(deps.db, wid), listApps(deps.db, wid)]);
    const c = settings.config;
    const picked = apps.find((a) => a.id === q.app) ?? null;
    const repoIds = picked ? [picked.repo_id] : [...new Set(apps.map((a) => a.repo_id))];
    const repoNames = [...new Set((picked ? [picked] : apps).map((a) => `${a.repo_owner}/${a.repo_name}`))];
    const w = windowOf(range, '1d', tz);
    const [d, labels, missing] = await Promise.all([
      triageOverview(deps.db, { workspaceId: wid, appId: picked?.id ?? null, repoId: picked?.repo_id ?? null }, w),
      openLabels(deps.db, repoIds),
      openMissing(deps.db, repoIds, c.labelGroups),
    ]);
    const base = areaHref(ctx, 'triage.overview');
    const href = (o: { app?: string | null; range?: string }) => {
      const p = new URLSearchParams();
      const r = o.range ?? range;
      if (r !== '30d') p.set('range', r);
      const a = o.app === undefined ? picked?.id ?? null : o.app;
      if (a) p.set('app', a);
      const qs = p.toString();
      return qs ? `${base}?${qs}` : base;
    };
    // GitHub's issue search, over these repositories.
    const search = (terms: string) => `https://github.com/search?type=issues&q=${encodeURIComponent(`${repoNames.map((r) => `repo:${r}`).join(' ')} is:issue is:open ${terms}`.trim())}`;
    // Backfilling starts on Re-run, for someone who can start one.
    const runs = can(ctx.membership, 'triage.runs.edit') ? areaHref(ctx, 'triage.runs') : null;
    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.overview')}
      <div class="an ov" data-an-tz="${tz}">${meterDefs()}
        <form method="get" action="${base}" class="an-filters" aria-label="Filters">
          ${range !== '30d' ? html`<input type="hidden" name="range" value="${range}">` : ''}
          <label class="sr-only" for="ov-app">App</label>
          ${selectWrap(html`<select id="ov-app" name="app" data-autosubmit><option value="">All apps</option>${apps.map((a) => html`<option value="${a.id}" ${a.id === picked?.id ? raw('selected') : ''}>${a.name}</option>`)}</select>`, { sm: true })}
          <noscript><button class="btn sm" type="submit">Apply</button></noscript>
          ${segLinks('Period', RANGES.map((r) => ({ href: href({ range: r }), label: RANGE_NAMES[r], current: r === range })))}
        </form>
        ${!settings.enabled && !settings.githubEnabled && !d.total
          ? html`<div class="an-note">${notice('info', 'AI triage is off', html`The labels on your open issues are below. Once triage is on, what it does shows up here too.${canOpen(ctx.membership, 'triage.actions') ? html` ${linkBtn(areaHref(ctx, 'triage.actions'), 'Open Actions', { size: 'sm', variant: 'ghost', trail: 'arrow-right' })}` : ''}`)}</div>`
          : ''}
        ${kpis(ctx, c, w, d)}
        ${range === 'all' ? '' : html`<section class="card an-card" aria-labelledby="ov-read-h">
          <div class="an-ch"><h2 id="ov-read-h">Read per day</h2><span class="small muted">${picked ? picked.name : 'all apps'} · tickets and issues Claude triaged</span></div>
          ${chart(w, { title: 'Read per day', unit: 'Read', series: [{ name: 'Discord tickets', slot: 1, values: d.tickets }, { name: 'Opened on GitHub', slot: 2, values: d.issues }] })}
        </section>`}
        ${activityCard(ctx, c, d, { apps, picked: picked?.id ?? null, range, app: (id) => href({ app: id }) })}
        <h2 class="ov-split">Right now on GitHub<span>${picked ? picked.name : 'all apps'} · the period above doesn’t change this</span></h2>
        ${labelsCard(ctx, c, labels, missing, { search, runs, app: picked?.id ?? null })}
        <p class="small muted an-foot">What triage did counts the tickets and issues it read in the period, ${RANGE_NAMES[range] === 'All' ? 'since it was turned on' : 'by the day it read them'}; the “+” numbers are suggestions still waiting in Review. Labels are what the open issues have on GitHub now, from the issue sync, whoever added them. Times are in your time zone (${tz}).</p>
      </div>`;
    return web.render(reply, ctx, 'Overview · AI triage', 'triage', body, { width: 'full' });
  });

  function kpis(ctx: WorkspaceRequestContext, c: TriageConfig, w: Window, d: TriageOverview): SafeHtml {
    const lifetime = w.range.id === 'all';
    const vs = (total: number, prev: number | null, better: Better) => (lifetime ? html`<div class="an-d muted">All time</div>` : delta(total, prev, w.range.compare, better));
    const kind = (k: string) => d.actions.find((a) => a.kind === k);
    const both = (k: string) => (kind(k)?.applied ?? 0) + (kind(k)?.suggested ?? 0);
    const cost = tokenCost(c.model, d.inputTokens, d.outputTokens, { read: d.cacheReadTokens, write: d.cacheWriteTokens });
    const review = canOpen(ctx.membership, 'triage.review') ? areaHref(ctx, 'triage.review') : null;
    return html`<div class="an-kpis ov-kpis">
      ${tile({ label: 'Read', value: compact(d.total), d: vs(d.total, d.prev, null), title: 'Discord tickets and issues opened on GitHub that Claude triaged' })}
      ${tile({ label: 'Labels added', value: compact(d.labelsAdded), d: vs(d.labelsAdded, d.prevLabelsAdded, null), title: 'Labels triage added on GitHub: priority, its own labels and custom labels, backfills included' })}
      ${tile({ label: 'Waiting in Review', value: compact(d.review), sub: 'right now', title: 'Tickets and issues with suggestions waiting for someone', href: review })}
      ${tile({ label: 'Duplicates found', value: compact(both('duplicate')), sub: `${n(kind('duplicate')?.applied ?? 0)} labelled`, title: 'Tickets and issues Claude matched with an earlier one' })}
      ${tile({ label: 'Asked for details', value: compact(both('needsInfo')), sub: `${n(kind('needsInfo')?.applied ?? 0)} asked on GitHub`, title: 'Reports missing what a developer needs to act' })}
      ${tile({ label: 'Closed by triage', value: compact(d.closed), sub: 'spam, no action, support', title: 'Issues triage closed (spam, no action needed, not a development issue)' })}
      ${tile({ label: 'Claude', value: cost === null ? '—' : `$${cost < 100 ? cost.toFixed(2) : compact(Math.round(cost))}`, sub: `${compact(d.inputTokens + d.outputTokens)} tokens`, title: `What triage cost in this period with ${c.model}, re-runs left out` })}
    </div>`;
  }

  /**
   * Every label on the open issues, a group per category (priority, each custom category, triage's
   * own, the rest), each bar out of all open issues, with a label search.
   */
  function labelsCard(ctx: WorkspaceRequestContext, c: TriageConfig, l: OpenLabels, missing: Map<string, number>, o: { search: (terms: string) => string; runs: string | null; app: string | null }): SafeHtml {
    const has = (name: string) => l.byLabel.get(name.toLowerCase()) ?? 0;
    const gh = (name: string) => o.search(`label:"${name}"`);
    const without = (names: string[]) => o.search(names.map((x) => `-label:"${x}"`).join(' '));
    const prio = PRIORITIES.map((p) => ({ name: c.priority.labels[p], n: has(c.priority.labels[p]) }));
    const prioritized = prio.reduce((t, x) => t + x.n, 0);
    const flagLabels = [...new Map(FLAGS.filter((f) => c[f].label.trim()).map((f) => [c[f].label.toLowerCase(), c[f].label])).values()];
    const known = new Set([...prio.map((x) => x.name.toLowerCase()), ...flagLabels.map((x) => x.toLowerCase()), ...c.labelGroups.flatMap((g) => g.options.map((x) => x.label.toLowerCase()))]);
    const others = [...l.byLabel].filter(([k]) => !known.has(k)).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: l.names.get(k) ?? k, n: v }));
    const byCount = (a: { n: number }, b: { n: number }) => b.n - a.n;

    // A label, or what has none of a category's labels (`none`).
    const row = (r: { name: string; n: number; href: string; none?: 'warn' | 'muted' }): TableRow => ({
      label: r.none ? html`<span class="lt-nolabel ${r.none}">${r.name}</span>` : labelTag(r.name),
      find: r.none ? undefined : r.name.toLowerCase(),
      count: n(r.n),
      bar: [r.none ? { pct: of(r.n, l.open), hatch: r.none } : { pct: of(r.n, l.open), cls: 'lt-fill' }],
      share: pct(r.n, l.open),
      link: { href: r.href, external: true, aria: `${r.name}: ${n(r.n)} open issues, ${pct(r.n, l.open)}. See them on GitHub` },
      zero: !r.n,
    });
    const labelled = (labels: { name: string; n: number }[]) => topSummary(labels, 'label');
    const items: (TableGroup | SafeHtml)[] = [{
      key: 'priority', name: 'Priority', kind: 'set by triage', open: true, empty: '',
      extra: coverage(prioritized, l.open, 'have one', 'muted', `${n(prioritized)} of ${n(l.open)} open issues`),
      summary: labelled(prio),
      rows: [...prio.map((x) => row({ ...x, href: gh(x.name) })), row({ name: 'No priority', n: Math.max(0, l.open - prioritized), href: without(prio.map((x) => x.name)), none: 'muted' })],
    }];
    if (!c.labelGroups.length) {
      items.push(html`<div class="lt-empty" data-lt-extra>${empty('tags', 'No custom labels yet', html`Sort every ticket into your own labels, such as bug, parity or plugins.`, canOpen(ctx.membership, 'triage.labels') ? linkBtn(areaHref(ctx, 'triage.labels'), 'Add custom labels', { size: 'sm', trail: 'arrow-right' }) : null)}</div>`);
    }
    for (const g of c.labelGroups) {
      const none = missing.get(g.id) ?? 0;
      const done = Math.max(0, l.open - none);
      const labels = g.options.map((x) => ({ name: x.label, n: has(x.label) })).sort(byCount);
      items.push({
        key: `g-${g.id}`, name: g.name, kind: 'custom labels', open: true, empty: 'No labels in this category.',
        extra: coverage(done, l.open, 'labelled', 'warn', `${n(done)} of ${n(l.open)} open issues`),
        summary: labelled(labels),
        action: o.runs && none ? linkBtn(`${o.runs}?what=labels&group=${encodeURIComponent(g.id)}`, `Backfill ${n(none)}`, { size: 'sm', variant: 'secondary', icon: 'history', title: `Add ${g.name} labels to the open tickets and issues that have none` }) : null,
        rows: [...labels.map((x) => row({ ...x, href: gh(x.name) })), row({ name: 'None yet', n: none, href: without(g.options.map((x) => x.label)), none: 'warn' })],
      });
    }
    const flags = flagLabels.map((x) => ({ name: x, n: has(x) })).sort(byCount);
    const rest = others.slice(0, 50);
    items.push(
      { key: 'triage', name: 'From triage', kind: 'its own labels', open: false, empty: 'Triage adds no labels of its own.', summary: labelled(flags), rows: flags.map((x) => row({ ...x, href: gh(x.name) })) },
      { key: 'other', name: 'Your other labels', short: 'Other', kind: 'added by people or ticket types', open: false, empty: 'None.', summary: labelled(rest), rows: rest.map((x) => row({ ...x, href: gh(x.name) })) },
    );

    return html`<section class="card an-card ov-labels" aria-labelledby="ov-labels-h">
      <div class="an-ch"><h2 id="ov-labels-h">Labels on open issues</h2><span class="small muted">${n(l.open)} open issues · as on GitHub now · click a label to see its issues</span>
        ${canOpen(ctx.membership, 'triage.labels') ? html`<span class="ov-ch-a">${linkBtn(areaHref(ctx, 'triage.labels'), 'Custom labels', { size: 'sm', variant: 'ghost', trail: 'arrow-right' })}</span>` : ''}</div>
      ${l.open
        ? groupTable({ name: 'labels', head: ['Label', 'Open issues', 'Share'], items, find: 'Find a label', nothing: 'No label matches.' })
        : html`<p class="small muted ov-none">No open issues${o.app ? ' in this app’s repository' : ''}, or the issue sync hasn’t run yet.</p>`}
    </section>`;
  }

  /**
   * What triage did in the period, a group each: its actions (applied, and suggested ones still
   * waiting in Review), the priority it gave, how sure it was, what it skipped and, for all apps,
   * each app (which opens the page on that app).
   */
  function activityCard(ctx: WorkspaceRequestContext, c: TriageConfig, d: TriageOverview, o: { apps: { id: string; name: string; repo_id: number }[]; picked: string | null; range: (typeof RANGES)[number]; app: (id: string) => string }): SafeHtml {
    const read = d.total;
    const review = canOpen(ctx.membership, 'triage.review') ? areaHref(ctx, 'triage.review') : null;
    const acts = d.actions.filter((a) => a.applied + a.suggested > 0).map((a) => ({ ...a, name: actionTitle(c, a.kind, a.category), n: a.applied + a.suggested }));
    const prio = PRIORITIES.map((p) => ({ p, name: p, n: d.priority[p] ?? 0 }));
    const prioTotal = prio.reduce((t, x) => t + x.n, 0);
    const sure = d.confidence.map((b) => ({ name: b.band, n: b.n }));
    const sureTotal = sure.reduce((t, b) => t + b.n, 0);
    const skipped = d.skipped.map((r) => ({ name: r.reason, n: r.n }));
    const skippedTotal = skipped.reduce((t, r) => t + r.n, 0);
    const byRepo = new Map<number, { id: string; name: string }[]>();
    for (const a of o.apps) byRepo.set(a.repo_id, [...(byRepo.get(a.repo_id) ?? []), a]);
    const perApp = [...byRepo].map(([repo, list]) => ({ id: list[0]!.id, name: list.map((a) => a.name).join(', '), ...(d.byRepo.get(repo) ?? { triaged: 0, applied: 0 }) })).sort((x, y) => y.triaged - x.triaged);
    const plain = (x: { name: string; n: number }, whole: number, cls = 'lt-fill'): TableRow => ({ label: x.name, count: n(x.n), bar: [{ pct: of(x.n, whole), cls }], share: pct(x.n, whole), zero: !x.n });

    const items: TableGroup[] = [
      {
        key: 'actions', name: 'Actions', kind: `of the ${n(read)} read`, open: true, empty: 'Nothing in this period.',
        extra: html`<span class="lt-keys" aria-hidden="true"><i class="lt-key a"></i>applied<i class="lt-key s"></i>waiting in Review</span>`,
        summary: topSummary(acts),
        action: review && d.review ? linkBtn(review, `Review ${n(d.review)}`, { size: 'sm', variant: 'secondary', icon: 'inbox', title: 'Tickets and issues with suggestions waiting for someone' }) : null,
        rows: acts.map((a) => ({
          label: a.name,
          count: html`${n(a.applied)}${a.suggested ? html`<span class="lt-plus" title="Waiting in Review">+${n(a.suggested)}</span>` : ''}`,
          bar: [{ pct: of(a.applied, read), cls: 'lt-fill' }, { pct: of(a.suggested, read), cls: 'lt-wait' }],
          share: pct(a.n, read),
        })),
      },
      {
        key: 'priority', name: 'Priority it gave', short: 'Priority', kind: `of the ${n(prioTotal)} it gave one`, open: true, empty: 'Nothing in this period.',
        summary: topSummary(prio),
        rows: prio.map((x) => ({ ...plain(x, prioTotal), label: html`<span class="lt-prio"><span class="ov-dot ${PRIORITY_TONE[x.p]}"></span>${x.p}</span>` })),
      },
      {
        key: 'sure', name: 'How sure it was', short: 'How sure', kind: `automatic at ${String(c.threshold)}%+`, open: false, empty: 'Nothing in this period.',
        summary: topSummary(sure),
        rows: sure.map((x) => plain(x, sureTotal)),
      },
      {
        key: 'skipped', name: 'Skipped', kind: `${n(skippedTotal)} not triaged`, open: skippedTotal > 0, empty: 'Nothing was skipped in this period.',
        summary: topSummary(skipped),
        rows: skipped.map((x) => plain(x, skippedTotal, 'lt-skip')),
      },
    ];
    if (!o.picked) {
      items.push({
        key: 'apps', name: 'By app', kind: `of the ${n(read)} read · open one to see only it`, open: true, empty: 'No apps yet.',
        summary: topSummary(perApp.map((a) => ({ name: a.name, n: a.triaged })), 'app'),
        rows: perApp.slice(0, 30).map((a) => ({
          ...plain({ name: a.name, n: a.triaged }, read),
          label: html`${a.name}${a.applied ? html`<span class="lt-sub">${n(a.applied)} actions</span>` : ''}`,
          link: { href: o.app(a.id), external: false, aria: `${a.name}: ${n(a.triaged)} read, ${pct(a.triaged, read)}. Show only ${a.name}` },
        })),
      });
    }
    const when = o.range === 'all' ? 'since triage was turned on' : `in the last ${RANGE_NAMES[o.range]}`;
    return html`<section class="card an-card ov-did" aria-labelledby="ov-did-h">
      <div class="an-ch"><h2 id="ov-did-h">What triage did</h2><span class="small muted">${o.picked ? o.apps.find((a) => a.id === o.picked)?.name ?? 'this app' : 'all apps'} · tickets and issues Claude read ${when}</span></div>
      ${read || skippedTotal
        ? groupTable({ name: 'what triage did', head: ['', 'Tickets', 'Share'], items })
        : html`<p class="small muted ov-none">Nothing in this period.</p>`}
    </section>`;
  }
}

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
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { openLabels, openMissing, type OpenLabels } from '../../triage/label-stats.js';
import { triageOverview, type TriageOverview } from '../../triage/overview.js';
import { FLAGS, getTriageSettings, groupKind, PRIORITIES, tokenCost, type LabelGroup, type TriageConfig } from '../../triage/settings.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { empty, labelTag, linkBtn, notice, segLinks, selectWrap } from '../ui.js';
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

interface Bar {
  label: SafeHtml | string;
  n: number;
  href?: string | null;
  /** Shown after the share (a second number, or a link's words). */
  note?: SafeHtml | string;
  tone?: string;
}

/** A list of bars on one scale (the longest is full), each with its count and share of `of`. */
function bars(items: Bar[], o: { of: number; empty: string; max?: number }): SafeHtml {
  const shown = items.slice(0, o.max ?? 50);
  if (!shown.length) return html`<p class="small muted ov-none">${o.empty}</p>`;
  const most = Math.max(1, ...shown.map((b) => b.n));
  return html`<ul class="ov-bars${shown.some((b) => b.note) ? ' wide' : ''}">${shown.map((b) => {
    const inner = html`<span class="ov-bar-l">${b.label}</span>
      <span class="ov-bar-t" aria-hidden="true"><i class="${b.tone ?? ''}" style="width:${String(Math.max(b.n ? 1.5 : 0, (b.n / most) * 100))}%"></i></span>
      <span class="ov-bar-n"><b>${n(b.n)}</b><span class="muted">${pct(b.n, o.of)}</span>${b.note ? html`<span class="ov-bar-x">${b.note}</span>` : ''}</span>`;
    return html`<li>${b.href ? html`<a class="ov-bar" href="${b.href}" target="_blank" rel="noopener noreferrer" title="See them on GitHub">${inner}</a>` : html`<div class="ov-bar">${inner}</div>`}</li>`;
  })}</ul>`;
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
      <div class="an ov" data-an-tz="${tz}">
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
        ${labelsCard(ctx, c, labels, missing, { search, runs, app: picked?.id ?? null })}
        <div class="an-grid ov-grid">
          ${actionsCard(c, d)}
          ${sureCard(c, d)}
          ${skippedCard(d)}
          ${picked ? '' : appsCard(apps, d)}
        </div>
        <p class="small muted an-foot">Labels are what the open issues have on GitHub now, from the issue sync. What triage did counts the tickets and issues it read in the period, ${RANGE_NAMES[range] === 'All' ? 'since it was turned on' : 'by the day it read them'}; “suggested” ones are still waiting in Review. Times are in your time zone (${tz}).</p>
      </div>`;
    return web.render(reply, ctx, 'Overview · AI triage', 'triage', body, { width: 'full' });
  });

  function kpis(ctx: WorkspaceRequestContext, c: TriageConfig, w: Window, d: TriageOverview): SafeHtml {
    const lifetime = w.range.id === 'all';
    const vs = (total: number, prev: number | null, better: Better) => (lifetime ? html`<div class="an-d muted">All time</div>` : delta(total, prev, w.range.compare, better));
    const kind = (k: string) => d.actions.find((a) => a.kind === k);
    const both = (k: string) => (kind(k)?.applied ?? 0) + (kind(k)?.suggested ?? 0);
    const cost = tokenCost(c.model, d.inputTokens, d.outputTokens);
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

  function labelsCard(ctx: WorkspaceRequestContext, c: TriageConfig, l: OpenLabels, missing: Map<string, number>, o: { search: (terms: string) => string; runs: string | null; app: string | null }): SafeHtml {
    const has = (name: string) => l.byLabel.get(name.toLowerCase()) ?? 0;
    const gh = (name: string) => o.search(`label:"${name}"`);
    const prio = PRIORITIES.map((p) => ({ p, name: c.priority.labels[p], n: has(c.priority.labels[p]) }));
    const prioritized = prio.reduce((t, x) => t + x.n, 0);
    const noPriority = Math.max(0, l.open - prioritized);
    const flagLabels = [...new Map(FLAGS.filter((f) => c[f].label.trim()).map((f) => [c[f].label.toLowerCase(), { name: c[f].label, title: FLAG_COPY[f].title }])).values()];
    const known = new Set([...prio.map((x) => x.name.toLowerCase()), ...flagLabels.map((x) => x.name.toLowerCase()), ...c.labelGroups.flatMap((g) => g.options.map((x) => x.label.toLowerCase()))]);
    const others = [...l.byLabel].filter(([k]) => !known.has(k)).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: l.names.get(k) ?? k, n: v }));
    const backfill = (g: LabelGroup) => (o.runs ? `${o.runs}?what=labels&group=${encodeURIComponent(g.id)}` : null);
    const category = (g: LabelGroup) => {
      const none = missing.get(g.id) ?? 0;
      const link = backfill(g);
      return html`<section class="ov-sec" aria-labelledby="ov-g-${g.id}">
        <div class="ov-sec-h"><h3 id="ov-g-${g.id}">${g.name}</h3><span class="xs muted">custom labels</span>${link && none ? linkBtn(link, `Backfill ${n(none)}`, { size: 'sm', variant: 'ghost', icon: 'history', title: `Add ${g.name} labels to the open tickets and issues that have none` }) : ''}</div>
        ${bars([
          ...g.options.map((x) => ({ label: labelTag(x.label), n: has(x.label), href: gh(x.label) })).sort((a, b) => b.n - a.n),
          { label: html`<span class="ov-none-l">None yet</span>`, n: none, href: o.search(g.options.map((x) => `-label:"${x.label}"`).join(' ')), tone: 'none' },
        ], { of: l.open, empty: 'No labels in this category.' })}
      </section>`;
    };
    return html`<section class="card an-card ov-labels" aria-labelledby="ov-labels-h">
      <div class="an-ch"><h2 id="ov-labels-h">Labels on open issues</h2><span class="small muted">${n(l.open)} open issues · as on GitHub now · click a label to see its issues</span>
        ${canOpen(ctx.membership, 'triage.labels') ? html`<span class="ov-ch-a">${linkBtn(areaHref(ctx, 'triage.labels'), 'Custom labels', { size: 'sm', variant: 'ghost', trail: 'arrow-right' })}</span>` : ''}</div>
      ${l.open ? html`
      <div class="ov-prio">
        <div class="ov-prio-h"><h3>Priority</h3><span class="xs muted">${pct(prioritized, l.open)} of open issues have one</span></div>
        <div class="ov-stack" role="img" aria-label="${prio.map((x) => `${x.name}: ${x.n}`).join(', ')}, no priority: ${String(noPriority)}">
          ${prio.map((x) => (x.n ? html`<a class="${PRIORITY_TONE[x.p]}" href="${gh(x.name)}" target="_blank" rel="noopener noreferrer" style="flex-grow:${String(x.n)}" title="${x.name}: ${n(x.n)}"></a>` : ''))}
          ${noPriority ? html`<span class="p-none" style="flex-grow:${String(noPriority)}" title="No priority: ${n(noPriority)}"></span>` : ''}
        </div>
        <ul class="ov-legend">${prio.map((x) => html`<li><i class="${PRIORITY_TONE[x.p]}"></i><a href="${gh(x.name)}" target="_blank" rel="noopener noreferrer">${x.name}</a><b>${n(x.n)}</b><span class="muted">${pct(x.n, l.open)}</span></li>`)}
          <li><i class="p-none"></i><span>No priority</span><b>${n(noPriority)}</b><span class="muted">${pct(noPriority, l.open)}</span></li></ul>
      </div>
      <div class="ov-cols">
        <section class="ov-sec" aria-labelledby="ov-tri-h">
          <div class="ov-sec-h"><h3 id="ov-tri-h">From triage</h3><span class="xs muted">its own labels</span></div>
          ${bars(flagLabels.map((x) => ({ label: html`<span title="${x.title}">${labelTag(x.name)}</span>`, n: has(x.name), href: gh(x.name) })).sort((a, b) => b.n - a.n), { of: l.open, empty: 'Triage adds no labels of its own.' })}
        </section>
        ${c.labelGroups.map(category)}
        ${c.labelGroups.length ? '' : html`<section class="ov-sec ov-empty-cat">${empty('tags', 'No custom labels yet', html`Sort every ticket into your own labels, such as bug, parity or plugins.`, canOpen(ctx.membership, 'triage.labels') ? linkBtn(areaHref(ctx, 'triage.labels'), 'Add custom labels', { size: 'sm', trail: 'arrow-right' }) : null)}</section>`}
        <section class="ov-sec" aria-labelledby="ov-oth-h">
          <div class="ov-sec-h"><h3 id="ov-oth-h">Your other labels</h3><span class="xs muted">added by people or ticket types</span></div>
          ${bars(others.map((x) => ({ label: labelTag(x.name), n: x.n, href: gh(x.name) })), { of: l.open, empty: 'None.', max: 15 })}
        </section>
      </div>` : html`<p class="small muted ov-none">No open issues${o.app ? ' in this app’s repository' : ''}, or the issue sync hasn’t run yet.</p>`}
    </section>`;
  }

  function actionsCard(c: TriageConfig, d: TriageOverview): SafeHtml {
    const rows = d.actions.filter((a) => a.applied + a.suggested > 0);
    const most = Math.max(1, ...rows.map((a) => a.applied + a.suggested));
    return html`<section class="card an-card" aria-labelledby="ov-act-h">
      <div class="an-ch"><h2 id="ov-act-h">What triage did</h2><span class="small muted"><span class="ov-key a"></span>applied <span class="ov-key s"></span>suggested</span></div>
      ${rows.length
        ? html`<ul class="ov-bars two">${rows.map((a) => html`<li><div class="ov-bar">
            <span class="ov-bar-l">${actionTitle(c, a.kind, a.category)}</span>
            <span class="ov-bar-t" aria-hidden="true"><i class="a" style="width:${String((a.applied / most) * 100)}%"></i><i class="s" style="width:${String((a.suggested / most) * 100)}%"></i></span>
            <span class="ov-bar-n"><b>${n(a.applied)}</b>${a.suggested ? html`<span class="muted">+${n(a.suggested)}</span>` : ''}</span>
          </div></li>`)}</ul>`
        : html`<p class="small muted ov-none">Nothing in this period.</p>`}
    </section>`;
  }

  function sureCard(c: TriageConfig, d: TriageOverview): SafeHtml {
    const total = d.confidence.reduce((t, b) => t + b.n, 0);
    const prio = PRIORITIES.map((p) => ({ p, n: d.priority[p] ?? 0 }));
    const read = prio.reduce((t, x) => t + x.n, 0);
    return html`<section class="card an-card" aria-labelledby="ov-sure-h">
      <div class="an-ch"><h2 id="ov-sure-h">Priority Claude gave</h2><span class="small muted">automatic at ${String(c.threshold)}%+</span></div>
      ${read
        ? html`${bars(prio.map((x) => ({ label: html`<span class="ov-dot ${PRIORITY_TONE[x.p]}"></span>${x.p}`, n: x.n, tone: PRIORITY_TONE[x.p] })), { of: read, empty: '' })}
          <h3 class="ov-sub">How sure it was</h3>
          ${bars(d.confidence.map((b) => ({ label: b.band, n: b.n, tone: 'conf' })), { of: total, empty: '' })}`
        : html`<p class="small muted ov-none">Nothing in this period.</p>`}
    </section>`;
  }

  function skippedCard(d: TriageOverview): SafeHtml {
    const total = d.skipped.reduce((t, r) => t + r.n, 0);
    return html`<section class="card an-card" aria-labelledby="ov-skip-h">
      <div class="an-ch"><h2 id="ov-skip-h">Skipped</h2><span class="small muted">${n(total)} not triaged</span></div>
      ${bars(d.skipped.map((r) => ({ label: r.reason, n: r.n, tone: 'skip' })), { of: total, empty: 'Nothing was skipped in this period.' })}
    </section>`;
  }

  function appsCard(apps: { id: string; name: string; repo_id: number }[], d: TriageOverview): SafeHtml {
    const byRepo = new Map<number, string[]>();
    for (const a of apps) byRepo.set(a.repo_id, [...(byRepo.get(a.repo_id) ?? []), a.name]);
    const rows = [...byRepo].map(([repo, names]) => ({ name: names.join(', '), ...(d.byRepo.get(repo) ?? { triaged: 0, applied: 0 }) })).sort((a, b) => b.triaged - a.triaged);
    return html`<section class="card an-card" aria-labelledby="ov-apps-h">
      <div class="an-ch"><h2 id="ov-apps-h">By app</h2><span class="small muted">read in this period</span></div>
      ${bars(rows.map((r) => ({ label: r.name, n: r.triaged, note: r.applied ? `${n(r.applied)} actions` : undefined })), { of: d.total, empty: 'Nothing in this period.', max: 30 })}
    </section>`;
  }
}


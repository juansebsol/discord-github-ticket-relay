import { readFileSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { APP_ROOT } from '../../config.js';
import { getFileSettings } from '../../domain/files.js';
import { getDevMode, setDevMode } from '../../domain/dev-mode.js';
import { can } from '../../domain/permissions.js';
import { healthView, samplesSince, type ProcessRole, type ProcessRow, type Sample } from '../../domain/health.js';
import { indexStatus } from '../../domain/issue-index.js';
import { listApps } from '../../domain/store.js';
import { userNames } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { autoChecked, getTriageSettings, pauseMessage } from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, linkBtn, notice, pageHeader, pill, plural, switchInput, tag, timeAgo, viewOnlyTag, when, type IconName, type Tone } from '../ui.js';
import { keyPill, keyStatus } from './claude.js';
import { areaHref, canOpen, toolHref, viewOnlyText } from './tool.js';

const ROLE_NAMES: Record<ProcessRole, string> = { web: 'Web (console and Discord)', worker: 'Filing worker', triage: 'Triage and issue sync' };
const ROLE_CLASS: Record<ProcessRole, string> = { web: 's-web', worker: 's-worker', triage: 's-triage' };
const LIVE_MS = 15_000;
const MB = 1048576;
const GB = 1073741824;

const APP_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
})();

function mb(n: number): string {
  return `${Math.round(n / MB)} MB`;
}
function gb(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : mb(n);
}
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

// ---- Charts (plain SVG, styled by CSS tokens) ------------------------------------------------

type Point = [number, number];

function linePath(points: Point[], from: number, to: number, maxY: number, w: number, h: number): string {
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * w;
  const y = (v: number) => h - (Math.min(v, maxY) / Math.max(1e-9, maxY)) * h;
  return points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
}

function sparkline(points: Point[], o: { maxY: number; cls: string; label: string }): SafeHtml {
  if (points.length < 2) return html`<span class="spark empty" aria-hidden="true"></span>`;
  const from = points[0]![0];
  const to = points.at(-1)![0];
  return html`<svg class="spark" viewBox="0 0 120 28" aria-label="${o.label}" role="img"><path class="${o.cls}" d="${linePath(points, from, to, o.maxY, 120, 26)}" transform="translate(0 1)"/></svg>`;
}

/** A line chart over the last 24 hours with a few labelled gridlines. */
function lineChart(series: { label: string; cls: string; points: Point[] }[], o: { maxY: number; unit: (v: number) => string; limit?: { value: number; label: string } }): SafeHtml {
  const W = 600;
  const H = 150;
  const to = Date.now();
  const from = to - 86_400_000;
  const grid = [0, 0.5, 1].map((f) => ({ v: o.maxY * f, y: H - f * H }));
  const ticks = [{ t: from, l: '24 h ago' }, { t: from + 43_200_000, l: '12 h ago' }, { t: to, l: 'now' }];
  const drawn = series.filter((s) => s.points.length > 1);
  return html`<figure class="chart">
    <svg viewBox="-48 -8 ${String(W + 56)} ${String(H + 28)}" role="img" aria-label="${series.map((s) => s.label).join(', ')} over the last 24 hours">
      ${grid.map((g) => html`<line class="grid" x1="0" x2="${String(W)}" y1="${g.y.toFixed(1)}" y2="${g.y.toFixed(1)}"/><text class="axis" x="-8" y="${(g.y + 4).toFixed(1)}" text-anchor="end">${o.unit(g.v)}</text>`)}
      ${o.limit && o.limit.value <= o.maxY ? html`<line class="limit" x1="0" x2="${String(W)}" y1="${(H - (o.limit.value / o.maxY) * H).toFixed(1)}" y2="${(H - (o.limit.value / o.maxY) * H).toFixed(1)}"/><text class="axis" x="${String(W - 4)}" y="${(H - (o.limit.value / o.maxY) * H - 5).toFixed(1)}" text-anchor="end">${o.limit.label}</text>` : ''}
      ${drawn.map((s) => html`<path class="${s.cls}" d="${linePath(s.points, from, to, o.maxY, W, H)}"/>`)}
      ${ticks.map((t, i) => html`<text class="axis" x="${(((t.t - from) / (to - from)) * W).toFixed(1)}" y="${String(H + 18)}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${t.l}</text>`)}
    </svg>
    <figcaption class="legend">${drawn.length ? series.map((s) => html`<span><span class="key ${s.cls}"></span>${s.label}</span>`) : html`<span class="muted">Not enough history yet. Charts fill in as the processes report.</span>`}</figcaption>
  </figure>`;
}

/** Averages each process's samples into 5-minute buckets, then adds up the processes of a role. */
function bucketed(samples: Sample[], pick: (s: Sample) => number | null, by: (s: Sample) => string): Map<string, Point[]> {
  const STEP = 300_000;
  const perProcess = new Map<string, Map<number, { sum: number; n: number }>>();
  for (const s of samples) {
    const v = pick(s);
    if (v === null) continue;
    const k = `${by(s)}|${s.process_id}`;
    const b = Math.floor(s.at.getTime() / STEP) * STEP;
    const m = perProcess.get(k) ?? new Map();
    const cell = m.get(b) ?? { sum: 0, n: 0 };
    cell.sum += v;
    cell.n++;
    m.set(b, cell);
    perProcess.set(k, m);
  }
  const out = new Map<string, Map<number, number>>();
  for (const [k, m] of perProcess) {
    const group = k.split('|')[0]!;
    const g = out.get(group) ?? new Map<number, number>();
    for (const [b, c] of m) g.set(b, (g.get(b) ?? 0) + c.sum / c.n);
    out.set(group, g);
  }
  return new Map([...out].map(([k, g]) => [k, [...g.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => [t + STEP / 2, v] as Point)]));
}

/** Averages all samples into 5-minute buckets (for values that are the same for every process, like the server's memory). */
function averaged(samples: Sample[], pick: (s: Sample) => number | null): Point[] {
  const STEP = 300_000;
  const m = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    const v = pick(s);
    if (v === null) continue;
    const b = Math.floor(s.at.getTime() / STEP) * STEP;
    const c = m.get(b) ?? { sum: 0, n: 0 };
    c.sum += v;
    c.n++;
    m.set(b, c);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, c]) => [t + STEP / 2, c.sum / c.n] as Point);
}

// ---- Gathering -------------------------------------------------------------------------------

/** Where this person can go from here (moderators may see this page without the others): the page's address, or null when they can't open it. */
interface Links {
  triage: string | null;
  /** AI triage › Actions, where a paused triage is tried again. */
  triageActions: string | null;
  /** Whether they can press Try again there (Edit on Actions). */
  triageRetry: boolean;
  settings: boolean;
  files: boolean;
  sync: string | null;
  /** Whether they can switch Dev mode (Edit on Server health), so its notice speaks to them. */
  devMode: boolean;
}

function linksFor(ctx: WorkspaceRequestContext): Links {
  const manage = can(ctx.membership, 'manage');
  return {
    triage: toolHref(ctx, 'triage'),
    triageActions: canOpen(ctx.membership, 'triage.actions') ? areaHref(ctx, 'triage.actions') : null,
    triageRetry: can(ctx.membership, 'triage.actions.edit'),
    settings: manage,
    files: can(ctx.membership, 'files.view'),
    sync: canOpen(ctx.membership, 'issues-sync') ? areaHref(ctx, 'issues-sync') : null,
    devMode: can(ctx.membership, 'health.edit'),
  };
}

/** A row that links somewhere only if the viewer can open that page. */
function line(href: string | null, inner: SafeHtml): SafeHtml {
  return href ? html`<a class="line" href="${href}">${inner}</a>` : html`<div class="line">${inner}</div>`;
}

interface Alert {
  tone: 'warn' | 'danger';
  title: string;
  text: string;
  action?: { href: string; label: string };
}

async function gather(web: Web, ctx: WorkspaceRequestContext) {
  const { deps } = web;
  const wid = ctx.workspace.id;
  const dataDir = path.dirname(deps.config.databasePath);
  const dev = await getDevMode(deps.db);
  const [h, samples, disk, dbFile, walFile, files, filing, filedDay, failedDay, triage, triageCounts, apps, cleanup, claude] = await Promise.all([
    healthView(deps.db, dev),
    samplesSince(deps.db, 86_400_000),
    statfs(dataDir).then((s) => ({ total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) })).catch(() => null),
    stat(deps.config.databasePath).then((s) => s.size).catch(() => 0),
    stat(`${deps.config.databasePath}-wal`).then((s) => s.size).catch(() => 0),
    deps.db.query<{ bytes: number; n: number }>(`SELECT coalesce(sum(size), 0) AS bytes, count(*) AS n FROM ticket_files WHERE status = 'stored'`).then((r) => r.rows[0]!),
    deps.db.query<{ status: string; n: number; oldest: number | null }>(
      `SELECT status, count(*) AS n, min(created_at) AS oldest FROM submissions WHERE workspace_id = $1 AND status IN ('pending', 'processing', 'uncertain', 'failed') GROUP BY status`,
      [wid],
    ).then((r) => r.rows),
    deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM submissions WHERE workspace_id = $1 AND status = 'created' AND completed_at > now_ms() - 86400000`, [wid]).then((r) => r.rows[0]!.n),
    deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM submissions WHERE workspace_id = $1 AND status = 'failed' AND updated_at > now_ms() - 86400000`, [wid]).then((r) => r.rows[0]!.n),
    getTriageSettings(deps.db, wid),
    deps.db.query<{ status: string; n: number }>(
      `SELECT status, count(*) AS n FROM triage_results WHERE workspace_id = $1 AND (status = 'pending' OR updated_at > now_ms() - 86400000) GROUP BY status`,
      [wid],
    ).then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n])) as Record<string, number>),
    listApps(deps.db, wid),
    getFileSettings(deps.db, wid),
    keyStatus(web, wid, { live: false }),
  ]);
  const [repos, names] = await Promise.all([indexStatus(deps.db, [...new Set(apps.map((a) => a.repo_id))]), userNames(deps.db, [dev.by])]);
  const github = h.running.map((p) => p.stats?.github).filter((g): g is NonNullable<typeof g> => Boolean(g)).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  const count = (s: string) => filing.find((f) => f.status === s)?.n ?? 0;
  const oldestQueued = filing.filter((f) => f.status === 'pending' || f.status === 'processing').map((f) => f.oldest).filter((n): n is number => n !== null).sort()[0] ?? null;
  return { dev: { ...dev, byName: dev.by ? names.get(dev.by) ?? null : null }, h, samples, disk, dbBytes: dbFile + walFile, files, filing: { queued: count('pending') + count('processing'), unconfirmed: count('uncertain'), failed: count('failed'), failedDay, filedDay, oldestQueued }, triage, triageCounts, repos, cleanup, claude, github };
}

type Data = Awaited<ReturnType<typeof gather>>;

function alertsFor(d: Data, base: string, links: Links): Alert[] {
  const out: Alert[] = [];
  const h = d.h;
  for (const m of h.missing) {
    out.push({ tone: 'danger', title: `${ROLE_NAMES[m.role]} isn’t running`, text: `It last reported ${timeAgo(m.lastSeen)}. ${m.role === 'worker' ? 'Tickets are accepted but not filed until it runs again.' : m.role === 'triage' ? 'Tickets are still filed; triage and the issue sync wait.' : ''} Check pm2 status on the server.` });
  }
  for (const p of h.running) {
    if (!p.limit_mb) continue;
    const share = p.rss_bytes / (p.limit_mb * MB);
    if (share >= 0.8) out.push({ tone: share >= 0.95 ? 'danger' : 'warn', title: `${ROLE_NAMES[p.role]} is at ${Math.round(share * 100)}% of its memory limit`, text: 'If it reaches the limit, PM2 restarts it (work resumes on its own). Raise max_memory_restart and MEMORY_LIMIT_MB together in ecosystem.config.cjs if this keeps happening.' });
    if ((p.stats?.lagP99Ms ?? 0) > 250) out.push({ tone: 'warn', title: `${ROLE_NAMES[p.role]} is slow to respond`, text: `Work waits up to ${Math.round(p.stats!.lagP99Ms)} ms before it runs. The server may be overloaded.` });
  }
  for (const role of ['web', 'worker', 'triage'] as ProcessRole[]) {
    if (h.restarts[role] >= 3) out.push({ tone: 'warn', title: `${ROLE_NAMES[role]} restarted ${h.restarts[role]} times in 24 hours`, text: links.devMode ? 'If these were deploys, turn on Dev mode while you deploy so they aren’t counted. Otherwise check pm2 logs for crashes.' : 'Check pm2 logs for crashes.' });
  }
  if (h.host && (h.host.available < 300 * MB || h.host.available / h.host.total < 0.15)) out.push({ tone: 'warn', title: 'The server is low on memory', text: `${gb(h.host.available)} of ${gb(h.host.total)} available.` });
  // Space left matters, not the percentage: 27 GB free on a big disk is fine.
  if (d.disk && (d.disk.free < 3 * GB || (d.disk.free < 10 * GB && d.disk.free / d.disk.total < 0.05))) out.push({ tone: d.disk.free < GB ? 'danger' : 'warn', title: 'The disk is almost full', text: `${gb(d.disk.free)} free of ${gb(d.disk.total)}. New attachments stop being saved below 1 GB.`, action: links.files ? { href: `${base}/tickets/files`, label: 'Clean up files' } : undefined });
  if (d.filing.failedDay) out.push({ tone: 'warn', title: `${plural(d.filing.failedDay, 'ticket')} couldn’t be filed in the last 24 hours`, text: 'They’re waiting in the inbox for someone to retry or close them.', action: { href: `${base}/tickets?status=attention`, label: 'Open inbox' } });
  if (d.filing.oldestQueued && Date.now() - d.filing.oldestQueued > 15 * 60_000) out.push({ tone: 'warn', title: 'Tickets are waiting to be filed', text: `The oldest has been queued since ${timeAgo(new Date(d.filing.oldestQueued))}. GitHub may be unavailable; they’re retried automatically.` });
  if ((d.triage.enabled || d.triage.githubEnabled) && d.triage.paused) {
    const p = d.triage.paused;
    const href = links.triageActions ?? links.triage;
    out.push({ tone: 'warn', title: 'AI triage is paused', text: `${pauseMessage(p.reason, p.detail, d.triage.config.model)} Tickets are still filed.${autoChecked(p) ? '' : links.triageRetry ? ' Press Try again in AI triage › Actions once it’s fixed.' : ' Once it’s fixed, someone with Edit on AI triage › Actions can press Try again.'}`, action: href ? { href, label: 'Open AI triage' } : undefined });
  }
  if (d.claude.state === 'rejected' || d.claude.state === 'credits') out.push({ tone: d.claude.state === 'rejected' ? 'danger' : 'warn', title: d.claude.state === 'rejected' ? 'Claude rejected the API key' : 'The Anthropic account is out of credits', text: 'Features that use Claude are paused. Tickets are still filed.', action: links.settings ? { href: `${base}/settings#claude`, label: 'Open Settings' } : undefined });
  for (const r of d.repos) if (r.status === 'error') out.push({ tone: 'warn', title: `Issue sync problem for ${r.owner}/${r.name}`, text: r.last_error ?? 'GitHub couldn’t be reached.', action: links.sync ? { href: links.sync, label: 'Open Sync' } : undefined });
  if (d.github && d.github.remaining / d.github.limit < 0.1) out.push({ tone: 'warn', title: 'GitHub API requests are running low', text: `${d.github.remaining} of ${d.github.limit} left until ${new Date(d.github.resetAt).toISOString().slice(11, 16)} UTC. Work slows down until then.` });
  return out;
}

// ---- Rendering -------------------------------------------------------------------------------

function meter(value: number, max: number, o: { warnAt?: number; label: string }): SafeHtml {
  const share = max ? value / max : 0;
  return html`<progress class="bar${share >= (o.warnAt ?? 0.8) ? ' warn' : ''}" value="${String(Math.min(value, max))}" max="${String(max)}" aria-label="${o.label}"></progress>`;
}

function tile(o: { icon: IconName; label: string; value: string; sub: SafeHtml | string; bar?: SafeHtml }): SafeHtml {
  return html`<div class="stat"><div class="l">${icon(o.icon, 14)}${o.label}</div><div class="v">${o.value}</div>${o.bar ?? ''}<div class="sub">${o.sub}</div></div>`;
}

function processRows(d: Data): SafeHtml {
  const since = Date.now() - 2 * 3_600_000;
  const recent = d.samples.filter((s) => s.at.getTime() >= since);
  const byProcess = (id: string, pick: (s: Sample) => number | null) => recent.filter((s) => s.process_id === id).map((s) => [s.at.getTime(), pick(s)] as [number, number | null]).filter((p): p is Point => p[1] !== null);
  const rows = d.h.running.map((p: ProcessRow) => {
    const limit = p.limit_mb ? p.limit_mb * MB : null;
    const cpu = p.stats?.cpuPct ?? 0;
    const lag = p.stats?.lagP99Ms ?? 0;
    return html`<tr>
      <td><div class="who-cell"><span class="key ${ROLE_CLASS[p.role]}" aria-hidden="true"></span><div><div class="cell-title">${ROLE_NAMES[p.role] ?? p.role}</div><div class="sub mono">PID ${String(p.pid)}${p.stats?.node ? ` · Node ${p.stats.node}` : ''}</div></div></div></td>
      <td><div class="meter-cell">${limit ? meter(p.rss_bytes, limit, { label: 'Memory used' }) : ''}<span class="small">${mb(p.rss_bytes)}${limit ? html`<span class="muted"> of ${String(p.limit_mb)} MB</span>` : html`<span class="muted"> · no limit set</span>`}</span></div></td>
      <td>${sparkline(byProcess(p.id, (s) => s.rss_bytes / MB), { maxY: p.limit_mb ?? Math.max(...recent.filter((s) => s.process_id === p.id).map((s) => s.rss_bytes / MB), 1), cls: ROLE_CLASS[p.role], label: 'Memory over the last 2 hours' })}</td>
      <td class="num"><span class="small">${cpu.toFixed(1)}%</span>${sparkline(byProcess(p.id, (s) => s.cpu_pct), { maxY: 100, cls: ROLE_CLASS[p.role], label: 'CPU over the last 2 hours' })}</td>
      <td class="num"><span class="small ${lag > 250 ? 'warn-text' : ''}">${lag < 1 ? '<1' : String(Math.round(lag))} ms</span></td>
      <td class="num">${when(p.started_at)}</td>
      <td class="num">${d.h.restarts[p.role] > 3 ? html`<span class="warn-text">${String(d.h.restarts[p.role])}</span>` : String(d.h.restarts[p.role])}${d.h.uncounted[p.role] ? html`<div class="sub" title="Restarts while dev mode was on, or before it was last turned off">+${String(d.h.uncounted[p.role])} in dev mode</div>` : ''}</td></tr>`;
  });
  const stopped = d.h.missing.map((m) => html`<tr class="off-row"><td><div class="who-cell"><span class="key ${ROLE_CLASS[m.role]}" aria-hidden="true"></span><div><div class="cell-title">${ROLE_NAMES[m.role]}</div><div class="sub">Not reporting</div></div></div></td>
    <td colspan="6">${pill('Stopped', 'danger')} <span class="small muted">Last report ${timeAgo(m.lastSeen)}</span></td></tr>`);
  return html`${rows}${stopped}`;
}

/** While dev mode is on: what it does, since when, and what it has left out so far. */
function devNotice(d: Data, canSwitch: boolean): SafeHtml {
  const left = d.h.uncounted.web + d.h.uncounted.worker + d.h.uncounted.triage;
  const since = `Turned on ${timeAgo(d.dev.since!)}${d.dev.byName ? ` by ${d.dev.byName}` : ''}.`;
  return notice('info', 'Dev mode is on', canSwitch
    ? `Restarts aren’t counted while you deploy${left ? ` (${plural(left, 'restart')} so far)` : ''}. ${since} Turn it off when you’re done, and counting starts again from zero.`
    : `Restarts aren’t counted while someone deploys${left ? ` (${plural(left, 'restart')} so far)` : ''}. ${since} Counting starts again from zero when it’s turned off.`, { icon: 'wrench' });
}

function liveBody(d: Data, base: string, links: Links): SafeHtml {
  const alerts = alertsFor(d, base, links);
  const worst: Tone = alerts.some((a) => a.tone === 'danger') ? 'danger' : alerts.length ? 'warn' : 'ok';
  const h = d.h;
  const load = os.loadavg();
  const cores = os.cpus().length || 1;
  const loadShare = load[0]! / cores;
  const roleSeries = (pick: (s: Sample) => number | null) => {
    const b = bucketed(d.samples, pick, (s) => s.role);
    return (['web', 'worker', 'triage'] as ProcessRole[]).map((r) => ({ label: r === 'worker' ? 'Filing workers' : ROLE_NAMES[r].split(' (')[0]!, cls: ROLE_CLASS[r], points: b.get(r) ?? [] }));
  };
  const memSeries = roleSeries((s) => s.rss_bytes / MB);
  const hostPoints = averaged(d.samples, (s) => (h.host && s.host_available_bytes !== null ? (h.host.total - s.host_available_bytes) / GB : null));
  const maxProcMb = Math.max(256, ...h.running.map((p) => p.limit_mb ?? 0), ...memSeries.flatMap((s) => s.points.map((p) => p[1])));
  // Filing workers and triage usually share one limit; show it as a line when they do.
  const sharedLimits = [...new Set(h.running.filter((p) => p.role !== 'web' && p.limit_mb).map((p) => p.limit_mb!))];
  const limitLine = sharedLimits.length === 1 ? { value: sharedLimits[0]!, label: `${sharedLimits[0]} MB limit (workers, triage)` } : undefined;
  const queued = d.filing.queued + d.filing.unconfirmed;
  const triageState = !d.triage.enabled ? pill('Off', 'neutral') : d.triage.paused ? pill('Paused', 'warn') : pill('On', 'ok');
  const syncReady = d.repos.filter((r) => r.status === 'ready').length;
  const lastSync = d.repos.map((r) => r.last_synced_at).filter((x): x is Date => Boolean(x)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  return html`
    <div class="card">
      <div class="card-h"><div><div class="title"><h2>Status</h2>${worst === 'ok' ? pill('All good', 'ok') : worst === 'warn' ? pill(plural(alerts.length, 'thing') + ' to check', 'warn') : pill('Needs attention', 'danger')}</div>
        <div class="desc">${worst === 'ok' ? 'Every process is running and within its limits. Nothing needs your attention.' : 'Here’s what needs a look, most important first.'}</div></div></div>
      ${alerts.length || d.dev.on ? html`<div class="card-b alerts">${d.dev.on ? devNotice(d, links.devMode) : ''}${alerts.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1)).map((a) => notice(a.tone, a.title, a.text, { action: a.action ? linkBtn(a.action.href, a.action.label, { size: 'sm' }) : null }))}</div>` : ''}
      <div class="stats four">
        ${tile({ icon: 'memory-stick', label: 'Memory', value: h.host ? `${gb(h.host.total - h.host.available)} used` : '—', sub: h.host ? `${gb(h.host.available)} available of ${gb(h.host.total)}` : 'Waiting for the first report', bar: h.host ? meter(h.host.total - h.host.available, h.host.total, { warnAt: 0.85, label: 'Server memory used' }) : undefined })}
        ${tile({ icon: 'cpu', label: 'CPU load', value: `${Math.round(loadShare * 100)}%`, sub: `${load.map((l) => l.toFixed(2)).join(' · ')} over 1, 5, 15 min · ${plural(cores, 'core')}`, bar: meter(Math.min(load[0]!, cores), cores, { warnAt: 0.9, label: 'CPU load' }) })}
        ${tile({ icon: 'hard-drive', label: 'Disk', value: d.disk ? `${gb(d.disk.free)} free` : '—', sub: d.disk ? `of ${gb(d.disk.total)} · data folder` : 'Couldn’t read the disk', bar: d.disk ? meter(d.disk.total - d.disk.free, d.disk.total, { warnAt: d.disk.free < 3 * GB ? 0 : 1.01, label: 'Disk used' }) : undefined })}
        ${tile({ icon: 'timer', label: 'Uptime', value: duration(os.uptime()), sub: `Server · Ticket Relay ${APP_VERSION ? `v${APP_VERSION}` : ''}` })}
      </div>
    </div>

    <div class="card">
      <div class="card-h"><div><h2>Processes</h2><div class="desc">Each PM2 process reports every 30 seconds. PM2 restarts a process that goes over its memory limit; its work picks up where it stopped.</div></div></div>
      ${h.running.length || h.missing.length
        ? html`<div class="table-wrap wide"><table>
            <thead><tr><th>Process</th><th>Memory</th><th>Last 2 h</th><th class="num">CPU</th><th class="num" title="How long work waits before it runs (99th percentile). Under 50 ms is good.">Delay</th><th class="num">Running since</th><th class="num">Restarts (24 h)</th></tr></thead>
            <tbody>${processRows(d)}</tbody></table></div>
          <div class="card-note">Delay is how long work waits before it runs; under 50 ms is good. Restarts include deploys (pm2 reload), except while Dev mode is on.</div>`
        : html`<div class="card-b"><p class="small muted">No process has reported yet. Reports start within a minute of the processes running this version.</p></div>`}
    </div>

    <div class="card">
      <div class="card-h"><div><h2>Memory over the last 24 hours</h2><div class="desc">Averaged every 5 minutes.</div></div></div>
      <div class="card-b charts">
        <div><h3 class="chart-h">Server</h3>${lineChart([{ label: 'Used', cls: 's-host', points: hostPoints }], { maxY: h.host ? h.host.total / GB : 1, unit: (v) => `${v.toFixed(1)} GB` })}</div>
        <div><h3 class="chart-h">Processes</h3>${lineChart(memSeries, { maxY: maxProcMb, unit: (v) => `${Math.round(v)} MB`, limit: limitLine })}</div>
      </div>
    </div>

    <div class="g2">
      <div class="card">
        <div class="card-h"><div><h2>Background work</h2><div class="desc">This workspace.</div></div></div>
        <div class="line"><span class="tile">${icon('send')}</span><div class="grow"><div class="name">Filing</div><div class="sub">${plural(d.filing.filedDay, 'ticket')} filed in 24 h${queued ? ` · ${String(queued)} waiting` : ''}${d.filing.failed ? ` · ${String(d.filing.failed)} need attention` : ''}</div></div>
          ${d.filing.failed ? pill('Needs attention', 'warn') : queued ? pill('Working', 'neutral') : pill('Up to date', 'ok')}</div>
        ${line(links.triage, html`<span class="tile">${icon('bot')}</span><div class="grow"><div class="name">AI triage</div><div class="sub">${plural(d.triageCounts.done ?? 0, 'ticket')} triaged in 24 h${d.triageCounts.pending ? ` · ${String(d.triageCounts.pending)} waiting` : ''}${d.triageCounts.failed ? ` · ${String(d.triageCounts.failed)} failed` : ''}</div></div>${triageState}`)}
        ${line(links.sync, html`<span class="tile">${icon('database')}</span><div class="grow"><div class="name">Issue sync</div><div class="sub">${d.repos.length ? `${syncReady} of ${plural(d.repos.length, 'repository', 'repositories')} up to date${lastSync ? ` · oldest sync ${timeAgo(lastSync)}` : ''}` : 'No repositories yet'}</div></div>
          ${d.repos.some((r) => r.status === 'error') ? pill('Problem', 'warn') : d.repos.some((r) => r.status === 'loading') ? pill('Loading', 'neutral') : d.repos.length ? pill('Up to date', 'ok') : ''}`)}
        ${line(links.files ? `${base}/tickets/files#rules` : null, html`<span class="tile">${icon('paperclip')}</span><div class="grow"><div class="name">File cleanup</div><div class="sub">${d.cleanup.auto_cleanup ? (d.cleanup.last_run_at ? `Last run ${timeAgo(d.cleanup.last_run_at)}` : 'Runs within a day') : 'Automatic cleanup is off'}</div></div>${d.cleanup.auto_cleanup ? pill('On', 'ok') : pill('Off', 'neutral')}`)}
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Services and storage</h2><div class="desc">The whole server.</div></div></div>
        <div class="line"><span class="tile">${icon('github')}</span><div class="grow"><div class="name">GitHub API</div><div class="sub">${d.github ? `${d.github.remaining.toLocaleString('en-US')} of ${d.github.limit.toLocaleString('en-US')} requests left · resets ${timeAgo(new Date(d.github.resetAt))}` : 'No requests seen yet'}</div></div>
          ${d.github ? meter(d.github.limit - d.github.remaining, d.github.limit, { warnAt: 0.9, label: 'GitHub API requests used' }) : ''}</div>
        ${line(links.settings ? `${base}/settings#claude` : null, html`<span class="tile">${icon('sparkles')}</span><div class="grow"><div class="name">Claude API</div><div class="sub">${d.claude.checkedAt ? `Checked ${timeAgo(d.claude.checkedAt)}` : d.claude.state === 'missing' ? 'No key yet' : 'Not checked yet'}</div></div>${keyPill(d.claude)}`)}
        <div class="line"><span class="tile">${icon('database')}</span><div class="grow"><div class="name">Database</div><div class="sub">${gb(d.dbBytes)} · SQLite</div></div></div>
        ${line(links.files ? `${base}/tickets/files` : null, html`<span class="tile">${icon('paperclip')}</span><div class="grow"><div class="name">Attachments</div><div class="sub">${plural(d.files.n, 'file')} · ${gb(d.files.bytes)}</div></div>`)}
      </div>
    </div>`;
}

export function registerHealthRoutes(app: FastifyInstance, web: Web): void {
  app.get('/w/:wid/health', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'health.view' });
    if (!ctx) return reply;
    const d = await gather(web, ctx);
    const links = linksFor(ctx);
    if ((req.query as { partial?: string }).partial === '1') {
      return reply.header('x-health-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(liveBody(d, ctx.base, links).toString());
    }
    // Dev mode is for the whole server: people with Edit switch it, everyone who can see this page sees when it's on.
    const edit = links.devMode;
    const devControl = edit
      ? html`<form method="post" action="${ctx.base}/health/dev-mode" class="inline-form dev-switch" data-async data-dev-mode data-live-refresh>${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          <label for="dev-mode" title="While it’s on, restarts (deploys) aren’t counted as problems">${icon('wrench', 14)}Dev mode</label>${switchInput({ name: 'on', checked: d.dev.on, label: 'Dev mode', id: 'dev-mode' })}<button type="submit" class="btn sm nojs">Save</button></form>`
      : d.dev.on ? tag('Dev mode on', { icon: 'wrench', title: `Restarts aren’t counted while someone deploys. Turned on ${timeAgo(d.dev.since!)}${d.dev.byName ? ` by ${d.dev.byName}` : ''}.` }) : '';
    const body = html`
      ${pageHeader({
        title: 'Server health',
        after: edit ? undefined : viewOnlyTag(viewOnlyText('health')),
        description: edit ? 'How the server and its processes are doing right now. Turn on Dev mode while you deploy, so restarts aren’t counted as problems.' : 'How the server and its processes are doing right now.',
        actions: html`${devControl}<span class="live" data-live-status>${raw('<span class="pulse" aria-hidden="true"></span>')}<span class="t">Live · updates every 15 s</span></span>`,
      })}
      <div class="stack" id="health-live" data-live="${String(LIVE_MS)}" data-live-src="${ctx.base}/health?partial=1">${liveBody(d, ctx.base, links)}</div>`;
    return web.render(reply, ctx, 'Server health', 'health', body);
  });

  /** Dev mode on or off (JSON from the switch, or a plain form without JavaScript). */
  app.post('/w/:wid/health/dev-mode', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'health.edit' });
    if (!ctx) return reply;
    const dev = await setDevMode(web.deps.db, (req.body as { on?: string }).on !== undefined, ctx.user.id);
    const message = dev.on ? 'Dev mode is on: restarts aren’t counted until you turn it off.' : 'Dev mode is off: restarts are counted again, starting from zero.';
    if (web.wantsJson(req)) return reply.send({ ok: true, message, on: dev.on });
    setFlash(reply, 'success', message);
    return reply.redirect(`${ctx.base}/health`);
  });
}


/**
 * Triage › Activity: what triage is doing right now (queues, what it's working on, waits) and a
 * log of everything it did: triaged, applied, suggested, dismissed, skipped or failed, and why.
 * Updates live while the page is open.
 */
import type { FastifyInstance } from 'fastify';
import { can } from '../../domain/permissions.js';
import { userNames } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { LOG_DAYS, type ActivityNow, type LogResult, type LogRow, type LogSource, type TriageAction } from '../../triage/engine.js';
import { getTriageSettings, monthlyUsage, pauseMessage } from '../../triage/settings.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { actionEffectsShort, actionTitle } from '../triage-view.js';
import { empty, formatDate, icon, linkBtn, notice, plural, segLinks, selectWrap, tag, timeAgo, type IconName } from '../ui.js';
import { canTriage, ticketsHeader } from './tickets.js';
import { triageNav } from './triage.js';

const PAGE = 50;
/** The worker reports in every 30 seconds. */
const WORKER_STALE_MS = 90_000;

const RESULT_ICON: Record<LogResult, [IconName, string]> = { ok: ['circle-check', 'ok'], failed: ['circle-x', 'danger'], skipped: ['circle-slash', 'muted'], info: ['info', 'muted'] };
const SOURCES: { value: LogSource; label: string }[] = [
  { value: 'ticket', label: 'New Discord tickets' },
  { value: 'github', label: 'New GitHub issues' },
  { value: 'preview', label: 'Re-run previews' },
  { value: 'rerun', label: 'Re-runs applying' },
  { value: 'review', label: 'Apply and Dismiss' },
];

function actionList(actions: TriageAction[], repo: { owner: string; name: string }): SafeHtml {
  return html`${actions.map((a, i) => html`${i ? '; ' : ''}${actionTitle(a, repo)}<span class="muted"> (${actionEffectsShort(a)})</span>`)}`;
}

/** What happened, in plain words. */
function whatHappened(l: LogRow, names: Map<string, string>): SafeHtml {
  const repo = { owner: l.owner ?? '', name: l.name ?? '' };
  const d = l.detail ?? {};
  const lines: SafeHtml[] = [];
  if (d.applied?.length) lines.push(html`<span class="log-k">Applied on GitHub:</span> ${actionList(d.applied, repo)}`);
  if (d.auto?.length) lines.push(html`<span class="log-k">Would apply:</span> ${actionList(d.auto, repo)}`);
  if (d.suggested?.length) {
    const label = l.result === 'failed' && l.source === 'review' ? 'Tried to apply:' : d.inbox ? 'Added to the inbox as suggestions:' : l.source === 'preview' ? 'Would suggest:' : 'Suggested:';
    lines.push(html`<span class="log-k">${label}</span> ${actionList(d.suggested, repo)}`);
  }
  if (d.dismissed?.length) lines.push(html`<span class="log-k">Dismissed:</span> ${actionList(d.dismissed, repo)}`);
  if (d.toldMember) lines.push(html`Told the member in Discord.`);
  if (l.message) {
    lines.push(l.result === 'failed'
      ? html`<span class="danger-text">${l.message}</span>`
      : l.result === 'skipped' ? html`<span class="muted">Skipped: ${l.message}</span>` : html`${l.message}`);
  }
  if (!lines.length) lines.push(html`<span class="muted">${l.source === 'preview' ? 'Would do nothing: nothing to flag.' : 'Nothing to flag.'}</span>`);
  const by = l.by_user ? names.get(l.by_user) ?? 'An admin' : null;
  return html`${lines.map((x) => html`<div>${x}</div>`)}${by && l.source !== 'review' ? html`<div class="xs muted">By ${by}</div>` : ''}`;
}

/** A re-run's name, linked for someone who can open Re-run. */
function runLink(b: string | null, id: string, name: string): SafeHtml {
  return b ? html`<a href="${b}/tickets/triage/runs/${id}">${name}</a>` : html`${name}`;
}

/** `runs` is the workspace base when this person can open Re-run, otherwise null. */
function sourceTag(l: LogRow, names: Map<string, string>, b: string, runs: string | null): SafeHtml {
  const run = l.run_id ? html` · ${runLink(runs, l.run_id, l.run_name || 're-run')}` : '';
  switch (l.source) {
    case 'ticket':
      return html`${tag('New ticket', { icon: 'message-circle' })}`;
    case 'github':
      return html`${tag('Opened on GitHub', { icon: 'github' })}`;
    case 'preview':
      return html`${tag('Re-run preview', { icon: 'flask-conical' })}${run}`;
    case 'rerun':
      return html`${tag('Re-run', { icon: 'play' })}${run}`;
    default: {
      const who = l.by_user ? names.get(l.by_user) ?? 'An admin' : 'Someone';
      return l.bulk_id || l.detail?.bulk
        ? html`${tag(`Bulk by ${who}`, { icon: 'list-filter' })}${l.bulk_id ? html` · <a href="${b}/tickets/triage/activity?bulk=${l.bulk_id}">this bulk</a>` : ''}`
        : html`${tag(`${who} reviewed`, { icon: 'user-cog' })}`;
    }
  }
}

function subject(l: LogRow, b: string, runs: string | null): SafeHtml {
  if (l.submission_id) return html`<a class="cell-title" href="${b}/tickets/${l.submission_id}">${l.title ?? l.ticket_ref ?? l.ref ?? 'Ticket'}</a> <span class="muted nowrap">${l.ticket_ref ?? ''}</span>`;
  if (l.repo_id && l.number) return html`<a class="cell-title" href="${b}/tickets/issues/${String(l.repo_id)}/${String(l.number)}">${l.title ?? `Issue #${l.number}`}</a> <span class="muted nowrap">${l.owner && l.name ? `${l.owner}/${l.name}` : ''}#${String(l.number)}</span>`;
  if (l.run_id) return runs ? html`<a class="cell-title" href="${runs}/tickets/triage/runs/${l.run_id}">${l.run_name || 'Re-run'}</a>` : html`<span class="cell-title">${l.run_name || 'Re-run'}</span>`;
  if (l.bulk_id) return html`<span class="cell-title">Bulk apply</span>`;
  return html`<span class="cell-title">Triage</span>`;
}

export function registerTriageActivityRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  function nowPanel(ctx: WorkspaceRequestContext, now: ActivityNow, settings: Awaited<ReturnType<typeof getTriageSettings>>, limitReached: boolean): SafeHtml {
    const b = ctx.base;
    const runs = canTriage(ctx, 'runs') ? b : null;
    const workerOk = now.workerSeenAt ? Date.now() - now.workerSeenAt.getTime() < WORKER_STALE_MS : null;
    const busy = now.queued.tickets + now.queued.issues + now.queued.evaluate + now.queued.apply;
    const workingLink = (w: ActivityNow['working'][number]) => {
      const run = w.run_id ? now.runs.find((r) => r.id === w.run_id) : null;
      const what = w.submission_id ? html`<a href="${b}/tickets/${w.submission_id}">a Discord ticket</a>` : w.repo_id ? html`<a href="${b}/tickets/issues/${String(w.repo_id)}/${String(w.number)}">issue #${String(w.number)}</a>` : html`a ticket`;
      return html`<li>${icon('loader-circle', 14, 'muted')}<span>${w.kind === 'rerun' ? (w.job === 'apply' ? 'Applying a result for ' : 'Re-running ') : 'Triaging '}${what}${run ? html` · ${runLink(runs, run.id, run.name || 're-run')}` : ''}</span></li>`;
    };
    return html`<div class="card">
      <div class="card-h"><div><h2>Right now</h2><div class="desc">${busy ? `${plural(busy, 'thing')} waiting. Triage works one at a time: new tickets first, then new GitHub issues, then re-runs.` : 'Nothing waiting.'}</div></div>
</div>
      ${workerOk === false ? html`<div class="card-b tight">${notice('danger', 'The triage worker isn’t running', html`It last checked in ${timeAgo(now.workerSeenAt!)}. Nothing is triaged or applied until it’s back.${can(ctx.membership, 'health.view') ? html` Check <a href="${b}/health">Server health</a>.` : ''}`)}</div>` : ''}
      ${settings.paused ? html`<div class="card-b tight">${notice('warn', 'Triage is paused', pauseMessage(settings.paused.reason, settings.paused.detail, settings.config.model))}</div>` : ''}
      ${limitReached ? html`<div class="card-b tight">${notice('warn', 'Monthly limit reached', 'Nothing more is triaged this month. Raise the limit in Actions.')}</div>` : ''}
      <div class="stats four">
        <div class="stat"><div class="l">${icon('message-circle', 14)}New Discord tickets</div><div class="v">${String(now.queued.tickets)}</div><div class="sub">${settings.enabled ? 'waiting' : 'triage off'}</div></div>
        <div class="stat"><div class="l">${icon('github', 14)}New GitHub issues</div><div class="v">${String(now.queued.issues)}</div><div class="sub">${settings.githubEnabled ? 'waiting' : 'triage off'}</div></div>
        <div class="stat"><div class="l">${icon('flask-conical', 14)}Re-run: to triage</div><div class="v">${String(now.queued.evaluate)}</div><div class="sub">waiting</div></div>
        <div class="stat"><div class="l">${icon('play', 14)}To apply (re-runs, bulk)</div><div class="v">${String(now.queued.apply)}</div><div class="sub">waiting</div></div>
      </div>
      <div class="card-b tight">
        <ul class="tri-effects">
          <li>${icon(workerOk === false ? 'circle-x' : 'circle-check', 14, workerOk === false ? 'danger' : 'ok')}<span>Triage worker: ${workerOk === null ? 'no check-in recorded yet' : workerOk ? html`running, checked in ${timeAgo(now.workerSeenAt!)}` : 'not running'}</span></li>
          ${now.working.length ? now.working.map(workingLink) : html`<li>${icon('clock', 14)}<span class="muted">${busy ? 'Between items.' : 'Idle.'}</span></li>`}
          ${now.bulks.filter((x) => x.status === 'running').map((x) => html`<li>${icon('list-filter', 14)}<span><a href="${b}/tickets/triage/activity?bulk=${x.id}">Bulk apply</a> of ${x.description}: ${plural(x.pending, 'ticket')} to go${x.waiting_until_at && x.waiting_until_at.getTime() > Date.now() ? ` · waiting for GitHub’s hourly limit until ${x.waiting_until_at.toISOString().slice(11, 16)} UTC` : ''}</span></li>`)}
          ${now.runs.map((r) => {
            const waiting = r.waiting_until_at && r.waiting_until_at.getTime() > Date.now()
              ? (r.waiting_reason === 'github' ? ` · waiting for GitHub’s hourly limit until ${r.waiting_until_at.toISOString().slice(11, 16)} UTC, so new tickets can still be filed` : ` · Claude asked to slow down, carrying on ${timeAgo(r.waiting_until_at)}`)
              : '';
            return html`<li>${icon(r.mode === 'preview' ? 'flask-conical' : 'play', 14)}<span>${runLink(runs, r.id, r.name || (r.mode === 'preview' ? 'Preview' : 'Re-run'))}: ${r.pending ? `${plural(r.pending, 'ticket')} to triage` : ''}${r.pending && r.applying ? ' · ' : ''}${r.applying ? `${plural(r.applying, 'result')} to apply` : ''}${waiting}</span></li>`;
          })}
        </ul>
      </div>
    </div>`;
  }

  app.get('/w/:wid/tickets/triage/activity', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.activity.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const runs = canTriage(ctx, 'runs') ? b : null;
    const q = req.query as { result?: string; source?: string; run?: string; bulk?: string; before?: string; partial?: string };
    const result = (['ok', 'failed', 'skipped', 'info'] as const).find((r) => r === q.result) ?? null;
    const source = SOURCES.find((s) => s.value === q.source)?.value ?? null;
    const runId = q.run && /^[0-9a-f-]{36}$/i.test(q.run) ? q.run : null;
    const bulkId = q.bulk && /^[0-9a-f-]{36}$/i.test(q.bulk) ? q.bulk : null;
    const before = Number.parseInt(q.before ?? '', 10) || null;
    const [now, settings, usage, rows, run] = await Promise.all([
      web.triage.activityNow(wid),
      getTriageSettings(deps.db, wid),
      monthlyUsage(deps.db, wid),
      web.triage.activityLog(wid, { result, source, runId, bulkId, before, limit: PAGE + 1 }),
      runId ? web.triage.getRun(wid, runId) : Promise.resolve(null),
    ]);
    const more = rows.length > PAGE;
    const entries = rows.slice(0, PAGE);
    const names = await userNames(deps.db, entries.map((l) => l.by_user));
    const link = (o: { result?: LogResult | null; source?: LogSource | null; run?: string | null; bulk?: string | null; before?: number | null }) => {
      const p = new URLSearchParams();
      const bk = o.bulk === undefined ? bulkId : o.bulk;
      if (bk) p.set('bulk', bk);
      const r = o.result === undefined ? result : o.result;
      const s = o.source === undefined ? source : o.source;
      const rn = o.run === undefined ? runId : o.run;
      if (r) p.set('result', r);
      if (s) p.set('source', s);
      if (rn) p.set('run', rn);
      if (o.before) p.set('before', String(o.before));
      const qs = p.toString();
      return `${b}/tickets/triage/activity${qs ? `?${qs}` : ''}`;
    };
    const log = html`<ol class="log">${entries.map((l) => {
      const [name, tone] = RESULT_ICON[l.result];
      return html`<li class="log-row log-${l.result}">
        <span class="log-ic">${icon(name, 16, tone)}</span>
        <div class="grow">
          <div class="log-t">${subject(l, b, runs)} ${sourceTag(l, names, b, runs)}</div>
          <div class="log-d small">${whatHappened(l, names)}</div>
        </div>
        <time class="when" datetime="${l.at.toISOString()}" title="${formatDate(l.at)}">${timeAgo(l.at)}</time>
      </li>`;
    })}</ol>`;
    const logCard = html`<div class="card">
      <div class="card-h"><div><h2>Log</h2><div class="desc">Everything triage did, newest first: what it applied on GitHub, suggested, skipped or couldn’t do, and why. Kept ${String(LOG_DAYS)} days.</div></div></div>
      <div class="toolbar">
        ${segLinks('Result', [
          { href: link({ result: null, before: null }), label: 'All', current: !result },
          { href: link({ result: 'ok', before: null }), label: 'Done', current: result === 'ok' },
          { href: link({ result: 'failed', before: null }), label: 'Failed', current: result === 'failed' },
          { href: link({ result: 'skipped', before: null }), label: 'Skipped', current: result === 'skipped' },
        ])}
        <form method="get" action="${b}/tickets/triage/activity" class="tools">
          ${result ? html`<input type="hidden" name="result" value="${result}">` : ''}${runId ? html`<input type="hidden" name="run" value="${runId}">` : ''}${bulkId ? html`<input type="hidden" name="bulk" value="${bulkId}">` : ''}
          ${selectWrap(html`<select name="source" aria-label="Where from" data-autosubmit><option value="">Everything</option>${SOURCES.map((s) => html`<option value="${s.value}" ${s.value === source ? raw('selected') : ''}>${s.label}</option>`)}</select>`, { sm: true })}
          <button type="submit" class="btn sm nojs">Show</button>
        </form>
      </div>
      ${run ? html`<div class="card-b tight"><div class="row"><span class="small">Showing ${runLink(runs, run.id, run.name || 'this re-run')} only.</span>${linkBtn(link({ run: null, before: null }), 'Show everything', { size: 'sm', variant: 'ghost' })}</div></div>` : ''}
      ${bulkId ? html`<div class="card-b tight"><div class="row"><span class="small">Showing one bulk apply only.</span>${linkBtn(link({ bulk: null, before: null }), 'Show everything', { size: 'sm', variant: 'ghost' })}</div></div>` : ''}
      <div class="card-b flush">${entries.length ? log : empty('history', 'Nothing here yet', result || source || runId || bulkId ? 'No entries match these filters.' : 'What triage does shows up here as it happens.')}</div>
      ${more || before ? html`<div class="pager"><span>${before ? 'Older entries' : 'Newest entries'}</span><div class="row">
        ${before ? linkBtn(link({ before: null }), 'Newest', { size: 'sm', icon: 'arrow-up' }) : ''}${more ? linkBtn(link({ before: entries.at(-1)!.id }), 'Older', { size: 'sm', trail: 'chevron-right' }) : ''}</div></div>` : ''}
    </div>`;
    const live = html`${nowPanel(ctx, now, settings, usage.triaged >= settings.config.monthlyLimit && (settings.enabled || settings.githubEnabled))}${logCard}`;
    if (q.partial === '1') return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(live.toString());
    const partialSrc = `${link({})}${link({}).includes('?') ? '&' : '?'}partial=1`;
    const body = html`
      ${await ticketsHeader(web, ctx, 'triage')}
      ${triageNav(ctx, 'activity', before ? null : html`<span class="live" data-live-status>${raw('<span class="pulse" aria-hidden="true"></span>')}<span class="t">Live</span></span>`)}
      <div class="stack" ${before ? '' : raw(`data-live="5000" data-live-src="${partialSrc}"`)}>${live}</div>`;
    return web.render(reply, ctx, 'Activity · Triage', 'tickets', body);
  });
}

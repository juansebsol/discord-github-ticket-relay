/**
 * Bulk Apply and Dismiss from the inbox and Issues › Triage: the suggestions the list's filters
 * are about (for example duplicates at 80%+), on the tickets picked or on everything in the list.
 * Applying runs in the background one ticket at a time; dismissing is immediate.
 */
import type { FastifyInstance } from 'fastify';
import { listSubmissions } from '../../domain/submissions.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { parseSubject, type BulkProgress, type Subject } from '../../triage/engine.js';
import { getTriageSettings } from '../../triage/settings.js';
import { actionMatcher, type ActionMatcher } from '../../triage/state.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, linkBtn, plural, postBtn, submitBtn } from '../ui.js';
import { issueTriageSubjects } from './issue-triage.js';
import { canTriage, inboxFilters, type InboxQuery } from './tickets.js';

/** Most tickets one bulk action takes. */
const MAX_BULK = 10_000;
const FORM = 'bulk-triage';
const n = (x: number) => x.toLocaleString('en-US');

/**
 * The selection bar for a list: Apply and Dismiss for the matching suggestions, on the tickets
 * ticked or on everything in the list. `hidden` are the list's filters, sent along.
 */
export function bulkBar(ctx: WorkspaceRequestContext, o: { matcher: ActionMatcher; selectable: number; matching: number; from: 'inbox' | 'issues'; hidden: Record<string, string | undefined>; back: string }): SafeHtml {
  const m = o.matcher;
  const what = m.narrowed ? m.describe : 'every waiting suggestion';
  // app.js puts how many of the selected tickets count in front (data-bulk-summary).
  const applyBody = m.narrowed
    ? `Applied on GitHub: ${m.effects}. Other suggestions stay. It runs in the background, and you can stop it.`
    : 'Each is applied on GitHub with its own label, comment and closing. It runs in the background, and you can stop it.';
  return html`<form id="${FORM}" method="post" action="${ctx.base}/tickets/triage/bulk">${csrfField(ctx.csrf)}
      <input type="hidden" name="from" value="${o.from}"><input type="hidden" name="back" value="${o.back}"><input type="hidden" name="all" value="0">
      ${Object.entries(o.hidden).map(([k, v]) => (v ? html`<input type="hidden" name="${k}" value="${v}">` : ''))}</form>
    <div class="bulk-bar">
      <span class="small muted" data-selected-text="${FORM}" data-count-matches data-empty-text="Select tickets to apply or dismiss ${what}.">Select tickets to apply or dismiss ${what}.</span>
      <div class="row">
        ${o.matching > o.selectable ? html`<button type="button" class="btn sm ghost js-only" data-select-matching="${FORM}" data-matching="${String(o.matching)}">Select all ${n(o.matching)} in this list</button>` : ''}
        ${submitBtn('Dismiss', { size: 'sm', variant: 'ghost', name: 'op', value: 'dismiss', form: FORM, attrs: html`data-needs-selection="${FORM}" data-bulk-summary="${FORM}" data-confirm-title="Dismiss ${what}?" data-confirm-body="Nothing changes on GitHub." data-confirm-label="Dismiss"` })}
        ${submitBtn('Apply', { size: 'sm', variant: 'primary', icon: 'play', name: 'op', value: 'apply', form: FORM, attrs: html`data-needs-selection="${FORM}" data-bulk-summary="${FORM}" data-confirm-title="Apply ${what}?" data-confirm-body="${applyBody}" data-confirm-label="Apply on GitHub"` })}
      </div>
    </div>
    <p class="card-note">${m.narrowed ? html`Apply and Dismiss only take <strong>${m.describe}</strong> (${m.effects}). Other suggestions on these tickets stay.` : html`No action filter: Apply and Dismiss take <strong>every waiting suggestion</strong>. Filter by “Flagged as”, priority, label or confidence to take only some.`}${canTriage(ctx, 'activity') ? html` Follow it in <a href="${ctx.base}/tickets/triage/activity?source=review">Triage › Activity</a>.` : ''}</p>`;
}

/** Bulk applies going on (and just finished), with progress; live while one runs. */
export async function bulkBanner(web: Web, ctx: WorkspaceRequestContext): Promise<SafeHtml> {
  const bulks = await web.triage.activeBulks(ctx.workspace.id);
  if (!bulks.length) return html``;
  const running = bulks.some((x) => x.status === 'running');
  return html`<div ${running ? raw(`data-live="4000" data-live-src="${ctx.base}/tickets/triage/bulk/status"`) : ''}>${bulkStatus(ctx, bulks)}</div>`;
}

function bulkStatus(ctx: WorkspaceRequestContext, bulks: BulkProgress[]): SafeHtml {
  const b = ctx.base;
  return html`<div class="card-b tight bulk-status">${bulks.map((x) => {
    const finished = x.done + x.skipped + x.failed;
    const waiting = x.status === 'running' && x.waiting_until_at && x.waiting_until_at.getTime() > Date.now();
    return html`<div class="bulk-line">
      ${icon(x.status === 'running' ? 'loader-circle' : x.failed ? 'triangle-alert' : 'circle-check', 16, x.status === 'running' ? 'muted' : x.failed ? 'warn' : 'ok')}
      <div class="grow"><div class="small"><strong>${x.status === 'running' ? 'Applying' : x.status === 'stopped' ? 'Stopped applying' : 'Applied'} ${x.description}</strong>: ${n(x.done)} of ${n(x.total)} done${x.skipped ? ` · ${n(x.skipped)} skipped` : ''}${x.failed ? ` · ${n(x.failed)} failed` : ''}${waiting ? ` · waiting for GitHub’s hourly limit until ${x.waiting_until_at!.toISOString().slice(11, 16)} UTC` : ''}</div>
        ${x.status === 'running' ? html`<progress class="bar wide" max="${String(x.total || 1)}" value="${String(finished)}"></progress>` : ''}</div>
      <div class="row">${canTriage(ctx, 'activity') ? linkBtn(`${b}/tickets/triage/activity?bulk=${x.id}`, 'Activity', { size: 'sm', variant: 'ghost', icon: 'history' }) : ''}
        ${x.status === 'running' ? postBtn(`${b}/tickets/triage/bulk/${x.id}/stop`, 'Stop', ctx.csrf, { size: 'sm', icon: 'circle-x', confirm: { title: 'Stop applying?', body: 'What’s applied stays applied. The rest stays as suggestions.', label: 'Stop' } }) : ''}</div>
    </div>`;
  })}${bulks.some((x) => x.status === 'running') ? '' : html`<span data-live-reload hidden></span>`}</div>`;
}

export function registerTriageBulkRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const backTo = (ctx: WorkspaceRequestContext, back: string | undefined) => (back && back.startsWith(`${ctx.base}/tickets`) && !back.includes('//', 1) ? back : `${ctx.base}/tickets`);

  app.post('/w/:wid/tickets/triage/bulk', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const f = (req.body ?? {}) as Record<string, string | string[] | undefined>;
    const one = (k: string) => (Array.isArray(f[k]) ? (f[k] as string[])[0] : (f[k] as string | undefined));
    const from = one('from') === 'issues' ? 'issues' : 'inbox';
    const back = backTo(ctx, one('back'));
    try {
      const filter = { triage: from === 'issues' ? one('f') : one('triage'), conf: one('conf') };
      let subjects: Subject[];
      if (one('all') === '1') {
        // Everything in the list, worked out again from its filters.
        if (from === 'inbox') {
          const q: InboxQuery = { status: one('status'), q: one('q'), app: one('app'), type: one('type'), triage: one('triage'), conf: one('conf') };
          const { list } = await inboxFilters(deps, wid, q);
          const { rows } = await listSubmissions(deps.db, wid, { ...list, limit: MAX_BULK, offset: 0 });
          subjects = rows.map((r) => ({ kind: 'ticket', submissionId: r.id }));
        } else {
          subjects = await issueTriageSubjects(web, wid, { show: one('show'), f: one('f'), conf: one('conf') }, MAX_BULK);
        }
      } else {
        const picked = f.ticket === undefined ? [] : Array.isArray(f.ticket) ? f.ticket : [f.ticket];
        subjects = picked.slice(0, MAX_BULK).map(parseSubject).filter((x) => x !== null);
      }
      if (!subjects.length) throw new UserFacingError('Select the tickets first.');
      const settings = await getTriageSettings(deps.db, wid);
      const what = actionMatcher(filter, settings.config).describe;
      if (one('op') === 'dismiss') {
        const r = await web.triage.dismissBulk(wid, ctx.user.id, { subjects, filter });
        const skipped = subjects.length - r.tickets;
        setFlash(reply, r.suggestions ? 'success' : 'error', r.suggestions ? `Dismissed ${plural(r.suggestions, 'suggestion')} on ${plural(r.tickets, 'ticket')}${skipped ? ` (${n(skipped)} had nothing to dismiss)` : ''}.` : 'None of these had a matching suggestion waiting.');
      } else {
        const r = await web.triage.startBulk(wid, ctx.user.id, { subjects, filter });
        const skipped = subjects.length - r.count;
        setFlash(reply, 'success', `Applying ${what} on ${plural(r.count, 'ticket').replace(/^\d+/, n(r.count))}${skipped ? ` (${n(skipped)} had nothing to apply)` : ''}. Progress is shown above the list.`);
      }
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/tickets/triage/bulk/:id/stop', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
    if (!ctx) return reply;
    try {
      const left = await web.triage.stopBulk(ctx.workspace.id, (req.params as { id: string }).id, ctx.user.id);
      setFlash(reply, 'success', `Stopped. ${plural(left, 'ticket')} weren’t changed; their suggestions are still there.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(backTo(ctx, (req.headers.referer ?? '').replace(/^https?:\/\/[^/]+/, '')));
  });

  /** The progress banner, for live updates. */
  app.get('/w/:wid/tickets/triage/bulk/status', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
    if (!ctx) return reply;
    const bulks = await web.triage.activeBulks(ctx.workspace.id);
    return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(bulkStatus(ctx, bulks).toString());
  });
}

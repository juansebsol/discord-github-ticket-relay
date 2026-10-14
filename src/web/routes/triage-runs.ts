/**
 * Triage › Re-run: try the current settings on tickets that are already filed. A preview only
 * records what triage would do, to compare with what it did before (or with another run), and
 * can be applied afterwards. Runs are processed by the triage worker between new tickets.
 */
import type { FastifyInstance } from 'fastify';
import { listApps } from '../../domain/store.js';
import { listTicketTypes } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { userNames } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { describeAction, MAX_RERUN, type RerunScope, type RunItemRow, type TriageAction, type TriageRunRow } from '../../triage/engine.js';
import {
  actionMode,
  actionName,
  allActionKeys,
  anyActionOn,
  FLAGS,
  formatCost,
  getTriageSettings,
  monthlyUsage,
  resolveApiKey,
  saveTriageConfig,
  tokenCost,
  type TriageConfig,
} from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { actionEffects, actionTitle } from '../triage-view.js';
import {
  choices,
  csrfField,
  empty,
  icon,
  linkBtn,
  menu,
  notice,
  pageHeader,
  pill,
  plural,
  postBtn,
  segLinks,
  selectWrap,
  setting,
  submitBtn,
  tag,
  timeAgo,
  when,
  type Tone,
} from '../ui.js';
import { ticketsHeader } from './tickets.js';
import { FLAG_COPY, MODE_NAMES, triageNav } from './triage.js';

/** Tokens per ticket when there's no history to go by. */
const TYPICAL_TOKENS = { input: 6000, output: 500 };

type Side = { auto: TriageAction[]; suggested: TriageAction[]; reason: string | null } | null;
type Verdict = 'changed' | 'new' | 'same' | 'skipped' | 'pending';

/** What a ticket's triage looked like before the run (or in the run compared with). */
function beforeSide(item: RunItemRow, vs: Map<string, RunItemRow> | null): Side {
  if (vs) {
    const other = vs.get(item.submission_id);
    return other?.status === 'done' ? { auto: other.auto_actions ?? [], suggested: other.suggestions ?? [], reason: other.verdict?.reason ?? null } : null;
  }
  const b = item.before;
  return b?.status === 'done' ? { auto: b.applied, suggested: b.suggestions, reason: b.reason } : null;
}

function afterSide(item: RunItemRow): Side {
  return item.status === 'done' ? { auto: item.auto_actions ?? [], suggested: item.suggestions ?? [], reason: item.verdict?.reason ?? null } : null;
}

/** The decisions, ignoring wording: what is done automatically and what is suggested. */
function signature(s: Side): string {
  if (!s) return '';
  return [...s.auto.map((a) => `auto:${describeAction(a)}`), ...s.suggested.map((a) => `suggest:${describeAction(a)}`)].sort().join('|');
}

function verdictOf(item: RunItemRow, vs: Map<string, RunItemRow> | null): Verdict {
  if (item.status === 'pending') return 'pending';
  if (item.status !== 'done') return 'skipped';
  const before = beforeSide(item, vs);
  const after = afterSide(item);
  if (!before) return signature(after) ? 'new' : 'same';
  return signature(before) === signature(after) ? 'same' : 'changed';
}

/** How the settings a run used differ from another set (current settings, or another run's). */
export function configDiff(a: TriageConfig, b: TriageConfig): string[] {
  const out: string[] = [];
  if (a.model !== b.model) out.push(`Model: ${a.model} (now ${b.model})`);
  if (a.threshold !== b.threshold) out.push(`Confidence threshold: ${a.threshold}% (now ${b.threshold}%)`);
  for (const k of new Set([...allActionKeys(a), ...allActionKeys(b)])) {
    const ma = actionMode(a, k);
    const mb = actionMode(b, k);
    const name = actionName(a.labelGroups.some((g) => `group:${g.id}` === k) ? a : b, k);
    if (ma !== mb) out.push(`${name}: ${MODE_NAMES[ma]} (now ${MODE_NAMES[mb]})`);
  }
  for (const f of FLAGS) {
    const x = a[f];
    const y = b[f];
    if (x.label !== y.label || x.close !== y.close || x.comment !== y.comment || x.notifyMember !== y.notifyMember) out.push(`${FLAG_COPY[f].title}: label, comment or closing changed since`);
    if ((a.checkRules[f] ?? '') !== (b.checkRules[f] ?? '')) out.push(`${FLAG_COPY[f].title}: the check’s wording changed since`);
  }
  if (JSON.stringify(a.priority) !== JSON.stringify(b.priority) && a.priority.mode === b.priority.mode) out.push('Priority: labels or guide changed since');
  for (const g of a.labelGroups) {
    const now = b.labelGroups.find((x) => x.id === g.id);
    if (!now) out.push(`Label group ${g.name}: deleted since`);
    else if (JSON.stringify({ ...g, mode: '' }) !== JSON.stringify({ ...now, mode: '' })) out.push(`Label group ${g.name}: options or wording changed since`);
  }
  for (const g of b.labelGroups) if (!a.labelGroups.some((x) => x.id === g.id)) out.push(`Label group ${g.name}: added since`);
  if (a.products !== b.products) out.push('About your products: changed since');
  if ((a.examples ?? null) !== (b.examples ?? null)) out.push('Examples: changed since');
  if (a.instructions !== b.instructions) out.push('Notes for Claude: changed since');
  if (JSON.stringify(a.typeRules) !== JSON.stringify(b.typeRules)) out.push('Rules by ticket type: changed since');
  if (JSON.stringify(a.appIds) !== JSON.stringify(b.appIds)) out.push('Apps triaged: changed since');
  return out;
}

const STATUS_PILL: Record<TriageRunRow['status'], [string, Tone]> = { running: ['Running', 'warn'], done: ['Done', 'ok'], cancelled: ['Stopped', 'closed'] };

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function runName(r: Pick<TriageRunRow, 'name' | 'created_at' | 'mode'>): string {
  return r.name || `${r.mode === 'preview' ? 'Preview' : 'Re-run'} of ${r.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function registerTriageRunRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const runsUrl = (ctx: WorkspaceRequestContext) => `${ctx.base}/tickets/triage/runs`;

  /** Average tokens per triaged ticket recently, for the cost estimate. */
  async function tokensPerTicket(workspaceId: string): Promise<{ input: number; output: number; measured: boolean }> {
    const { rows } = await deps.db.query<{ n: number; i: number | null; o: number | null }>(
      `SELECT count(*) AS n, avg(input_tokens) AS i, avg(output_tokens) AS o FROM (
         SELECT input_tokens, output_tokens FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id WHERE r.workspace_id = $1 AND i.input_tokens IS NOT NULL
         UNION ALL SELECT input_tokens, output_tokens FROM triage_results WHERE workspace_id = $1 AND input_tokens IS NOT NULL
         LIMIT 200)`,
      [workspaceId],
    );
    const r = rows[0];
    return r?.n && r.i ? { input: Math.round(r.i), output: Math.round(r.o ?? 0), measured: true } : { ...TYPICAL_TOKENS, measured: false };
  }

  // ---- Start a run, and the list of runs -----------------------------------------------------

  app.get('/w/:wid/tickets/triage/runs', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = runsUrl(ctx);
    const [settings, apps, types, usage, key, runs, perTicket] = await Promise.all([
      getTriageSettings(deps.db, wid),
      listApps(deps.db, wid),
      listTicketTypes(deps.db, wid),
      monthlyUsage(deps.db, wid),
      resolveApiKey(deps, wid),
      web.triage.listRuns(wid),
      tokensPerTicket(wid),
    ]);
    const c = settings.config;
    const all: RerunScope = { untouched: true, never: true, appId: null, typeName: null, limit: MAX_RERUN };
    const [untouched, never] = await Promise.all([
      web.triage.countRerun(wid, { ...all, never: false }),
      web.triage.countRerun(wid, { ...all, untouched: false }),
    ]);
    const left = Math.max(0, c.monthlyLimit - usage.triaged);
    const running = runs.find((r) => r.status === 'running');
    const perCost = tokenCost(c.model, perTicket.input, perTicket.output);
    const names = await userNames(deps.db, runs.map((r) => r.created_by));
    const blocked = !key ? 'Add a Claude API key in Settings first.' : !anyActionOn(c) ? 'Turn at least one action on in Actions first.' : left <= 0 ? 'This month’s triage limit is used up. Raise it in Actions to re-run.' : running ? 'A re-run is going. Wait for it to finish or stop it.' : null;
    const maxN = Math.max(1, Math.min(MAX_RERUN, left));

    const form = html`<form method="post" action="${b}">
      ${csrfField(ctx.csrf)}
      ${setting('Tickets', 'Open tickets with no triage action applied yet. Closed issues are left out.', html`<div class="check-list">
        <label class="check"><input type="checkbox" name="untouched" value="1" checked> Triaged, nothing applied yet (${String(untouched)})</label>
        <label class="check"><input type="checkbox" name="never" value="1" checked> Never triaged (${String(never)})</label>
      </div>`, { stacked: true })}
      ${setting('App', null, selectWrap(html`<select id="run-app" name="app_id"><option value="">All apps</option>${apps.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select>`), { for: 'run-app' })}
      ${setting('Ticket type', null, selectWrap(html`<select id="run-type" name="type"><option value="">All types</option>${types.map((t) => html`<option value="${t.name}">${t.name}</option>`)}</select>`), { for: 'run-type' })}
      ${setting('How many', `Newest first. Up to ${String(MAX_RERUN)}, and no more than what’s left of this month’s limit (${String(left)}).`, html`<input id="run-limit" type="number" name="limit" value="${String(Math.min(25, maxN))}" min="1" max="${String(maxN)}" required aria-label="How many tickets"><span class="connector">tickets</span>`)}
      ${setting('Mode', null, choices('mode', [
        { value: 'preview', title: 'Preview (recommended)', desc: 'Records what triage would do. Nothing changes on GitHub. Compare it with before, then apply the results you like.' },
        { value: 'apply', title: 'Apply right away', desc: settings.enabled ? 'Works like normal triage: automatic actions happen on GitHub and the new suggestions replace the old ones.' : 'Needs triage to be on.' },
      ], 'preview'), { stacked: true })}
      ${setting('Name (optional)', 'To tell runs apart when you compare settings.', html`<input id="run-name" type="text" name="name" maxlength="60" placeholder="Stricter duplicates">`, { for: 'run-name' })}
      <div class="card-f"><span class="small muted">${perCost !== null ? `${sentence(formatCost(perCost * 100))} per 100 tickets with ${c.model}${perTicket.measured ? ', going by recent tickets' : ' (estimated)'}. ` : ''}Uses your current settings.</span><div class="end">
        ${submitBtn('Start', { variant: 'primary', icon: 'play', loading: 'Starting…', disabled: Boolean(blocked) })}
      </div></div>
    </form>`;

    const history = runs.length
      ? html`<div class="card-b flush"><div class="table-wrap"><table>
          <thead><tr><th>Run</th><th>Mode</th><th>Tickets</th><th>Cost</th><th>Status</th><th class="num">Started</th></tr></thead>
          <tbody>${runs.map((r) => {
            const finished = r.done + r.skipped + r.failed;
            const cost = r.input_tokens ? tokenCost(r.config_used.model, r.input_tokens, r.output_tokens ?? 0) : null;
            return html`<tr class="click">
              <td><a class="cell-title" href="${b}/${r.id}">${runName(r)}</a><div class="sub">${r.created_by ? names.get(r.created_by) ?? 'An admin' : 'An admin'} · ${r.config_used.model}</div></td>
              <td>${r.mode === 'preview' ? tag('Preview', { icon: 'flask-conical' }) : tag('Applied', { icon: 'play' })}${r.mode === 'preview' && r.applied ? html`<div class="sub">${plural(r.applied, 'result')} applied</div>` : ''}</td>
              <td class="num">${r.status === 'running' ? html`${String(finished)} of ${String(r.total)}<progress class="bar" max="${String(r.total || 1)}" value="${String(finished)}"></progress>` : html`${String(r.done)} triaged${r.skipped + r.failed ? html`<div class="sub">${String(r.skipped + r.failed)} skipped</div>` : ''}`}</td>
              <td>${cost !== null ? formatCost(cost) : html`<span class="em">—</span>`}</td>
              <td>${pill(...STATUS_PILL[r.status])}${r.applying ? html`<div class="sub">Applying…</div>` : ''}</td>
              <td class="num">${when(r.created_at)}</td>
            </tr>`;
          })}</tbody></table></div></div>`
      : empty('history', 'No re-runs yet', 'Start a preview above to see what your settings would do.');

    const body = html`
      ${await ticketsHeader(web, ctx, 'triage')}
      ${triageNav(ctx, 'runs')}
      <div class="stack">
        ${running ? notice('info', 'A re-run is going', `${runName(running)}: ${String(running.done + running.skipped + running.failed)} of ${String(running.total)} tickets. It uses the time between new tickets, so filing and normal triage are never delayed.`, { action: linkBtn(`${b}/${running.id}`, 'View', { size: 'sm', trail: 'arrow-right' }) }) : ''}
        ${blocked && !running ? notice('warn', null, blocked) : ''}
        <div class="card">
          <div class="card-h"><div><h2>Re-run triage</h2><div class="desc">Try your current settings on tickets that are already filed. Change a setting, run a preview, compare, and repeat until you like the results; then apply them. Each ticket counts toward the monthly limit.</div></div></div>
          ${form}
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Runs</h2><div class="desc">Each run keeps the settings it used, so you can compare runs and go back to the settings you liked best.</div></div></div>
          ${history}
        </div>
      </div>`;
    return web.render(reply, ctx, 'Re-run · Triage', 'tickets', body);
  });

  app.post('/w/:wid/tickets/triage/runs', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const f = (req.body ?? {}) as Record<string, string | undefined>;
    try {
      const scope: RerunScope = {
        untouched: f.untouched !== undefined,
        never: f.never !== undefined,
        appId: f.app_id || null,
        typeName: f.type || null,
        limit: Math.max(1, Math.min(MAX_RERUN, Number.parseInt(String(f.limit ?? '25'), 10) || 25)),
      };
      if (!scope.untouched && !scope.never) throw new UserFacingError('Choose which tickets to include.');
      if (scope.appId && !(await listApps(deps.db, ctx.workspace.id)).some((a) => a.id === scope.appId)) throw new UserFacingError('Choose an app from the list.');
      const name = String(f.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
      const run = await web.triage.startRun(ctx.workspace.id, ctx.user.id, { mode: f.mode === 'apply' ? 'apply' : 'preview', name, scope });
      return reply.redirect(`${runsUrl(ctx)}/${run.id}`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
      return reply.redirect(runsUrl(ctx));
    }
  });

  // ---- One run's results -------------------------------------------------------------------------

  app.get('/w/:wid/tickets/triage/runs/:rid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const rid = (req.params as { rid: string }).rid;
    const q = req.query as { show?: string; vs?: string; partial?: string };
    const run = /^[0-9a-f-]{36}$/i.test(rid) ? await web.triage.getRun(wid, rid) : null;
    if (!run) return reply.callNotFound();
    const b = `${runsUrl(ctx)}/${run.id}`;
    const [items, settings, runs] = await Promise.all([web.triage.runItems(run.id), getTriageSettings(deps.db, wid), web.triage.listRuns(wid, 50)]);
    const vsRun = q.vs && q.vs !== run.id ? runs.find((r) => r.id === q.vs) ?? null : null;
    const vs = vsRun ? new Map((await web.triage.runItems(vsRun.id)).map((i) => [i.submission_id, i])) : null;
    const verdicts = new Map(items.map((i) => [i.submission_id, verdictOf(i, vs)]));
    const count = (v: Verdict[]) => items.filter((i) => v.includes(verdicts.get(i.submission_id)!)).length;
    const show = ['changed', 'same', 'skipped'].includes(q.show ?? '') ? q.show! : 'all';
    const shown = items.filter((i) => {
      const v = verdicts.get(i.submission_id)!;
      return show === 'all' || (show === 'changed' ? v === 'changed' || v === 'new' : show === 'same' ? v === 'same' : v === 'skipped');
    });
    const applying = items.some((i) => i.apply_status === 'pending');
    const live = run.status === 'running' || applying;
    const canApply = run.mode === 'preview' && run.status !== 'running' && !applying && settings.enabled;
    const applicable = (i: RunItemRow) => i.status === 'done' && (i.apply_status === null || i.apply_status === 'failed');
    const anyApply = items.some((i) => i.apply_status !== null);
    const link = (o: { show?: string; vs?: string | null }) => {
      const p = new URLSearchParams();
      const s = o.show ?? show;
      const v = o.vs === undefined ? vsRun?.id ?? null : o.vs;
      if (s !== 'all') p.set('show', s);
      if (v) p.set('vs', v);
      const qs = p.toString();
      return qs ? `${b}?${qs}` : b;
    };
    const finished = items.filter((i) => i.status !== 'pending').length;
    const tokensIn = items.reduce((n, i) => n + (i.input_tokens ?? 0), 0);
    const tokensOut = items.reduce((n, i) => n + (i.output_tokens ?? 0), 0);
    const cost = tokensIn ? tokenCost(run.config_used.model, tokensIn, tokensOut) : null;
    const repoOf = (i: { repo_owner: string; repo_name: string }) => ({ owner: i.repo_owner, name: i.repo_name });

    const sideCell = (s: Side, i: (typeof items)[number], o: { label: 'before' | 'after' }) => {
      if (!s) {
        if (o.label === 'after') {
          if (i.status === 'pending') return html`<div class="run-cell"><span class="em">Waiting…</span></div>`;
          return html`<div class="run-cell"><span class="muted">Skipped: ${i.note ?? 'no result'}</span></div>`;
        }
        if (vs) return html`<div class="run-cell"><span class="em">Not in that run</span></div>`;
        const b4 = i.before;
        return html`<div class="run-cell"><span class="em">${!b4 ? 'Never triaged' : b4.status === 'skipped' ? `Skipped: ${b4.skipReason ?? ''}` : 'No result'}</span></div>`;
      }
      const actions = [...s.auto.map((a) => ({ a, auto: true })), ...s.suggested.map((a) => ({ a, auto: false }))];
      return html`<div class="run-cell">
        ${actions.map(({ a, auto }) => html`<div class="tri-line">${icon(auto ? 'circle-check' : 'circle-help', 14, auto ? 'ok' : 'warn')}<span><span class="muted">${auto ? (o.label === 'before' && !vs ? 'Applied' : 'Automatic') : 'Suggests'}:</span> ${actionTitle(a, repoOf(i))}</span></div>`)}
        ${!actions.length ? html`<span class="em">Nothing flagged</span>` : ''}
        ${actions.length ? html`<details><summary>What it does</summary>${actions.map(({ a }) => html`<div class="small"><strong>${actionTitle(a, repoOf(i))}</strong>${actionEffects(a)}</div>`)}</details>` : ''}
        ${s.reason ? html`<details><summary>Claude’s reason</summary><p class="small muted">${s.reason}</p></details>` : ''}
      </div>`;
    };

    const VERDICT_TAG: Record<Verdict, SafeHtml | string> = {
      changed: tag('Changed', { cls: 'diff-tag' }),
      new: tag('New', { cls: 'diff-tag' }),
      same: '',
      skipped: '',
      pending: '',
    };
    const applyCell = (i: RunItemRow) => {
      if (!i.apply_status) return html`<span class="em">—</span>`;
      const [label, tone] = ({ pending: ['Applying…', 'neutral'], done: ['Applied', 'ok'], skipped: ['Not applied', 'closed'], failed: ['Failed', 'danger'] } as const)[i.apply_status];
      return html`${pill(label, tone)}${i.apply_note ? html`<div class="sub">${i.apply_note}</div>` : ''}`;
    };

    const table = shown.length
      ? html`<div class="table-wrap"><table>
          <thead><tr>${canApply ? html`<th class="check-col"><input type="checkbox" class="rule-check" data-select-all="apply-run" aria-label="Select every result"></th>` : ''}<th>Ticket</th><th class="half">${vsRun ? `In ${runName(vsRun)}` : 'Before'}</th><th class="half">This run</th>${anyApply ? html`<th>Applied</th>` : ''}</tr></thead>
          <tbody>${shown.map((i) => {
            const v = verdicts.get(i.submission_id)!;
            return html`<tr class="${v === 'changed' || v === 'new' ? 'changed' : ''}">
              ${canApply ? html`<td class="check-col">${applicable(i) ? html`<input type="checkbox" class="rule-check" name="ticket" value="${i.submission_id}" form="apply-run" ${v === 'changed' || v === 'new' ? raw('checked') : ''} aria-label="Apply ${i.ref}">` : ''}</td>` : ''}
              <td><a class="cell-title" href="${ctx.base}/tickets/${i.submission_id}">${i.issue_title ?? i.ref}</a>
                <div class="sub">${i.issue_number ? html`<a href="https://github.com/${i.repo_owner}/${i.repo_name}/issues/${String(i.issue_number)}" target="_blank" rel="noopener noreferrer">#${String(i.issue_number)}</a> · ` : ''}${i.app_name}${i.ticket_type_name ? ` · ${i.ticket_type_name}` : ''}</div>
                ${VERDICT_TAG[v] ? html`<div class="mt-8">${VERDICT_TAG[v]}</div>` : ''}</td>
              <td>${sideCell(beforeSide(i, vs), i, { label: 'before' })}</td>
              <td>${sideCell(afterSide(i), i, { label: 'after' })}</td>
              ${anyApply ? html`<td>${applyCell(i)}</td>` : ''}
            </tr>`;
          })}</tbody></table></div>`
      : html`<div class="card-b">${empty('circle-check', show === 'changed' ? 'No changes' : 'Nothing here', show === 'changed' ? 'This run decided the same as before for every ticket so far.' : 'No tickets match this filter.')}</div>`;

    const results = html`
      ${live ? html`<div class="card-b tight"><div class="row"><span class="small">${run.status === 'running' ? `${String(finished)} of ${plural(items.length, 'ticket')} done` : `Applying ${plural(items.filter((i) => i.apply_status === 'pending').length, 'result')} on GitHub…`}</span></div>
        <progress class="bar" max="${String(items.length || 1)}" value="${String(run.status === 'running' ? finished : items.filter((i) => i.apply_status && i.apply_status !== 'pending').length)}"></progress>
        <p class="xs muted mt-8">Re-runs use the time between new tickets, so filing and normal triage are never delayed.</p></div>` : ''}
      <div class="stats four">
        <a class="stat" href="${link({ show: 'changed' })}"><div class="l">Changed</div><div class="v">${String(count(['changed']))}</div></a>
        <a class="stat" href="${link({ show: 'changed' })}"><div class="l">${vsRun ? 'Only in this run' : 'New (not triaged before)'}</div><div class="v">${String(count(['new']))}</div></a>
        <a class="stat" href="${link({ show: 'same' })}"><div class="l">Same as ${vsRun ? 'that run' : 'before'}</div><div class="v">${String(count(['same']))}</div></a>
        <a class="stat" href="${link({ show: 'skipped' })}"><div class="l">Skipped</div><div class="v">${String(count(['skipped']))}</div></a>
      </div>
      <div class="card-b tight"><div class="row">${segLinks('Show', [
        { href: link({ show: 'all' }), label: 'All', count: items.length, current: show === 'all' },
        { href: link({ show: 'changed' }), label: 'Changed', count: count(['changed', 'new']), current: show === 'changed' },
        { href: link({ show: 'same' }), label: 'Same', count: count(['same']), current: show === 'same' },
        { href: link({ show: 'skipped' }), label: 'Skipped', count: count(['skipped']), current: show === 'skipped' },
      ])}</div></div>
      ${canApply && items.some(applicable) ? html`<div class="bulk-bar">
        <span class="small muted" data-selected-text="apply-run" data-empty-text="Select results to apply them on GitHub.">Select results to apply them on GitHub.</span>
        ${submitBtn('Apply selected', { variant: 'primary', size: 'sm', icon: 'play', attrs: raw('form="apply-run" data-needs-selection="apply-run"') })}
      </div>` : ''}
      ${table}
      ${live ? '' : html`<span data-live-reload hidden></span>`}`;

    if (q.partial === '1') {
      return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(results.toString());
    }

    const diff = configDiff(run.config_used, settings.config);
    const vsDiff = vsRun ? configDiff(run.config_used, vsRun.config_used) : null;
    const names = await userNames(deps.db, [run.created_by, run.applied_by]);
    const others = runs.filter((r) => r.id !== run.id && r.status !== 'running');

    const body = html`
      ${pageHeader({
        title: runName(run),
        crumbs: [{ href: `${ctx.base}/tickets/triage`, label: 'Triage' }, { href: runsUrl(ctx), label: 'Re-run' }, { label: runName(run) }],
        after: [run.mode === 'preview' ? tag('Preview', { icon: 'flask-conical' }) : tag('Applied', { icon: 'play' }), pill(...STATUS_PILL[run.status])],
        description: `${plural(items.length, 'ticket')} · ${run.config_used.model} · started by ${run.created_by ? names.get(run.created_by) ?? 'an admin' : 'an admin'} ${timeAgo(run.created_at)}${cost !== null ? ` · ${formatCost(cost)}` : ''}${run.applied_at ? ` · applied by ${run.applied_by ? names.get(run.applied_by) ?? 'an admin' : 'an admin'} ${timeAgo(run.applied_at)}` : ''}`,
        actions: [
          run.status === 'running' ? postBtn(`${b}/cancel`, 'Stop', ctx.csrf, { icon: 'circle-x', confirm: { title: 'Stop this re-run?', body: 'Tickets not reached yet are skipped. Results so far are kept.', label: 'Stop' } }) : null,
          diff.length ? postBtn(`${b}/use-settings`, 'Use these settings', ctx.csrf, { icon: 'rotate-ccw', confirm: { title: 'Use the settings from this run?', body: 'Your current triage settings (actions, label groups and prompt) are replaced with the ones this run used. New tickets use them right away.', label: 'Use these settings' } }) : null,
          run.status !== 'running' && !applying ? menu([{ post: `${b}/delete`, label: 'Delete run', icon: 'trash-2', danger: true, confirm: { title: 'Delete this run?', body: 'Its results are deleted here. Nothing changes on GitHub.', label: 'Delete', danger: true } }], { csrf: ctx.csrf, label: 'More actions' }) : null,
        ],
      })}
      <div class="stack">
        ${run.mode === 'preview' && !settings.enabled && run.status !== 'running' ? notice('info', null, 'Turn triage on to apply these results.') : ''}
        <details class="card">
          <summary>${icon('sliders-horizontal', 16)}<span>Settings used</span><span class="small muted">${diff.length ? `${plural(diff.length, 'difference')} from your current settings` : 'Same as your current settings'}</span>${icon('chevron-down', 16, 'chev')}</summary>
          <div class="card-b tight">${diff.length ? html`<ul class="tri-effects">${diff.map((d) => html`<li>${icon('arrow-right', 14)}<span>${d}</span></li>`)}</ul>` : html`<p class="small muted">This run used the settings you have now.</p>`}</div>
        </details>
        <div class="card">
          <div class="card-h"><div><h2>Results</h2><div class="desc">${vsRun ? html`Compared with ${runName(vsRun)}.${vsDiff?.length ? html` Differences in settings: ${vsDiff.join('; ')}.` : ' Both runs used the same settings.'}` : 'Compared with each ticket’s triage before the run. Highlighted rows changed.'}</div></div>
            ${others.length ? html`<form method="get" action="${b}" class="row">${show !== 'all' ? html`<input type="hidden" name="show" value="${show}">` : ''}
              ${selectWrap(html`<select name="vs" aria-label="Compare with"><option value="">Compare with before</option>${others.map((r) => html`<option value="${r.id}" ${r.id === vsRun?.id ? raw('selected') : ''}>Compare with ${runName(r)}</option>`)}</select>`, { sm: true })}
              ${submitBtn('Compare', { size: 'sm', icon: 'git-compare-arrows' })}</form>` : ''}</div>
          ${canApply ? html`<form id="apply-run" method="post" action="${b}/apply" data-confirm-title="Apply the selected results?" data-confirm-body="For each ticket, its automatic actions happen on GitHub (labels, comments, closing) and its suggestions replace the old ones. Tickets that were closed or acted on since are skipped." data-confirm-label="Apply on GitHub">${csrfField(ctx.csrf)}</form>` : ''}
          <div ${live ? raw(`data-live="4000" data-live-src="${link({}).includes('?') ? `${link({})}&partial=1` : `${link({})}?partial=1`}"`) : ''}>${results}</div>
        </div>
      </div>`;
    return web.render(reply, ctx, `${runName(run)} · Re-run`, 'tickets', body);
  });

  app.post('/w/:wid/tickets/triage/runs/:rid/cancel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    try {
      await web.triage.cancelRun(ctx.workspace.id, rid);
      setFlash(reply, 'success', 'Re-run stopped');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${runsUrl(ctx)}/${rid}`);
  });

  app.post('/w/:wid/tickets/triage/runs/:rid/apply', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    const t = (req.body as { ticket?: string | string[] }).ticket;
    const ids = t === undefined ? [] : Array.isArray(t) ? t : [t];
    try {
      if (!ids.length) throw new UserFacingError('Select the results to apply.');
      const n = await web.triage.applyPreview(ctx.workspace.id, rid, ctx.user.id, ids);
      setFlash(reply, 'success', `Applying ${plural(n, 'result')} on GitHub. This page updates as it goes.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${runsUrl(ctx)}/${rid}`);
  });

  app.post('/w/:wid/tickets/triage/runs/:rid/use-settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    const run = await web.triage.getRun(ctx.workspace.id, rid);
    if (!run) return reply.callNotFound();
    await saveTriageConfig(deps.db, ctx.workspace.id, run.config_used);
    setFlash(reply, 'success', `Now using the settings from ${runName(run)}`);
    return reply.redirect(`${runsUrl(ctx)}/${rid}`);
  });

  app.post('/w/:wid/tickets/triage/runs/:rid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    try {
      await web.triage.deleteRun(ctx.workspace.id, rid);
      setFlash(reply, 'success', 'Run deleted');
      return reply.redirect(runsUrl(ctx));
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
      return reply.redirect(`${runsUrl(ctx)}/${rid}`);
    }
  });
}

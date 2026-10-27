/**
 * AI triage › Re-run: try the current settings on tickets that are already filed, all of them at
 * once if needed. A preview only records what triage would do, to compare with what it did
 * before (or with another run); its results can then be applied in bulk. The triage worker
 * does the work one ticket at a time, between new tickets, and waits out rate limits.
 */
import type { FastifyInstance } from 'fastify';
import { AREAS, can } from '../../domain/permissions.js';
import { listApps } from '../../domain/store.js';
import { listTicketTypes } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { userNames } from '../../domain/workspaces.js';
import { html, raw } from '../../lib/html.js';
import {
  beforeDecisions,
  categoryLabels,
  changeFrom,
  MAX_RERUN,
  type RerunScope,
  type RunChange,
  type RunFilter,
  type RunItemView,
  type TriageAction,
  type TriageRunRow,
} from '../../triage/engine.js';
import {
  actionMode,
  actionName,
  allActionKeys,
  anyActionOn,
  autoChecked,
  FLAGS,
  forGitHub,
  exactCost,
  formatCost,
  getTriageSettings,
  monthlyUsage,
  resolveApiKey,
  saveTriageConfig,
  tokenCost,
  type LabelGroup,
  type TriageConfig,
  type TriageSettings,
} from '../../triage/settings.js';
import { openLabels, openMissing } from '../../triage/label-stats.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { actionEffects, actionTitle } from '../triage-view.js';
import {
  csrfField,
  empty,
  icon,
  labelTag,
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
  viewOnlyTag,
  when,
  type Tone,
} from '../ui.js';
import { areaHref, canOpen, canOpenIssue, toolHeader, toolHref } from './tool.js';
import { FLAG_COPY, MODE_NAMES } from './triage.js';

/**
 * Tokens and seconds per ticket when there's no history to go by (a custom-labels pass is much
 * smaller). Most of the input is the instructions and the app's TRIAGE.md, read from Claude's
 * prompt cache after the first ticket of each app.
 */
const TYPICAL_TOKENS = { input: 6000, output: 500, cacheRead: 3500, cacheWrite: 0 };
const TYPICAL_LABEL_TOKENS = { input: 3500, output: 300, cacheRead: 2800, cacheWrite: 0 };
const TYPICAL_SECONDS = 5;
/** Applying a result: a few GitHub calls. */
const APPLY_SECONDS = 2;
const PAGE = 50;

type Side = { auto: TriageAction[]; suggested: TriageAction[]; reason: string | null } | null;
type Verdict = RunChange | 'skipped' | 'pending';

/** How a run's settings differ from another set (current settings, or another run's). */
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
    if (!now) out.push(`Custom labels, ${g.name}: deleted since`);
    else if (JSON.stringify({ ...g, mode: '' }) !== JSON.stringify({ ...now, mode: '' })) out.push(`Custom labels, ${g.name}: labels or wording changed since`);
  }
  for (const g of b.labelGroups) if (!a.labelGroups.some((x) => x.id === g.id)) out.push(`Custom labels, ${g.name}: added since`);
  if (a.products !== b.products) out.push('About your products: changed since');
  if ((a.examples ?? null) !== (b.examples ?? null)) out.push('Examples: changed since');
  if (a.instructions !== b.instructions) out.push('Notes for Claude: changed since');
  if (JSON.stringify(a.typeRules) !== JSON.stringify(b.typeRules)) out.push('Rules by ticket type: changed since');
  if (JSON.stringify(a.appIds) !== JSON.stringify(b.appIds)) out.push('Apps triaged: changed since');
  return out;
}

const PICK_SHORT: Record<LabelGroup['pick'], string> = { one: 'One label each', two: 'Up to two each', any: 'Any number each' };
const STATUS_PILL: Record<TriageRunRow['status'], [string, Tone]> = { running: ['Running', 'warn'], done: ['Done', 'ok'], cancelled: ['Stopped', 'closed'] };
const FILTERS: RunFilter[] = ['all', 'changed', 'same', 'skipped'];
const n = (x: number) => x.toLocaleString('en-US');

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "about 2 h 10 min" */
function duration(seconds: number): string {
  if (seconds < 90) return 'about a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  return `about ${h} h${m % 60 >= 5 ? ` ${m % 60} min` : ''}`;
}

function runName(r: Pick<TriageRunRow, 'name' | 'created_at' | 'mode'>): string {
  return r.name || `${r.mode === 'preview' ? 'Preview' : 'Re-run'} of ${r.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Why a run is paused for now. */
function waitingText(r: Pick<TriageRunRow, 'waiting_until_at' | 'waiting_reason'>): string | null {
  if (!r.waiting_until_at || r.waiting_until_at.getTime() <= Date.now()) return null;
  const left = duration((r.waiting_until_at.getTime() - Date.now()) / 1000).replace('about ', '');
  return r.waiting_reason === 'github'
    ? `Waiting for GitHub’s hourly limit to reset (in ${left}), so new tickets can still be filed meanwhile. It carries on by itself.`
    : `Claude asked to slow down. It carries on by itself in ${left}.`;
}

/** A run waiting because triage is paused: why, and whether it carries on by itself. */
function pausedText(p: NonNullable<TriageSettings['paused']>): string {
  return autoChecked(p)
    ? 'Paused: the Anthropic account is out of credits. It carries on by itself once credits are added (checked every 5 minutes).'
    : 'Paused: triage is paused (see AI triage › Actions). It carries on once that’s fixed and someone presses Try again.';
}

/** The ticket's triage before the run (or in the run compared with). */
function beforeSide(item: RunItemView, vs: Map<string, RunItemView> | null): Side {
  if (vs) {
    const other = vs.get(item.subject);
    return other?.status === 'done' ? { auto: other.auto_actions ?? [], suggested: other.suggestions ?? [], reason: other.verdict?.reason ?? null } : null;
  }
  const b = beforeDecisions(item.before);
  return b ? { ...b, reason: item.before?.reason ?? null } : null;
}

function afterSide(item: RunItemView): Side {
  return item.status === 'done' ? { auto: item.auto_actions ?? [], suggested: item.suggestions ?? [], reason: item.verdict?.reason ?? null } : null;
}

function verdictOf(item: RunItemView, vs: Map<string, RunItemView> | null): Verdict {
  if (item.status === 'pending') return 'pending';
  if (item.status !== 'done') return 'skipped';
  if (!vs) return item.change ?? changeFrom(beforeDecisions(item.before), { auto: item.auto_actions ?? [], suggested: item.suggestions ?? [] });
  const b = beforeSide(item, vs);
  return changeFrom(b, { auto: item.auto_actions ?? [], suggested: item.suggestions ?? [] });
}

type FormFields = Record<string, string | string[] | undefined>;
const many = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * The start form as a scope. Custom labels only: the categories ticked, and the labels ticked in
 * them (all of them means any label; none means nothing to add, which is refused).
 */
function parseScope(form: FormFields, c: TriageConfig): RerunScope {
  const f = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
  const newest = f.count === 'newest' || (f.count === undefined && f.limit !== undefined);
  const limit = Number.parseInt(String(f.limit ?? ''), 10);
  const scope: RerunScope = {
    source: f.source === 'github' || f.source === 'all' ? f.source : 'tickets',
    untouched: f.untouched !== undefined,
    never: f.never !== undefined,
    appId: f.app_id || null,
    typeName: f.type || null,
    limit: newest ? Math.max(1, Math.min(MAX_RERUN, Number.isFinite(limit) ? limit : 50)) : MAX_RERUN,
  };
  if (f.what === 'labels') {
    const groups = many(form.group).filter((id) => c.labelGroups.some((g) => g.id === id));
    const all = categoryLabels(c, groups);
    const picked = [...new Set(many(form.only).map((l) => l.toLowerCase()))].filter((l) => all.includes(l));
    scope.labels = { groups, only: f.labels_form && picked.length < all.length ? picked : null, which: f.which === 'all' ? 'all' : 'missing' };
  }
  return scope;
}

/** "Kind and Topic" */
function categoryNames(c: TriageConfig, ids: string[]): string {
  const names = c.labelGroups.filter((g) => ids.includes(g.id)).map((g) => g.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}` : names[0] ?? 'deleted categories';
}

export function registerTriageRunRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const runsUrl = (ctx: WorkspaceRequestContext) => areaHref(ctx, 'triage.runs');

  /**
   * Average tokens per ticket lately, for the cost estimate: of full triage, or of custom-labels
   * passes. Only calls whose cached tokens were kept count (older ones would price the cache in full).
   */
  async function tokensPerTicket(workspaceId: string, labels: boolean): Promise<{ input: number; output: number; cacheRead: number; cacheWrite: number; measured: number }> {
    const { rows } = await deps.db.query<{ n: number; i: number | null; o: number | null; r: number | null; w: number | null }>(
      `SELECT count(*) AS n, avg(input_tokens) AS i, avg(output_tokens) AS o, avg(cache_read_tokens) AS r, avg(cache_write_tokens) AS w FROM (
         SELECT i.input_tokens, i.output_tokens, i.cache_read_tokens, i.cache_write_tokens FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id
         WHERE r.workspace_id = $1 AND i.cache_read_tokens IS NOT NULL AND json_extract(r.scope, '$.labels') IS ${labels ? 'NOT NULL' : 'NULL'}
         ${labels ? '' : 'UNION ALL SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM triage_results WHERE workspace_id = $1 AND cache_read_tokens IS NOT NULL'}
         LIMIT 500)`,
      [workspaceId],
    );
    const r = rows[0];
    const typical = labels ? TYPICAL_LABEL_TOKENS : TYPICAL_TOKENS;
    return r?.n && r.i ? { input: Math.round(r.i), output: Math.round(r.o ?? 0), cacheRead: Math.round(r.r ?? 0), cacheWrite: Math.round(r.w ?? 0), measured: Number(r.n) } : { ...typical, measured: 0 };
  }

  /** Seconds per ticket in recent runs (rate-limit waits included), for the time estimate. */
  async function secondsPerTicket(workspaceId: string): Promise<number> {
    const { rows } = await deps.db.query<{ created_at: Date; finished_at: Date; n: number }>(
      `SELECT r.created_at, r.finished_at, (SELECT count(*) FROM triage_run_items i WHERE i.run_id = r.id AND i.status <> 'pending') AS n
       FROM triage_runs r WHERE r.workspace_id = $1 AND r.finished_at IS NOT NULL ORDER BY r.created_at DESC LIMIT 5`,
      [workspaceId],
    );
    const ms = rows.reduce((t, r) => t + (r.finished_at.getTime() - r.created_at.getTime()), 0);
    const count = rows.reduce((t, r) => t + r.n, 0);
    return count >= 10 ? Math.max(1, Math.min(60, ms / 1000 / count)) : TYPICAL_SECONDS;
  }

  /** What a run with this scope would cover, cost and take. */
  async function estimate(workspaceId: string, scope: RerunScope) {
    const l = scope.labels;
    const none = Promise.resolve(0);
    const [settings, usage, matchedFull, perTicket, pace, untouched, never, missing, open] = await Promise.all([
      getTriageSettings(deps.db, workspaceId),
      monthlyUsage(deps.db, workspaceId),
      !l && (scope.untouched || scope.never) ? web.triage.countRerun(workspaceId, scope) : none,
      tokensPerTicket(workspaceId, Boolean(l)),
      secondsPerTicket(workspaceId),
      l ? none : web.triage.countRerun(workspaceId, { ...scope, untouched: true, never: false }),
      l ? none : web.triage.countRerun(workspaceId, { ...scope, untouched: false, never: true }),
      l?.groups.length ? web.triage.countRerun(workspaceId, { ...scope, labels: { ...l, which: 'missing' } }) : none,
      l?.groups.length ? web.triage.countRerun(workspaceId, { ...scope, labels: { ...l, which: 'all' } }) : none,
    ]);
    const matched = l ? (l.which === 'all' ? open : missing) : matchedFull;
    const c = settings.config;
    const left = Math.max(0, c.monthlyLimit - usage.triaged);
    const picked = Math.min(matched, scope.limit, MAX_RERUN, left);
    const each = tokenCost(c.model, perTicket.input, perTicket.output, { read: perTicket.cacheRead, write: perTicket.cacheWrite });
    const cost = each === null ? null : each * picked;
    const nextMonth = new Date(Date.UTC(usage.since.getUTCFullYear(), usage.since.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const refused = l && !l.groups.length ? 'Choose at least one category.' : l?.only && !l.only.length ? 'Choose at least one label to add.' : null;
    const noun = l ? 'tickets and issues' : 'tickets';
    const text = refused
      ?? (!matched
        ? l?.which === 'missing' ? 'Every open ticket and issue here has those labels already.' : 'No open tickets match.'
        : `${picked < matched ? `The newest ${n(picked)} of ${n(matched)} matching ${noun}` : sentence(plural(picked, 'ticket', noun).replace(/^\d+/, n(picked)))} · ${duration(picked * pace)}`);
    // What it costs: the total, then what it's based on.
    const costText = refused || !picked || cost === null ? '' : cost < 0.01 ? 'under $0.01' : `about ${exactCost(cost)}`;
    const basis = refused || !picked ? '' : each === null
      ? `${c.model} has no known price here.`
      : `About ${exactCost(each)} a ticket with ${c.model}, ${perTicket.measured >= 20 ? `from your last ${n(perTicket.measured)} ${l ? 'custom-label passes' : 'tickets'}` : 'estimated until a run has measured it'}. Most of each ticket is read from Claude’s cache at a tenth of the price.`;
    const confirm = refused || !picked ? '' : `Claude reads ${plural(picked, 'ticket', noun).replace(/^\d+/, n(picked))}${l ? ' and picks custom labels for them' : ''}: ${costText ? `${costText} with ${c.model}` : 'at your model’s price'}, ${duration(picked * pace)}. Each counts toward this month’s limit (${n(left)} left).`;
    const warn = refused || !matched || !picked
      ? null
      : picked < matched && picked === left
        ? `Only ${n(left)} tickets are left of this month’s limit. Raise the monthly limit in Actions to include all ${n(matched)}.`
        : left - picked < 20
          ? `This uses the rest of this month’s limit, so new tickets won’t be triaged until ${nextMonth}. Raise the monthly limit in Actions first to keep both.`
          : picked < matched && picked === MAX_RERUN
            ? `A run can have up to ${n(MAX_RERUN)} tickets; start another one for the rest.`
            : null;
    return {
      matched, picked, left, text, warn, cost: costText, basis, confirm, allLabel: `All matching (${n(matched)})`, untouched: `Triaged, nothing applied yet (${n(untouched)})`, never: `Never triaged (${n(never)})`,
      missing: `Missing these labels (${n(missing)})`, open: `Every open one (${n(open)})`,
    };
  }

  /** Using a run's settings replaces Actions, Custom labels and Prompt, so it needs Edit on each. */
  const SETTINGS_AREAS = ['triage.actions', 'triage.labels', 'triage.prompt'] as const;
  const canUseSettings = (ctx: WorkspaceRequestContext) => can(ctx.membership, 'triage.runs.edit') && SETTINGS_AREAS.every((a) => can(ctx.membership, `${a}.edit`));

  // ---- Start a run, and the list of runs -----------------------------------------------------

  app.get('/w/:wid/triage/runs', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = runsUrl(ctx);
    const [settings, apps, types, key, runs] = await Promise.all([
      getTriageSettings(deps.db, wid),
      listApps(deps.db, wid),
      listTicketTypes(deps.db, wid),
      resolveApiKey(deps, wid),
      web.triage.listRuns(wid),
    ]);
    const c = settings.config;
    const edit = can(ctx.membership, 'triage.runs.edit');
    const all: RerunScope = { source: 'tickets', untouched: true, never: true, appId: null, typeName: null, limit: MAX_RERUN };
    // Custom labels only: what the form starts with (a link from Custom labels or Overview can pick categories and labels).
    const q = req.query as FormFields;
    const groups = c.labelGroups;
    const asked = many(q.group).filter((id) => groups.some((g) => g.id === id));
    const ticked = new Set(asked.length ? asked : groups.map((g) => g.id));
    const onlyAsked = new Set(many(q.only).map((l) => l.toLowerCase()));
    const what = groups.length && (many(q.what)[0] === 'labels' || asked.length) ? 'labels' : 'full';
    const labelScope: RerunScope = { ...all, labels: { groups: [...ticked], only: onlyAsked.size ? [...onlyAsked] : null, which: 'missing' } };
    const everyLabel: RerunScope = { ...all, labels: { groups: groups.map((g) => g.id), only: null, which: 'all' } };
    const repoIds = [...new Set(apps.map((a) => a.repo_id))];
    // The start form's numbers, only for someone who can start a run.
    const [est, estLabels, ticketCount, githubCount, labelTickets, labelIssues, open, missing] = edit
      ? await Promise.all([
          estimate(wid, all), estimate(wid, labelScope),
          web.triage.countRerun(wid, all), web.triage.countRerun(wid, { ...all, source: 'github' }),
          groups.length ? web.triage.countRerun(wid, everyLabel) : 0, groups.length ? web.triage.countRerun(wid, { ...everyLabel, source: 'github' }) : 0,
          openLabels(deps.db, repoIds), openMissing(deps.db, repoIds, groups),
        ])
      : [null, null, 0, 0, 0, 0, null, null];
    const githubActions = anyActionOn(forGitHub(c));
    const running = runs.find((r) => r.status === 'running');
    const names = await userNames(deps.db, runs.map((r) => r.created_by));
    const blocked = !est ? null : !key ? 'Add a Claude API key in Settings first.' : est.left <= 0 ? 'This month’s triage limit is used up. Raise it in Actions to re-run.' : running ? 'A re-run is going. Wait for it to finish or stop it.' : null;
    const shown = (w: 'labels' | 'full') => raw(`data-shown-for="what=${w}" ${what === w ? '' : 'hidden'}`);
    const first = what === 'labels' ? estLabels : est;
    const whatCard = (value: 'labels' | 'full', name: 'tags' | 'sparkles', title: string, desc: string, off = false) => html`<label class="choice what${off ? ' off' : ''}">
        <input type="radio" name="what" value="${value}" ${value === what ? raw('checked') : ''} ${off ? raw('disabled') : ''}>
        <span class="what-i">${icon(name, 20)}</span><span><span class="t">${title}</span><span class="d">${desc}</span></span></label>`;

    const form = !est
      ? html`<div class="card-b tight">${notice('info', 'View only', 'You can see the runs below and their results. Starting, stopping and applying a re-run needs Edit on Re-run; ask an admin if you need it.')}</div>`
      : html`<form method="post" action="${b}" data-estimate="${b}/estimate" data-confirm-title="Start this run?" data-confirm-body="${first!.confirm}" data-confirm-label="Start">
      ${csrfField(ctx.csrf)}
      ${setting('What to re-run', null, html`<div class="choices what-pick" role="radiogroup">
        ${whatCard('labels', 'tags', 'Custom labels only', groups.length
          ? 'Backfill your custom labels on open tickets and issues, including the ones triage already handled. It only adds labels: no comments, nothing closed, and the rest of their triage stays as it is.'
          : 'Add custom labels first, then backfill them here.', !groups.length)}
        ${whatCard('full', 'sparkles', 'Full triage', 'Run your current settings on tickets triage hasn’t acted on yet: try a change, compare with before, then apply. Applying replaces their triage.')}
      </div>`, { stacked: true })}
      ${setting('Source', html`<span ${shown('full')}>Each uses its own settings from Actions.${githubActions ? '' : ' Every action is Off for issues opened on GitHub, so set some first to include them.'}</span><span ${shown('labels')}>Discord tickets and issues opened on GitHub get the same categories.</span>`, html`<div class="check-list stacked">
        <label class="check"><input type="radio" name="source" value="tickets" checked> ${icon('message-circle', 14, 'muted')} Discord tickets <span ${shown('full')}>(${n(ticketCount)})</span><span ${shown('labels')}>(${n(labelTickets)} open)</span></label>
        <label class="check"><input type="radio" name="source" value="github"> ${icon('github', 14, 'muted')} Issues opened on GitHub <span ${shown('full')}>(${n(githubCount)})</span><span ${shown('labels')}>(${n(labelIssues)} open)</span></label>
        <label class="check"><input type="radio" name="source" value="all"> Both</label>
      </div>`, { stacked: true })}
      <div ${shown('labels')}>
        <input type="hidden" name="labels_form" value="1">
        ${setting('Categories', 'Claude is only asked about the ticked categories. Untick labels to add just some: when you’ve added a label, tick only it to backfill it.', html`<div class="bf-cats">${groups.map((g) => html`<fieldset class="bf-cat">
            <legend class="sr-only">${g.name}</legend>
            <label class="bf-cat-h"><input type="checkbox" class="rule-check" name="group" value="${g.id}" ${ticked.has(g.id) ? raw('checked') : ''}><span class="bf-cat-n">${g.name}</span><span class="small muted">${PICK_SHORT[g.pick]} · ${open ? `${n(missing?.get(g.id) ?? 0)} of ${n(open.open)} open issues have none yet` : ''}</span></label>
            <div class="bf-labels">${g.options.map((o) => html`<label class="bf-chip" title="${o.description || o.label}"><input type="checkbox" name="only" value="${o.label.toLowerCase()}" ${!onlyAsked.size || onlyAsked.has(o.label.toLowerCase()) ? raw('checked') : ''}>${labelTag(o.label)}<span class="n" title="Open issues with this label now">${n(open?.byLabel.get(o.label.toLowerCase()) ?? 0)}</span></label>`)}</div>
          </fieldset>`)}</div>`, { stacked: true })}
        ${setting('Which ones', 'Open tickets and issues, whatever triage did with them. Closed ones are left out. Labels they have already are never added again, and none are ever removed.', html`<div class="check-list stacked">
          <label class="check"><input type="radio" name="which" value="missing" checked> <span data-count-missing>${estLabels!.missing}</span></label>
          <label class="check"><input type="radio" name="which" value="all"> <span data-count-open>${estLabels!.open}</span></label>
        </div>`, { stacked: true })}
      </div>
      <div ${shown('full')}>
        ${!anyActionOn(c) && !githubActions ? html`<div class="card-b tight">${notice('warn', null, 'Turn at least one action on in Actions first.')}</div>` : ''}
        ${setting('Which ones', 'Open, with no triage action applied yet. Closed issues are left out.', html`<div class="check-list">
          <label class="check"><input type="checkbox" name="untouched" value="1" checked> <span data-count-untouched>${est.untouched}</span></label>
          <label class="check"><input type="checkbox" name="never" value="1" checked> <span data-count-never>${est.never}</span></label>
        </div>`, { stacked: true })}
      </div>
      ${setting('App', null, selectWrap(html`<select id="run-app" name="app_id"><option value="">All apps</option>${apps.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select>`), { for: 'run-app' })}
      ${setting('Ticket type', 'Discord tickets only: issues opened on GitHub have no type.', selectWrap(html`<select id="run-type" name="type"><option value="">All types</option>${types.map((t) => html`<option value="${t.name}">${t.name}</option>`)}</select>`), { for: 'run-type' })}
      ${setting('How many', `Newest first. This month’s limit has ${n(est.left)} tickets left.`, html`<div class="check-list stacked">
        <label class="check"><input type="radio" name="count" value="all" checked> <span data-count-all>${first!.allLabel}</span></label>
        <label class="check"><input type="radio" name="count" value="newest"> Only the newest <input type="number" class="narrow" name="limit" value="50" min="1" max="${String(MAX_RERUN)}" aria-label="How many of the newest tickets"></label>
      </div>`, { stacked: true })}
      ${setting('Mode', null, html`<div class="choices" role="radiogroup">
        <label class="choice"><input type="radio" name="mode" value="preview" checked><span><span class="t">Preview (recommended)</span>
          <span class="d" ${shown('full')}>Records what triage would do. Nothing changes on GitHub. Compare it with before, then apply the results you like, all at once if you want.</span>
          <span class="d" ${shown('labels')}>Records the labels Claude would add. Nothing changes on GitHub until you add the ones you like, all at once if you want.</span></span></label>
        <label class="choice"><input type="radio" name="mode" value="apply"><span><span class="t">Apply right away</span>
          <span class="d" ${shown('full')}>${settings.enabled || settings.githubEnabled ? 'Works like normal triage: automatic actions happen on GitHub and the new suggestions replace the old ones.' : 'Needs triage to be on.'}</span>
          <span class="d" ${shown('labels')}>Adds the labels Claude is at least ${String(c.threshold)}% sure of as it goes. The ones it’s less sure of wait in the results, to add if you agree.</span></span></label>
      </div>`, { stacked: true })}
      ${setting('Name (optional)', 'To tell runs apart later.', html`<input id="run-name" type="text" name="name" maxlength="60" placeholder="${what === 'labels' ? 'Backfill Kind' : 'Stricter duplicates'}">`, { for: 'run-name' })}
      <div class="card-f run-est"><div class="run-est-b">
        <div class="run-est-m"><span class="run-est-cost" data-estimate-cost ${first!.cost ? '' : raw('hidden')}>${first!.cost}</span><span data-estimate-text>${first!.text}</span></div>
        <div class="xs muted" data-estimate-basis ${first!.basis ? '' : raw('hidden')}>${first!.basis}</div>
        <div class="warn-text small" data-estimate-warn ${first!.warn ? '' : raw('hidden')}>${first!.warn ?? ''}</div>
      </div><div class="end">
        ${submitBtn('Start', { variant: 'primary', icon: 'play', loading: 'Starting…', disabled: Boolean(blocked) })}
      </div></div>
    </form>`;

    const history = runs.length
      ? html`<div class="card-b flush"><div class="table-wrap"><table>
          <thead><tr><th>Run</th><th>Mode</th><th>Tickets</th><th>Cost</th><th>Status</th><th class="num">Started</th></tr></thead>
          <tbody>${runs.map((r) => {
            const finished = r.done + r.skipped + r.failed;
            const cost = r.input_tokens ? tokenCost(r.config_used.model, r.input_tokens, r.output_tokens ?? 0, { read: r.cache_read_tokens, write: r.cache_write_tokens }) : null;
            const waiting = r.status === 'running' ? (settings.paused ? 'paused' : waitingText(r)) : null;
            return html`<tr class="click">
              <td><a class="cell-title" href="${b}/${r.id}">${runName(r)}</a><div class="sub">${r.created_by ? names.get(r.created_by) ?? 'An admin' : 'An admin'} · ${r.config_used.model}</div></td>
              <td><div class="tags">${r.scope.labels ? tag('Custom labels', { icon: 'tags', title: `Custom labels only: ${categoryNames(r.config_used, r.scope.labels.groups)}` }) : ''}${r.mode === 'preview' ? tag('Preview', { icon: 'flask-conical' }) : tag('Applied', { icon: 'play' })}</div>${r.mode === 'preview' && r.applied ? html`<div class="sub">${n(r.applied)} applied</div>` : ''}</td>
              <td class="num">${r.status === 'running' ? html`${n(finished)} of ${n(r.total)}<progress class="bar" max="${String(r.total || 1)}" value="${String(finished)}"></progress>` : html`${n(r.done)} triaged${r.skipped + r.failed ? html`<div class="sub">${n(r.skipped + r.failed)} skipped</div>` : ''}`}</td>
              <td>${cost !== null ? exactCost(cost) : html`<span class="em">—</span>`}${r.status === 'running' && cost !== null ? html`<div class="sub">so far</div>` : ''}</td>
              <td>${pill(...STATUS_PILL[r.status])}${waiting === 'paused' ? html`<div class="sub warn-text">Paused: triage is paused</div>` : waiting ? html`<div class="sub">Waiting for ${r.waiting_reason === 'github' ? 'GitHub' : 'Claude'}</div>` : r.applying ? html`<div class="sub">Applying ${n(r.applying)}…</div>` : ''}</td>
              <td class="num">${when(r.created_at)}</td>
            </tr>`;
          })}</tbody></table></div></div>`
      : empty('history', 'No re-runs yet', edit ? 'Start a preview above to see what your settings would do.' : 'Re-runs your team starts show up here, with their results.');

    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.runs')}
      <div class="stack">
        ${running ? notice('info', 'A re-run is going', `${runName(running)}: ${n(running.done + running.skipped + running.failed)} of ${n(running.total)} tickets. ${(settings.paused ? pausedText(settings.paused) : waitingText(running)) ?? 'It uses the time between new tickets, so filing and normal triage are never delayed.'}`, { action: linkBtn(`${b}/${running.id}`, 'View', { size: 'sm', trail: 'arrow-right' }) }) : ''}
        ${blocked && !running ? notice('warn', null, blocked) : ''}
        <div class="card">
          <div class="card-h"><div><h2>Re-run triage</h2><div class="desc">Run Claude again on tickets that are already filed: backfill your custom labels, or try your current settings and compare. Preview first, then apply the results you like in bulk. Each ticket counts toward the monthly limit.</div></div></div>
          ${form}
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Runs</h2><div class="desc">Each run keeps the settings it used, so you can compare runs and go back to the settings you liked best.</div></div></div>
          ${history}
        </div>
      </div>`;
    return web.render(reply, ctx, 'Re-run · AI triage', 'triage', body);
  });

  /** Live estimate for the start form (count, cost, time, monthly limit). */
  app.get('/w/:wid/triage/runs/estimate', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.view' });
    if (!ctx) return reply;
    const c = (await getTriageSettings(deps.db, ctx.workspace.id)).config;
    const e = await estimate(ctx.workspace.id, parseScope(req.query as FormFields, c));
    return reply.header('Cache-Control', 'no-store').send({ text: e.text, warn: e.warn, cost: e.cost, basis: e.basis, confirm: e.confirm, allLabel: e.allLabel, untouched: e.untouched, never: e.never, missing: e.missing, open: e.open });
  });

  app.post('/w/:wid/triage/runs', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.edit' });
    if (!ctx) return reply;
    const form = (req.body ?? {}) as FormFields;
    const f = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
    try {
      const scope = parseScope(form, (await getTriageSettings(deps.db, ctx.workspace.id)).config);
      if (!scope.labels && !scope.untouched && !scope.never) throw new UserFacingError('Choose which tickets to include.');
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

  app.get('/w/:wid/triage/runs/:rid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const rid = (req.params as { rid: string }).rid;
    const q = req.query as { show?: string; vs?: string; partial?: string; page?: string };
    const run = /^[0-9a-f-]{36}$/i.test(rid) ? await web.triage.getRun(wid, rid) : null;
    if (!run) return reply.callNotFound();
    const b = `${runsUrl(ctx)}/${run.id}`;
    const show: RunFilter = FILTERS.includes(q.show as RunFilter) ? (q.show as RunFilter) : 'all';
    const lr = run.scope.labels ?? null;
    const [counts, settings, runs, totals, labelsLeft] = await Promise.all([
      web.triage.runCounts(run.id, run.applied_at), getTriageSettings(deps.db, wid), web.triage.listRuns(wid, 50),
      lr ? web.triage.runLabelTotals(run.id) : [], lr ? web.triage.labelsLeft(run.id) : 0,
    ]);
    const runGroups = lr ? run.config_used.labelGroups.filter((g) => lr.groups.includes(g.id)) : [];
    const vsRun = q.vs && q.vs !== run.id ? runs.find((r) => r.id === q.vs) ?? null : null;

    // Compared with before: counted and paged in the database. Compared with another run:
    // worked out here (both runs' tickets are loaded).
    let items: RunItemView[];
    let vs: Map<string, RunItemView> | null = null;
    let tally: Record<'changed' | 'new' | 'same' | 'skipped', number>;
    let matching: number;
    let page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
    if (vsRun) {
      vs = new Map((await web.triage.runItems(vsRun.id)).map((i) => [i.subject, i]));
      const allItems = await web.triage.runItems(run.id);
      const v = new Map(allItems.map((i) => [i.subject, verdictOf(i, vs)]));
      const count = (x: Verdict[]) => allItems.filter((i) => x.includes(v.get(i.subject)!)).length;
      tally = { changed: count(['changed']), new: count(['new']), same: count(['same']), skipped: count(['skipped']) };
      const shownAll = allItems.filter((i) => {
        const x = v.get(i.subject)!;
        return show === 'all' || (show === 'changed' ? x === 'changed' || x === 'new' : show === 'same' ? x === 'same' : x === 'skipped');
      });
      matching = shownAll.length;
      page = Math.min(page, Math.max(1, Math.ceil(matching / PAGE)));
      items = shownAll.slice((page - 1) * PAGE, page * PAGE);
    } else {
      tally = { changed: counts.changed, new: counts.new, same: counts.same, skipped: counts.skipped };
      matching = show === 'all' ? counts.total : show === 'changed' ? counts.changed + counts.new : show === 'same' ? counts.same : counts.skipped;
      page = Math.min(page, Math.max(1, Math.ceil(matching / PAGE)));
      items = await web.triage.runPage(run.id, show, PAGE, (page - 1) * PAGE);
    }
    const pages = Math.max(1, Math.ceil(matching / PAGE));
    const applying = counts.applying > 0;
    const live = run.status === 'running' || applying;
    const edit = can(ctx.membership, 'triage.runs.edit');
    // An issue's own page needs one of the GitHub issues pages; without it, the #N below links to GitHub.
    const issuePages = canOpenIssue(ctx.membership);
    // Updating the inbox works while triage is off; applying on GitHub needs it on.
    const canApply = edit && run.mode === 'preview' && run.status !== 'running' && !applying && !vsRun;
    // A backfill's result can still take its less sure labels after the sure ones were added.
    const applicable = (i: RunItemView) => i.status === 'done' && (lr
      ? Boolean(i.auto_actions?.length || i.suggestions?.length) && (i.apply_status === null || i.apply_status === 'failed' || (i.apply_status === 'done' && !i.apply_suggestions && Boolean(i.suggestions?.length)))
      : i.apply_status === null || i.apply_status === 'failed');
    const anyApply = items.some((i) => i.apply_status !== null) || counts.applied + counts.notApplied + counts.applying > 0;
    const link = (o: { show?: RunFilter; vs?: string | null; page?: number }) => {
      const p = new URLSearchParams();
      const s = o.show ?? show;
      const v = o.vs === undefined ? vsRun?.id ?? null : o.vs;
      const pg = o.page ?? (o.show && o.show !== show ? 1 : page);
      if (s !== 'all') p.set('show', s);
      if (v) p.set('vs', v);
      if (pg > 1) p.set('page', String(pg));
      const qs = p.toString();
      return qs ? `${b}?${qs}` : b;
    };
    const finished = counts.total - counts.pending;
    const cost = counts.inputTokens ? tokenCost(run.config_used.model, counts.inputTokens, counts.outputTokens, { read: counts.cacheReadTokens, write: counts.cacheWriteTokens }) : null;
    // While it runs: what it cost so far, and what it will once every ticket is read (at the pace of the ones read).
    const projected = cost !== null && counts.readCount >= 1 ? cost + (cost / counts.readCount) * counts.pending : null;
    const repoOf = (i: { repo_owner: string; repo_name: string }) => ({ owner: i.repo_owner, name: i.repo_name });
    const waiting = live ? (settings.paused ? pausedText(settings.paused) : waitingText(run)) : null;

    // Time left, from the pace so far.
    const evalPace = finished >= 3 && counts.lastDoneAt ? Math.max(1, (counts.lastDoneAt.getTime() - run.created_at.getTime()) / 1000 / finished) : TYPICAL_SECONDS;
    const applyPace = counts.appliedSince >= 3 && counts.lastApplyAt && run.applied_at ? Math.max(0.5, (counts.lastApplyAt.getTime() - run.applied_at.getTime()) / 1000 / counts.appliedSince) : APPLY_SECONDS;

    const sideCell = (s: Side, i: RunItemView, o: { label: 'before' | 'after' }) => {
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

    // A custom-labels backfill: the labels from its categories the issue had, and what Claude picked in each.
    const threshold = run.config_used.threshold;
    const hadCell = (i: RunItemView) => {
      const had = i.before?.labels ?? [];
      return html`<div class="run-cell">${had.length ? html`<span class="tags">${had.map(labelTag)}</span>` : html`<span class="em">None of these</span>`}</div>`;
    };
    const pickedCell = (i: RunItemView) => {
      if (i.status === 'pending') return html`<div class="run-cell"><span class="em">Waiting…</span></div>`;
      if (i.status !== 'done') return html`<div class="run-cell"><span class="muted">Skipped: ${i.note ?? 'no result'}</span></div>`;
      const picks = (i.verdict as unknown as { labels?: Record<string, { options: string[]; confidence: number }> } | null)?.labels ?? {};
      const sure = new Set((i.auto_actions ?? []).flatMap((a) => a.labels ?? []));
      const unsure = new Set((i.suggestions ?? []).flatMap((a) => a.labels ?? []));
      const had = new Set((i.before?.labels ?? []).map((l) => l.toLowerCase()));
      return html`<div class="run-cell">
        ${runGroups.map((g) => {
          const p = picks[g.id];
          const chosen = p?.options ?? [];
          return html`<div class="bf-pick"><span class="bf-pick-g">${g.name}</span>${chosen.length
            ? html`<span class="tags">${chosen.map((l) => sure.has(l)
                ? html`<span class="bf-add sure" title="Added: Claude is ${String(p!.confidence)}% sure">${icon('plus', 12)}${labelTag(l)}</span>`
                : unsure.has(l)
                  ? html`<span class="bf-add unsure" title="Not added unless you add every label: Claude is only ${String(p!.confidence)}% sure">${icon('circle-help', 12)}${labelTag(l)}</span>`
                  : html`<span class="bf-add has" title="${had.has(l.toLowerCase()) ? 'It has this label already' : 'Not one of the labels this run adds'}">${labelTag(l)}</span>`)}</span><span class="bf-conf ${p!.confidence >= threshold ? 'ok' : 'warn'}">${String(p!.confidence)}%</span>`
            : html`<span class="em">Nothing fits</span>`}</div>`;
        })}
        ${i.verdict?.reason ? html`<details><summary>Claude’s reason</summary><p class="small muted">${i.verdict.reason}</p></details>` : ''}
      </div>`;
    };

    const applyCell = (i: RunItemView) => {
      if (!i.apply_status) return html`<span class="em">—</span>`;
      if (lr) {
        // Added: the labels are on GitHub. Less sure ones left can still be added with every label.
        const left = i.apply_status === 'done' && !i.apply_suggestions ? (i.suggestions ?? []).flatMap((a) => a.labels ?? []).length : 0;
        const [label, tone] = ({ pending: ['Queued', 'neutral'], done: ['Added', 'ok'], skipped: ['Not added', 'closed'], failed: ['Failed', 'danger'] } as const)[i.apply_status];
        return html`${pill(label, tone)}${left ? html`<div class="sub">${plural(left, 'less sure label')} left</div>` : ''}${i.apply_note ? html`<div class="sub">${i.apply_note}</div>` : ''}`;
      }
      const [label, tone] = ({ pending: ['Queued', 'neutral'], done: [i.apply_inbox_only ? 'In the inbox' : 'Applied', 'ok'], skipped: ['Not applied', 'closed'], failed: ['Failed', 'danger'] } as const)[i.apply_status];
      const how = i.apply_status === 'pending' ? (i.apply_inbox_only ? 'Inbox only' : i.apply_suggestions ? 'With suggestions' : null) : i.apply_status === 'done' && i.apply_inbox_only ? 'As suggestions' : null;
      return html`${pill(label, tone)}${how ? html`<div class="sub">${how}</div>` : ''}${i.apply_note ? html`<div class="sub">${i.apply_note}</div>` : ''}`;
    };

    // Checkboxes only while something on this page can still be applied.
    const selectable = canApply && items.some(applicable);
    const table = items.length
      ? html`<div class="table-wrap"><table>
          <thead><tr>${selectable ? html`<th class="check-col"><input type="checkbox" class="rule-check" data-select-all="apply-run" aria-label="Select every result on this page"></th>` : ''}<th${lr ? raw(' class="bf-ticket"') : ''}>Ticket</th><th class="${lr ? 'bf-had' : 'half'}">${lr ? 'Before' : vsRun ? `In ${runName(vsRun)}` : 'Before'}</th><th class="half">${lr ? 'Claude picked' : 'This run'}</th>${anyApply ? html`<th>${lr ? 'Added' : 'Applied'}</th>` : ''}</tr></thead>
          <tbody>${items.map((i) => {
            const v = verdictOf(i, vs);
            const changed = v === 'changed' || v === 'new';
            return html`<tr class="${changed ? 'changed' : ''}">
              ${selectable ? html`<td class="check-col">${applicable(i) ? html`<input type="checkbox" class="rule-check" name="ticket" value="${i.subject}" form="apply-run" ${changed && i.apply_status !== 'done' ? raw('checked') : ''} aria-label="Apply ${i.ref}">` : ''}</td>` : ''}
              <td>${i.submission_id || issuePages
                ? html`<a class="cell-title" href="${i.submission_id ? `${ctx.base}/tickets/${i.submission_id}` : `${ctx.base}/issues/${String(i.gh_repo_id)}/${String(i.gh_number)}`}">${i.issue_title ?? i.ref}</a>`
                : html`<span class="cell-title">${i.issue_title ?? i.ref}</span>`}
                <div class="sub">${i.issue_number ? html`<a href="https://github.com/${i.repo_owner}/${i.repo_name}/issues/${String(i.issue_number)}" target="_blank" rel="noopener noreferrer">#${String(i.issue_number)}</a> · ` : ''}${i.app_name ?? i.repo_name}${i.ticket_type_name ? ` · ${i.ticket_type_name}` : ''}${i.submission_id ? '' : ' · opened on GitHub'}</div>
                ${lr ? '' : v === 'changed' ? html`<div class="mt-8">${tag('Changed', { cls: 'diff-tag' })}</div>` : v === 'new' ? html`<div class="mt-8">${tag('New', { cls: 'diff-tag' })}</div>` : ''}</td>
              <td>${lr ? hadCell(i) : sideCell(beforeSide(i, vs), i, { label: 'before' })}</td>
              <td>${lr ? pickedCell(i) : sideCell(afterSide(i), i, { label: 'after' })}</td>
              ${anyApply ? html`<td>${applyCell(i)}</td>` : ''}
            </tr>`;
          })}</tbody></table></div>
          ${pages > 1 ? html`<div class="pager"><span>Page ${n(page)} of ${n(pages)} · ${plural(matching, 'ticket').replace(/^\d+/, n(matching))}</span><div class="row">
            ${page > 1 ? linkBtn(link({ page: page - 1 }), 'Previous', { size: 'sm', icon: 'chevron-left' }) : ''}${page < pages ? linkBtn(link({ page: page + 1 }), 'Next', { size: 'sm', trail: 'chevron-right' }) : ''}</div></div>` : ''}`
      : html`<div class="card-b">${lr
        ? empty('circle-check', show === 'changed' ? 'No labels to add' : 'Nothing here', show === 'changed' ? 'So far, Claude found nothing to add: every ticket has the labels it picked, or nothing fits.' : 'No tickets match this filter.')
        : empty('circle-check', show === 'changed' ? 'No changes' : 'Nothing here', show === 'changed' ? 'This run decided the same as before for every ticket so far.' : 'No tickets match this filter.')}</div>`;

    // Applying everything in the filter (not just this page). A backfill's are the ones that get labels.
    const bulkCount = lr ? (show === 'all' || show === 'changed' ? labelsLeft : 0) : counts.applicable[show];
    const bulkLabel = lr ? 'that get labels' : show === 'changed' ? 'changed results' : show === 'same' ? 'unchanged results' : 'results';
    // Each choice brings its own confirmation (app.js copies it onto the form).
    const modes = lr ? [
      { value: 'auto', label: `Add the labels Claude is at least ${threshold}% sure of`, title: 'Add these labels on GitHub?', body: `Each issue gets the labels Claude was at least ${threshold}% sure of. Nothing else changes: no comments, nothing closed, and its triage stays as it is. Labels are never removed. Issues closed since are skipped. It runs in the background, one at a time, and you can stop it.`, confirm: 'Add labels' },
      { value: 'all', label: 'Add every label Claude picked', title: 'Add every label Claude picked?', body: 'Each issue gets every label Claude picked for it, also the ones it was less sure of. Nothing else changes: no comments, nothing closed, and its triage stays as it is. Labels are never removed. Issues closed since are skipped. It runs in the background, one at a time, and you can stop it.', confirm: 'Add every label' },
    ] : [
      { value: 'inbox', label: 'Update the inbox only (nothing on GitHub)', title: 'Update the inbox with these results?', body: 'Each ticket’s triage is replaced with this run’s result, and every action becomes a suggestion you can apply or dismiss on its own. Nothing is sent to GitHub.', confirm: 'Update the inbox' },
      ...(settings.enabled ? [
        { value: 'auto', label: 'Apply automatic actions on GitHub', title: 'Apply these results on GitHub?', body: `Each ticket’s triage is replaced with this run’s result. The actions Claude was at least ${threshold}% sure of happen on GitHub (labels, comments, closing); the rest become suggestions. Tickets closed or acted on since are skipped. It runs in the background, one ticket at a time, and you can stop it.`, confirm: 'Apply on GitHub' },
        { value: 'all', label: 'Apply everything on GitHub (suggestions too)', title: 'Apply everything on GitHub?', body: 'Each ticket’s triage is replaced with this run’s result, and all its actions happen on GitHub, suggestions included: labels, comments and closing. Tickets closed or acted on since are skipped. It runs in the background, one ticket at a time, and you can stop it.', confirm: 'Apply everything' },
      ] : []),
    ];
    const bulkBar = canApply && (bulkCount > 0 || items.some(applicable)) ? html`<div class="bulk-bar">
        <span class="small muted" data-selected-text="apply-run" data-empty-text="Select results on this page, or use them all.">Select results on this page, or use them all.</span>
        <div class="row">
          ${selectWrap(html`<select name="include" form="apply-run" aria-label="What to do with the results" data-confirm-options>${modes.map((m) => html`<option value="${m.value}" data-confirm-title="${m.title}" data-confirm-body="${m.body}" data-confirm-label="${m.confirm}">${m.label}</option>`)}</select>`, { sm: true })}
          ${submitBtn('Selected', { size: 'sm', name: 'scope', value: 'selected', form: 'apply-run', attrs: raw('data-needs-selection="apply-run"') })}
          ${bulkCount ? submitBtn(`All ${n(bulkCount)} ${bulkLabel}`, { variant: 'primary', size: 'sm', icon: 'play', name: 'scope', value: 'filter', form: 'apply-run' }) : ''}
        </div>
      </div>
      ${lr ? html`<p class="card-note">Only labels are added, on GitHub: no comment is posted, nothing is closed, labels are never removed and each ticket’s triage stays as it is. It all runs in the background, and you can stop it.</p>` : html`<p class="card-note"><strong>Update the inbox only</strong> replaces each ticket’s triage with this run’s result as suggestions, so the inbox shows the new calls and you approve them ticket by ticket. Nothing is sent to GitHub.${settings.enabled ? ` The GitHub options also do the actions: automatic ones are the calls Claude was at least ${threshold}% sure of.` : ' Turn triage on to also apply results on GitHub.'} It all runs in the background, and you can stop it.</p>`}` : '';

    const progress = live ? html`<div class="card-b tight">
        ${run.status === 'running'
          ? html`<div class="row run-prog"><span class="small"><strong>${n(finished)}</strong> of ${n(counts.total)} tickets done${waiting ? '' : ` · ${duration(counts.pending * evalPace)} left`}</span>
              ${cost !== null ? html`<span class="small run-cost" title="What Claude has cost for this run so far, and what it will at the same average once every ticket is read"><strong>${exactCost(cost)}</strong> so far${projected !== null ? html` · about <strong>${exactCost(projected)}</strong> when done` : ''}</span>` : ''}</div>
            <progress class="bar wide" max="${String(counts.total || 1)}" value="${String(finished)}"></progress>`
          : html`<div class="row"><span class="small">Applying results: <strong>${n(counts.applying)}</strong> to go${waiting ? '' : ` · ${duration(counts.applying * applyPace)} left`}</span></div>
            <progress class="bar wide" max="${String(counts.applying + counts.appliedSince || 1)}" value="${String(counts.appliedSince)}"></progress>`}
        <p class="xs muted mt-8">${waiting ?? 'This runs in the background between new tickets, so filing and normal triage are never delayed. You can leave this page.'}</p>
      </div>` : '';

    // A backfill: per label, how many tickets it would go on (sure, and less sure) and how many got it.
    const most = Math.max(1, ...totals.map((t) => t.sure + t.unsure));
    const totalsCard = lr ? html`<div class="card-b bf-totals">
        <div class="bf-totals-h"><h3>What this run adds</h3><span class="small muted">${totals.length ? html`<span class="bf-key sure"></span>at least ${String(threshold)}% sure <span class="bf-key unsure"></span>less sure` : ''}</span></div>
        ${totals.length
          ? html`<ul class="bf-bars">${totals.map((t) => html`<li>
              <span class="bf-bar-l">${labelTag(t.label)}<span class="xs muted">${t.category}</span></span>
              <span class="bf-bar" aria-hidden="true"><i class="sure" style="width:${String((t.sure / most) * 100)}%"></i><i class="unsure" style="width:${String((t.unsure / most) * 100)}%"></i></span>
              <span class="bf-bar-n"><b>${n(t.sure)}</b>${t.unsure ? html` <span class="muted">+${n(t.unsure)}</span>` : ''}${t.added ? html` <span class="ok-text" title="Added on GitHub">· ${n(t.added)} added</span>` : ''}</span>
            </li>`)}</ul>`
          : html`<p class="small muted">${counts.pending ? 'Labels show up here as Claude reads each ticket.' : 'Claude found no labels to add.'}</p>`}
      </div>` : '';

    const results = html`
      ${progress}
      ${lr ? html`<div class="stats four">
        <a class="stat" href="${link({ show: 'changed' })}"><div class="l">Get labels</div><div class="v">${n(tally.changed + tally.new)}</div></a>
        <a class="stat" href="${link({ show: 'same' })}"><div class="l">Nothing to add</div><div class="v">${n(tally.same)}</div></a>
        <a class="stat" href="${link({ show: 'skipped' })}"><div class="l">Skipped</div><div class="v">${n(tally.skipped)}</div></a>
        <div class="stat"><div class="l">Added on GitHub</div><div class="v">${n(counts.applied)}</div></div>
      </div>
      ${totalsCard}` : html`<div class="stats four">
        <a class="stat" href="${link({ show: 'changed' })}"><div class="l">Changed</div><div class="v">${n(tally.changed)}</div></a>
        <a class="stat" href="${link({ show: 'changed' })}"><div class="l">${vsRun ? 'Only in this run' : 'New (not triaged before)'}</div><div class="v">${n(tally.new)}</div></a>
        <a class="stat" href="${link({ show: 'same' })}"><div class="l">Same as ${vsRun ? 'that run' : 'before'}</div><div class="v">${n(tally.same)}</div></a>
        <a class="stat" href="${link({ show: 'skipped' })}"><div class="l">Skipped</div><div class="v">${n(tally.skipped)}</div></a>
      </div>`}
      <div class="card-b tight"><div class="row">${segLinks('Show', [
        { href: link({ show: 'all' }), label: 'All', count: tally.changed + tally.new + tally.same + tally.skipped + (vsRun ? 0 : counts.pending), current: show === 'all' },
        { href: link({ show: 'changed' }), label: lr ? 'Get labels' : 'Changed', count: tally.changed + tally.new, current: show === 'changed' },
        { href: link({ show: 'same' }), label: lr ? 'Nothing to add' : 'Same', count: tally.same, current: show === 'same' },
        { href: link({ show: 'skipped' }), label: 'Skipped', count: tally.skipped, current: show === 'skipped' },
      ])}${counts.applied || counts.notApplied ? html`<span class="small muted">${n(counts.applied)} applied${counts.notApplied ? ` · ${n(counts.notApplied)} not applied (see the Applied column)` : ''}</span>` : ''}</div></div>
      ${bulkBar}
      ${table}
      ${live ? '' : html`<span data-live-reload hidden></span>`}`;

    if (q.partial === '1') {
      return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(results.toString());
    }

    const diff = configDiff(run.config_used, settings.config);
    const vsDiff = vsRun ? configDiff(run.config_used, vsRun.config_used) : null;
    const names = await userNames(deps.db, [run.created_by, run.applied_by]);
    // Comparing runs is for full triage; a backfill compares with the labels each ticket has.
    const others = lr ? [] : runs.filter((r) => r.id !== run.id && r.status !== 'running');
    const matched = run.scope.matched ?? counts.total;

    const body = html`
      ${pageHeader({
        title: runName(run),
        crumbs: [{ href: toolHref(ctx, 'triage') ?? undefined, label: 'AI triage' }, { href: runsUrl(ctx), label: 'Re-run' }, { label: runName(run) }],
        after: [lr ? tag('Custom labels', { icon: 'tags' }) : '', run.mode === 'preview' ? tag('Preview', { icon: 'flask-conical' }) : tag('Applied', { icon: 'play' }), pill(...STATUS_PILL[run.status]), edit ? '' : viewOnlyTag('You can see this run and its results. Ask an admin if you need to stop or apply it.')],
        description: `${lr ? `${categoryNames(run.config_used, lr.groups)}${lr.only ? ` (only ${lr.only.join(', ')})` : ''} · ` : ''}${matched > counts.total ? `The newest ${n(counts.total)} of ${n(matched)} matching tickets` : sentence(plural(counts.total, 'ticket').replace(/^\d+/, n(counts.total)))} · ${run.config_used.model} · started by ${run.created_by ? names.get(run.created_by) ?? 'an admin' : 'an admin'} ${timeAgo(run.created_at)}${cost !== null ? ` · ${exactCost(cost)}${counts.pending ? ' so far' : ''}` : ''}${run.applied_at ? ` · applied by ${run.applied_by ? names.get(run.applied_by) ?? 'an admin' : 'an admin'} ${timeAgo(run.applied_at)}` : ''}`,
        actions: [
          canOpen(ctx.membership, 'triage.activity') ? linkBtn(`${areaHref(ctx, 'triage.activity')}?run=${run.id}`, 'Activity log', { icon: 'history' }) : null,
          !edit ? null : run.status === 'running' ? postBtn(`${b}/cancel`, 'Stop', ctx.csrf, { icon: 'circle-x', confirm: { title: 'Stop this re-run?', body: 'Tickets not reached yet are skipped. Results so far are kept, and you can apply them.', label: 'Stop' } }) : null,
          edit && applying ? postBtn(`${b}/stop-applying`, 'Stop applying', ctx.csrf, { icon: 'circle-x', confirm: { title: 'Stop applying?', body: 'Tickets already applied stay applied. The rest go back to not applied, so you can apply them later.', label: 'Stop applying' } }) : null,
          diff.length && canUseSettings(ctx) ? postBtn(`${b}/use-settings`, 'Use these settings', ctx.csrf, { icon: 'rotate-ccw', confirm: { title: 'Use the settings from this run?', body: 'Your current triage settings (actions, custom labels and prompt) are replaced with the ones this run used. New tickets use them right away.', label: 'Use these settings' } }) : null,
          edit && run.status !== 'running' && !applying ? menu([{ post: `${b}/delete`, label: 'Delete run', icon: 'trash-2', danger: true, confirm: { title: 'Delete this run?', body: 'Its results are deleted here. Nothing changes on GitHub.', label: 'Delete', danger: true } }], { csrf: ctx.csrf, label: 'More actions' }) : null,
        ],
      })}
      <div class="stack">
        <details class="card">
          <summary>${icon('sliders-horizontal', 16)}<span>Settings used</span><span class="small muted">${diff.length ? `${plural(diff.length, 'difference')} from your current settings` : 'Same as your current settings'}</span>${icon('chevron-down', 16, 'chev')}</summary>
          ${lr ? html`<div class="card-b tight"><ul class="tri-effects">
            <li>${icon('tags', 14)}<span>Custom labels only: ${categoryNames(run.config_used, lr.groups)}. ${lr.only ? `Adds only ${lr.only.join(', ')}.` : 'Adds any of their labels.'} ${lr.which === 'all' ? 'Every open ticket and issue.' : 'Open ones that had none of those labels.'}</span></li>
            <li>${icon('sliders-horizontal', 14)}<span>Added automatically when Claude is at least ${String(threshold)}% sure.</span></li>
          </ul></div>` : ''}
          <div class="card-b tight">${diff.length ? html`<ul class="tri-effects">${diff.map((d) => html`<li>${icon('arrow-right', 14)}<span>${d}</span></li>`)}</ul>` : html`<p class="small muted">This run used the settings you have now.</p>`}</div>
        </details>
        <div class="card">
          <div class="card-h"><div><h2>Results</h2><div class="desc">${lr ? 'The labels each ticket has from these categories, and what Claude picked. Tick the ones to add, or add them all.' : vsRun ? html`Compared with ${runName(vsRun)}.${vsDiff?.length ? html` Differences in settings: ${vsDiff.join('; ')}.` : ' Both runs used the same settings.'} Switch back to “Compare with before” to apply results.` : 'Compared with each ticket’s triage before the run. Highlighted rows changed.'}</div></div>
            ${others.length ? html`<form method="get" action="${b}" class="row">${show !== 'all' ? html`<input type="hidden" name="show" value="${show}">` : ''}
              ${selectWrap(html`<select name="vs" aria-label="Compare with"><option value="">Compare with before</option>${others.map((r) => html`<option value="${r.id}" ${r.id === vsRun?.id ? raw('selected') : ''}>Compare with ${runName(r)}</option>`)}</select>`, { sm: true })}
              ${submitBtn('Compare', { size: 'sm', icon: 'git-compare-arrows' })}</form>` : ''}</div>
          ${canApply ? html`<form id="apply-run" method="post" action="${b}/apply" data-confirm-title="${modes[0]!.title}" data-confirm-body="${modes[0]!.body}" data-confirm-label="${modes[0]!.confirm}">${csrfField(ctx.csrf)}<input type="hidden" name="show" value="${show}"></form>` : ''}
          <div ${live ? raw(`data-live="4000" data-live-src="${link({}).includes('?') ? `${link({})}&partial=1` : `${link({})}?partial=1`}"`) : ''}>${results}</div>
        </div>
      </div>`;
    return web.render(reply, ctx, `${runName(run)} · Re-run`, 'triage', body, { width: 'full' });
  });

  app.post('/w/:wid/triage/runs/:rid/cancel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.edit' });
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    try {
      await web.triage.cancelRun(ctx.workspace.id, rid, ctx.user.id);
      setFlash(reply, 'success', 'Re-run stopped. You can still apply the results it has.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${runsUrl(ctx)}/${rid}`);
  });

  app.post('/w/:wid/triage/runs/:rid/apply', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.edit' });
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    const f = (req.body ?? {}) as { ticket?: string | string[]; scope?: string; show?: string; include?: string };
    // Items are 'sub:<ticket id>' or 'gh:<repo>:<number>'; a bare id (a page from before) is a ticket.
    const ids = (f.ticket === undefined ? [] : Array.isArray(f.ticket) ? f.ticket : [f.ticket]).map((x) => (/^(sub|gh):/.test(x) ? x : `sub:${x}`));
    const filter: RunFilter = FILTERS.includes(f.show as RunFilter) && f.show !== 'skipped' ? (f.show as RunFilter) : 'all';
    try {
      const count = await web.triage.applyPreview(ctx.workspace.id, rid, ctx.user.id, {
        ...(f.scope === 'filter' ? { filter } : { ids }),
        mode: f.include === 'all' ? 'all' : f.include === 'auto' ? 'auto' : 'inbox',
      });
      const tickets = plural(count, 'ticket').replace(/^\d+/, n(count));
      setFlash(reply, 'success', f.include === 'all' || f.include === 'auto'
        ? `Applying ${tickets} on GitHub, one at a time. This page shows the progress, and you can leave it.`
        : `Updating the inbox for ${tickets}. Nothing is sent to GitHub; approve each suggestion on its ticket.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${runsUrl(ctx)}/${rid}${filter !== 'all' ? `?show=${filter}` : ''}`);
  });

  app.post('/w/:wid/triage/runs/:rid/stop-applying', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.edit' });
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    try {
      const count = await web.triage.stopApplying(ctx.workspace.id, rid, ctx.user.id);
      setFlash(reply, 'success', count ? `Stopped. ${plural(count, 'result').replace(/^\d+/, n(count))} weren’t applied and can be applied later.` : 'Nothing was waiting to be applied.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${runsUrl(ctx)}/${rid}`);
  });

  app.post('/w/:wid/triage/runs/:rid/use-settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.edit' });
    if (!ctx) return reply;
    const rid = (req.params as { rid: string }).rid;
    const run = await web.triage.getRun(ctx.workspace.id, rid);
    if (!run) return reply.callNotFound();
    if (!canUseSettings(ctx)) {
      const missing = SETTINGS_AREAS.filter((a) => !can(ctx.membership, `${a}.edit`)).map((a) => AREAS[a].name);
      setFlash(reply, 'error', `Using a run’s settings replaces Actions, Custom labels and Prompt, so it needs Edit on all three. You can’t change ${missing.join(' or ')}.`);
      return reply.redirect(`${runsUrl(ctx)}/${rid}`);
    }
    await saveTriageConfig(deps.db, ctx.workspace.id, run.config_used);
    setFlash(reply, 'success', `Now using the settings from ${runName(run)}`);
    return reply.redirect(`${runsUrl(ctx)}/${rid}`);
  });

  app.post('/w/:wid/triage/runs/:rid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.runs.edit' });
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

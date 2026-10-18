/**
 * AI triage › Knowledge: each app's TRIAGE.md. Claude writes it from the app's repository and its
 * issues, open and closed, and reads it with every ticket for that app; the team can add notes
 * that Claude never changes. Also the questions Claude asks while triaging, and the answers it
 * finds. Team-only: nothing here is posted on GitHub or shown to members.
 */
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db/database.js';
import { can } from '../../domain/permissions.js';
import { getApp, listApps } from '../../domain/store.js';
import { UserFacingError, type AppRow } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { knowledgePromptFor } from '../../triage/engine.js';
import {
  cleanKnowledge,
  getKnowledge,
  isBlank,
  isWritten,
  KNOWLEDGE_MAX,
  KNOWLEDGE_SECTIONS,
  listKnowledge,
  listQuestions,
  notesOf,
  questionCounts,
  saveKnowledge,
  sectionsOf,
  type AppKnowledge,
  type Question,
} from '../../triage/knowledge.js';
import { CHANGES_ESTIMATE, splitAnswers, WRITE_ESTIMATE } from '../../triage/knowledge-writer.js';
import { CHANGE_STEPS, emptyLive, finishRunIfDone, latestRun, LIVE_STEPS, requestWrites, stopWrites, type LiveState, type LiveStep, type LiveTag } from '../../triage/knowledge-runs.js';
import { appChanges, changeCounts, changeLabel, changeSync, NOT_USED, recentChanges, type AppChange } from '../../triage/knowledge-changes.js';
import { formatCost, getTriageSettings, KNOWLEDGE_CHANGES, KNOWLEDGE_EVERY_DAYS, KNOWLEDGE_SOONER, parseTriageConfig, resolveApiKey, saveTriageConfig, tokenCost, type KnowledgeChanges } from '../../triage/settings.js';
import { renderMarkdown } from '../markdown.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { avatar, badge, csrfField, empty, formatDate, icon, initials, linkBtn, notice, pageHeader, pill, plural, postBtn, selectWrap, setting, submitBtn, switchInput, tag, timeAgo } from '../ui.js';
import { areaHref, canOpen, canOpenIssue, knowledgeHref, pageLink, toolHeader, toolHref } from './tool.js';
import { viewOnlyFooter } from './triage.js';

const n = (x: number) => x.toLocaleString('en-US');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "about 600 tokens", rounded so it doesn't flicker with every word. */
function tokens(chars: number): string {
  const t = Math.ceil(chars / 4);
  return `about ${n(t >= 1000 ? Math.round(t / 100) * 100 : t >= 100 ? Math.round(t / 10) * 10 : t)} tokens`;
}

/** "under $0.01 per app with claude-haiku-5-5 (about $0.04 for 14)"; empty when the model has no known price. */
function costLine(model: string, count = 1): string {
  const each = tokenCost(model, WRITE_ESTIMATE.input, WRITE_ESTIMATE.output);
  if (each === null) return '';
  return `${formatCost(each)} per app with ${model}${count > 1 ? ` (${formatCost(each * count)} for ${count})` : ''}`;
}

const ago = (d: Date) => html`<time datetime="${d.toISOString()}" title="${formatDate(d)}">${timeAgo(d)}</time>`;

const DAY_MS = 86_400_000;

/** Keep them up to date: the choices, as the selects show them. */
const EVERY: Record<number, string> = { 1: 'Every day', 3: 'Every 3 days', 7: 'Every week', 14: 'Every 2 weeks', 30: 'Every month' };
const SOONER: Record<number, string> = { 1: 'After 1 new question', 3: 'After 3 new questions', 5: 'After 5 new questions', 10: 'After 10 new questions', 0: 'Never' };

const CHANGES: Record<KnowledgeChanges, string> = { hourly: 'Every hour', daily: 'Once a day', off: 'Off' };
/** Why a change isn't sent to Claude (see noiseOf). */
const NOISE: Record<string, string> = { Bot: 'Made by a bot, so it isn’t sent to Claude', Chore: 'Dependencies, CI, tests or refactoring, so it isn’t sent to Claude' };

/** "every week, and sooner after 3 new questions" */
function scheduleText(every: number, sooner: number): string {
  return `${EVERY[every]!.toLowerCase()}${sooner ? `, and sooner after ${plural(sooner, 'new question')}` : ''}`;
}

/** " What's merged is added at most once an hour." (empty when it's off). */
function changesText(changes: KnowledgeChanges): string {
  return changes === 'hourly' ? ' What’s merged into the repositories is added at most once an hour.' : changes === 'daily' ? ' What’s merged into the repositories is added at most once a day.' : '';
}

/** When the merged changes waiting go into an app's TRIAGE.md: an hour (or a day) after its last update. */
function changesDue(lastAt: Date | null, changes: KnowledgeChanges, now = Date.now()): string {
  const ms = (lastAt?.getTime() ?? 0) + (changes === 'daily' ? DAY_MS : 3_600_000) - now;
  if (ms <= 10 * 60_000) return 'added in the next few minutes';
  const min = Math.round(ms / 60_000);
  return min < 60 ? `added in about ${min} min` : `added in about ${plural(Math.round(ms / 3_600_000), 'hour')}`;
}

/** "next update in 5 days", for an app whose TRIAGE.md is kept up to date. */
function nextUpdate(writtenAt: Date, every: number, now = Date.now()): string {
  const ms = writtenAt.getTime() + every * DAY_MS - now;
  if (ms <= 0) return 'next update soon';
  const days = Math.round(ms / DAY_MS);
  return days <= 0 ? 'next update today' : days === 1 ? 'next update tomorrow' : `next update in ${days} days`;
}

type State = 'none' | 'queued' | 'running' | 'done' | 'failed';

function stateOf(k: AppKnowledge | null | undefined): State {
  if (k?.auto_status === 'queued' || k?.auto_status === 'running' || k?.auto_status === 'failed') return k.auto_status;
  return isWritten(k) ? 'done' : 'none';
}

const busy = (s: State) => s === 'queued' || s === 'running';

/** Merged changes were added since the last full write. */
const updatedSince = (k: AppKnowledge | null | undefined) => Boolean(k?.auto_at && k.auto_full_at && k.auto_at.getTime() > k.auto_full_at.getTime());

/** "TRIAGE.md · Written by Claude 2 days ago", with the state of the latest write. */
function fileLine(k: AppKnowledge | null | undefined): SafeHtml {
  const s = stateOf(k);
  const lead = s === 'running' ? icon('loader-circle', 14, 'kn-spin') : s === 'queued' ? icon('clock', 14) : s === 'failed' ? icon('triangle-alert', 14, 'warn') : icon('file-text', 14);
  const text: Record<State, SafeHtml | string> = {
    running: 'Claude is writing it…',
    queued: 'Waiting to be written…',
    failed: isWritten(k) ? 'Couldn’t update it' : 'Couldn’t write it',
    done: k?.auto_at ? (updatedSince(k) ? html`Updated by Claude ${ago(k.auto_at)}` : html`Written by Claude ${ago(k.auto_at)}`) : '',
    none: 'Not written yet',
  };
  return html`<span class="kn-file is-${s}">${lead}<span class="mono">TRIAGE.md</span><span class="muted">·</span><span class="kn-file-state">${text[s]}</span></span>`;
}

/** Issues in each repository's copy (what Claude reads from). */
async function issuesPerRepo(q: Queryable, repoIds: number[]): Promise<Map<number, { total: number; open: number }>> {
  const { rows } = await q.query<{ repo_id: number; total: number; open: number }>(
    `SELECT repo_id, count(*) AS total, COALESCE(sum(state = 'open'), 0) AS open FROM issue_index WHERE gone = 0 AND repo_id IN (SELECT value FROM json_each($1)) GROUP BY repo_id`,
    [JSON.stringify([...new Set(repoIds)])],
  );
  return new Map(rows.map((r) => [Number(r.repo_id), { total: Number(r.total), open: Number(r.open) }]));
}

// ---- The Live studio ---------------------------------------------------------------------------

const STEP_LABELS: Record<LiveStep, [done: string, now: string]> = {
  repo: ['Read repo', 'Reading repo'],
  issues: ['Issues', 'Reading issues'],
  thinking: ['Thought', 'Thinking'],
  writing: ['Wrote', 'Writing'],
  answers: ['Answers', 'Answering'],
  changes: ['Changes', 'Reading changes'],
};
const PHASES: Record<LiveStep, string> = { repo: 'Reading the repository', issues: 'Reading the issues', thinking: 'Thinking', writing: 'Writing', answers: 'Answering its questions', changes: 'Reading the changes' };
const TAGS: Record<LiveTag, string> = { github: 'GitHub', issues: 'Issues', tickets: 'Tickets', claude: 'Claude', answer: 'Answer', change: 'Change', done: 'Done', error: 'Error', stop: 'Stopped' };

/** "0:35", "4:12", "1:02:03". */
function clock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "1.2s", "21s", "1m 4s". */
function took(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const timeLeft = (ms: number) => (ms < 60_000 ? 'less than a minute left' : `about ${Math.round(ms / 60_000)} min left`);

type RunAppState = 'running' | 'queued' | 'done' | 'failed' | 'stopped';

interface RunAppRow {
  app_id: string;
  name: string;
  position: number;
  repo_owner: string;
  repo_name: string;
  auto_status: string | null;
  auto_requested_at: Date | null;
  auto_started_at: Date | null;
  auto_finished_at: Date | null;
  auto_model: string | null;
  auto_input_tokens: number | null;
  auto_output_tokens: number | null;
  auto_body: string;
  auto_error: string | null;
  auto_live: LiveState | null;
}

function runAppState(r: RunAppRow): RunAppState {
  if (r.auto_status === 'running') return 'running';
  if (r.auto_status === 'queued') return 'queued';
  return r.auto_live?.result ?? (r.auto_status === 'failed' ? 'failed' : 'done');
}

/** One app's steps for the studio, with how long each took (the one under way: so far). */
function liveSteps(live: LiveState, state: RunAppState, elapsed: number) {
  // An update with merged changes has steps of its own.
  const keys: readonly LiveStep[] = live.steps.some((x) => x.key === 'changes') ? CHANGE_STEPS : LIVE_STEPS.filter((key) => key !== 'answers' || live.answers.length);
  return keys.map((key) => {
    const step = live.steps.find((x) => x.key === key);
    const now = Boolean(step && step.to === undefined && state === 'running');
    return { label: STEP_LABELS[key][now ? 1 : 0], state: !step ? 'todo' : now ? 'active' : 'done', time: step ? took((step.to ?? elapsed) - step.from) : '' };
  });
}

export function registerTriageKnowledgeRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const listUrl = (ctx: WorkspaceRequestContext) => areaHref(ctx, 'triage.knowledge');
  const needsKey = (ctx: WorkspaceRequestContext) => html`Needs a Claude API key. ${can(ctx.membership, 'manage') ? html`<a href="${ctx.base}/settings#claude">Add one in Settings</a>.` : 'An admin can add one in Settings.'}`;

  // ---- Every app --------------------------------------------------------------------------------

  app.get('/w/:wid/triage/knowledge', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const [apps, knowledge, settings, key] = await Promise.all([listApps(deps.db, wid), listKnowledge(deps.db, wid), getTriageSettings(deps.db, wid), resolveApiKey(deps, wid)]);
    const [counts, issues, changed] = await Promise.all([questionCounts(deps.db, wid, knowledge), issuesPerRepo(deps.db, apps.map((a) => a.repo_id)), changeCounts(deps.db, wid)]);
    const c = settings.config;
    const anyOn = settings.enabled || settings.githubEnabled;
    // What's merged is checked (and sent with tickets) while triage and Keep them up to date are on.
    const tracking = anyOn && c.knowledgeAuto && c.knowledgeChanges !== 'off';
    const merged = tracking ? await recentChanges(deps.db, apps.map((a) => a.id)) : new Map<string, AppChange[]>();
    const edit = can(ctx.membership, 'triage.knowledge.edit');
    const states = new Map(apps.map((a) => [a.id, stateOf(knowledge.get(a.id))]));
    const working = apps.filter((a) => busy(states.get(a.id)!)).length;
    const written = apps.filter((a) => isWritten(knowledge.get(a.id))).length;
    const missing = apps.filter((a) => !isWritten(knowledge.get(a.id)) && !busy(states.get(a.id)!)).length;
    const fresh = [...counts.values()].reduce((s, x) => s + x.fresh, 0);
    const sizes = apps.map((a) => knowledgePromptFor(apps, knowledge, [a.id], merged).length).filter(Boolean);
    const perTicket = sizes.length ? Math.round(sizes.reduce((s, x) => s + x, 0) / sizes.length) : 0;
    const actions = canOpen(ctx.membership, 'triage.actions') ? areaHref(ctx, 'triage.actions') : null;

    const appCard = (a: AppRow) => {
      const k = knowledge.get(a.id);
      const s = states.get(a.id)!;
      const q = counts.get(a.id);
      const notes = notesOf(k);
      const repoIssues = issues.get(a.repo_id)?.total ?? 0;
      const sections = isWritten(k) ? sectionsOf(k.auto_body) : [];
      return html`<li><a class="kn-card${isWritten(k) || notes ? '' : ' blank'}" href="${knowledgeHref(ctx, a.id)}">
        <span class="kn-card-h">${avatar(a.name, 32, { square: true, letters: 2 })}<span class="kn-card-name"><span class="cell-title">${a.name}</span><span class="sub mono">${a.repo_owner}/${a.repo_name}</span></span>
          ${q?.fresh ? html`<span class="kn-new" title="Questions Claude asked and hasn’t answered, since your team last saved its notes">${icon('lightbulb', 12)}${plural(q.fresh, 'question')}</span>` : ''}</span>
        ${fileLine(k)}
        ${tracking ? (() => {
          const ch = changed.get(a.id);
          return html`<span class="kn-changes${ch?.today ? ' has' : ''}">${icon('git-merge', 14)}<span>${ch?.today ? `${plural(ch.today, 'change')} merged today${ch.added ? ` · ${n(ch.added)} added to TRIAGE.md` : ''}` : 'Nothing merged today'}${ch?.pending ? ` · ${n(ch.pending)} waiting` : ''}</span></span>`;
        })() : ''}
        <span class="kn-card-text">${sections.length
          ? html`<span class="tags">${sections.map((x) => tag(x))}</span>`
          : s === 'failed' && k?.auto_error
            ? html`<span class="warn-text">${k.auto_error}</span>`
            : `Claude reads its README, changelog and releases${repoIssues ? `, and its ${n(repoIssues)} issues,` : ''} to write it.`}</span>
        <span class="kn-card-f"><span class="kn-card-meta">${isWritten(k)
            ? `${plural(k.auto_sources?.issues.total ?? 0, 'issue')} read · ${tokens(knowledgePromptFor(apps, knowledge, [a.id], merged).length)}`
            : q?.total ? `${plural(q.total, 'question')} from Claude` : 'No questions yet'}${notes ? html` ${tag('Team notes', { cls: 'subtle' })}` : ''}</span>
          <span class="kn-open">Open${icon('arrow-right', 14)}</span></span>
      </a></li>`;
    };
    const grid = html`<ul class="kn-grid">${apps.map(appCard)}</ul>`;
    if ((req.query as { partial?: string }).partial === '1') {
      // Done: reload once, for the numbers and the buttons.
      return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(`${grid.toString()}${working ? '' : '<span data-live-reload hidden></span>'}`);
    }

    const updateAll = (variant?: 'ghost') => postBtn(`${listUrl(ctx)}/write`, 'Update all', ctx.csrf, {
      variant, icon: 'refresh-cw', fields: { scope: 'all' }, loading: 'Starting…',
      confirm: { title: `Update all ${apps.length} TRIAGE.md files?`, body: `Claude reads each app’s repository and issues again and rewrites its TRIAGE.md, in the background. Your team’s notes stay as they are.${costLine(c.model, apps.length) ? ` Cost: ${costLine(c.model, apps.length)}.` : ''}`, label: 'Update all' },
    });
    const watch = html`<button type="button" class="btn js-only" data-kn-open>${icon('eye', 14)}Watch</button>`;
    const write = !edit
      ? working ? html`<div class="row"><span class="kn-busy">${icon('loader-circle', 16, 'kn-spin')}Writing ${plural(working, 'TRIAGE.md', 'TRIAGE.md files')}…</span>${watch}</div>` : ''
      : working
        ? html`<div class="row"><span class="kn-busy">${icon('loader-circle', 16, 'kn-spin')}Writing ${plural(working, 'TRIAGE.md', 'TRIAGE.md files')}…</span>${watch}</div>`
        : !key
          ? html`<span class="small muted">${needsKey(ctx)}</span>`
          : html`<div class="row">
              ${written && missing ? updateAll('ghost') : ''}
              ${missing
                ? postBtn(`${listUrl(ctx)}/write`, missing === apps.length ? `Write all ${apps.length} with Claude` : `Write the other ${missing}`, ctx.csrf, {
                    variant: 'primary', icon: 'sparkles', fields: { scope: 'missing' }, loading: 'Starting…',
                    confirm: {
                      title: missing === apps.length ? 'Write every app’s TRIAGE.md with Claude?' : `Write the other ${plural(missing, 'TRIAGE.md', 'TRIAGE.md files')}?`,
                      body: `Claude reads each app’s README, changelog, docs and releases, and its issues, open and closed, then writes its TRIAGE.md. It runs in the background, about a minute per app; you can leave this page.${costLine(c.model, missing) ? ` Cost: ${costLine(c.model, missing)}.` : ''}`,
                      label: 'Write them',
                    },
                  })
                : updateAll()}
            </div>`;

    // The switch's form also takes the schedule selects (form="kn-auto"): any change saves all three.
    const autoControl = edit
      ? html`<form method="post" action="${listUrl(ctx)}/auto" id="kn-auto" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'auto', checked: c.knowledgeAuto, label: 'Keep every TRIAGE.md up to date', disabled: !key && !c.knowledgeAuto })}<button type="submit" class="btn sm nojs">Save</button></form>`
      : pill(c.knowledgeAuto ? 'On' : 'Off', c.knowledgeAuto ? 'ok' : 'neutral');
    const every = c.knowledgeEveryDays;
    const sooner = c.knowledgeSooner;
    const schedule = edit
      ? html`<span class="kn-cadence">
          <label><span>How often</span>${selectWrap(html`<select name="every" form="kn-auto" aria-label="How often Claude rewrites each TRIAGE.md">${KNOWLEDGE_EVERY_DAYS.map((d) => html`<option value="${String(d)}" ${d === every ? raw('selected') : ''}>${EVERY[d]}</option>`)}</select>`, { sm: true })}</label>
          <label title="Sooner when Claude has asked this many new questions about the app since it last wrote its TRIAGE.md (at most once a day)"><span>Sooner</span>${selectWrap(html`<select name="sooner" form="kn-auto" aria-label="When Claude rewrites an app’s TRIAGE.md sooner">${KNOWLEDGE_SOONER.map((q) => html`<option value="${String(q)}" ${q === sooner ? raw('selected') : ''}>${SOONER[q]}</option>`)}</select>`, { sm: true })}</label>
          <label title="What’s merged into each app’s repository (pull requests, commits pushed without one, releases) is checked every 15 minutes, and tickets get it right away. Claude adds it to the TRIAGE.md at most this often, without rewriting the rest. Bots and chores are left out."><span>After merged PRs</span>${selectWrap(html`<select name="changes" form="kn-auto" aria-label="When Claude adds what’s merged into the repositories">${KNOWLEDGE_CHANGES.map((x) => html`<option value="${x}" ${x === c.knowledgeChanges ? raw('selected') : ''}>${CHANGES[x]}</option>`)}</select>`, { sm: true })}</label>
        </span>`
      : html`<span class="kn-cadence">${EVERY[every]}${sooner ? `, and sooner after ${plural(sooner, 'new question')}` : ''}.${changesText(c.knowledgeChanges)}</span>`;
    // What it costs: per update, and a month on this schedule (app.js updates the month when the schedule changes).
    const perUpdate = tokenCost(c.model, WRITE_ESTIMATE.input, WRITE_ESTIMATE.output);
    const perChange = tokenCost(c.model, CHANGES_ESTIMATE.input, CHANGES_ESTIMATE.output);
    const costs = perUpdate !== null && apps.length
      ? html`<span class="kn-cadence-cost">Each update: ${formatCost(perUpdate)} per app with ${c.model}. On this schedule, <span data-kn-month data-each="${String(perUpdate)}" data-apps="${String(apps.length)}">${formatCost((perUpdate * apps.length * 30) / every)}</span> a month for ${plural(apps.length, 'app')}<span data-kn-changes-cost ${c.knowledgeChanges === 'off' ? raw('hidden') : ''}>, plus ${formatCost(perChange ?? perUpdate)} for each update with merged changes</span>.</span>`
      : '';

    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.knowledge')}
      <div class="stack">
        ${!anyOn ? notice('info', null, html`AI triage is off, so Claude isn’t reading these with tickets yet. ${actions ? html`Turn it on in ${pageLink(ctx, 'triage.actions', 'Actions')}.` : 'An admin can turn it on.'}`) : ''}
        <div class="card rv-stats">
          <div class="card-h"><div><h2>What Claude knows about your apps</h2><div class="desc">Claude writes a TRIAGE.md for each app from its repository (README, changelog, docs, releases) and its issues, open and closed, then reads it with every ticket for that app. Your team can add notes on top; Claude never changes them. Only your team sees these.</div></div>${write}</div>
          <div class="stats four">
            <div class="stat" title="Apps whose TRIAGE.md Claude has written"><div class="l">${icon('sparkles', 14)}Written by Claude</div><div class="v">${n(written)}<span class="kn-of">of ${n(apps.length)}</span></div><div class="sub">${working ? `writing ${n(working)}…` : !apps.length ? 'no apps yet' : missing ? `${n(missing)} to go` : 'every app'}</div></div>
            <div class="stat" title="Questions Claude asked and hasn’t answered, since your team last saved its notes on each app"><div class="l">${icon('lightbulb', 14)}Questions for your team</div><div class="v${fresh ? ' accent' : ''}">${n(fresh)}</div><div class="sub">${fresh ? 'open an app to answer them' : 'nothing new'}</div></div>
            <div class="stat" title="Each ticket gets its own app’s TRIAGE.md, cached between tickets of that app"><div class="l">${icon('file-text', 14)}Per ticket</div><div class="v">${perTicket ? n(Math.ceil(perTicket / 4)) : '0'}</div><div class="sub">tokens on average, cached</div></div>
            ${(() => {
              const inner = html`<div class="l">${icon('image', 14)}Screenshots</div><div class="v">${c.screenshots ? 'On' : 'Off'}</div><div class="sub">${c.screenshots ? 'Claude sees what members attach' : 'Claude only reads the text'}</div>`;
              return actions ? html`<a class="stat" href="${actions}#limits" title="Set in Actions › Model, scope and limits">${inner}</a>` : html`<div class="stat">${inner}</div>`;
            })()}
          </div>
          <div class="kn-auto">${setting('Keep them up to date', html`While AI triage is on, Claude rewrites each app’s TRIAGE.md from the latest issues and releases, and can add what’s merged in between.${schedule}${costs}`, autoControl, { switchRow: true })}</div>
        </div>
        ${apps.length
          ? working ? html`<div data-live="4000" data-live-src="${listUrl(ctx)}?partial=1">${grid}</div>` : grid
          : html`<div class="card">${empty('boxes', 'No apps yet', 'Each app gets its own TRIAGE.md once it’s added in Apps & repositories.', canOpen(ctx.membership, 'apps') ? linkBtn(areaHref(ctx, 'apps'), 'Open Apps', { trail: 'arrow-right' }) : null)}</div>`}
      </div>`;
    return web.render(reply, ctx, 'Knowledge · AI triage', 'triage', body, { width: 'full' });
  });

  // ---- One app ----------------------------------------------------------------------------------

  app.get('/w/:wid/triage/knowledge/:appId', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const a = await getApp(deps.db, wid, (req.params as { appId: string }).appId);
    if (!a) throw new UserFacingError('That app was removed.', 404);
    const [k, apps, settings, key] = await Promise.all([getKnowledge(deps.db, wid, a.id), listApps(deps.db, wid), getTriageSettings(deps.db, wid), resolveApiKey(deps, wid)]);
    const [{ questions, more }, issues, changeList, sync, changed] = await Promise.all([listQuestions(deps.db, wid, a.id, k), issuesPerRepo(deps.db, [a.repo_id]), appChanges(deps.db, a.id, 15), changeSync(deps.db, a.repo_id), changeCounts(deps.db, wid)]);
    const c = settings.config;
    const edit = can(ctx.membership, 'triage.knowledge.edit');
    const s = stateOf(k);
    const repoUrl = `https://github.com/${a.repo_owner}/${a.repo_name}`;
    const repoIssues = issues.get(a.repo_id) ?? { total: 0, open: 0 };
    const writeUrl = `${knowledgeHref(ctx, a.id)}/write`;
    const each = tokenCost(c.model, WRITE_ESTIMATE.input, WRITE_ESTIMATE.output);
    const price = each === null ? '' : `${cap(formatCost(each))} with ${c.model}`;

    // ---- What Claude wrote (the part that refreshes while Claude writes).
    const writeBtn = (label: string, primary: boolean) => (edit && key
      ? postBtn(writeUrl, label, ctx.csrf, { variant: primary ? 'primary' : undefined, size: primary ? undefined : 'sm', icon: primary ? 'sparkles' : 'refresh-cw', loading: 'Starting…', title: price || undefined })
      : '');
    const used = k?.auto_model ? tokenCost(k.auto_model, k.auto_input_tokens ?? 0, k.auto_output_tokens ?? 0) : null;
    // With Keep them up to date on: when it's rewritten next.
    const triageOn = settings.enabled || settings.githubEnabled;
    const upcoming = !c.knowledgeAuto || !k?.auto_at ? '' : triageOn ? nextUpdate(k.auto_full_at ?? k.auto_at, c.knowledgeEveryDays) : 'updates start when AI triage is on';
    const writtenDoc = isWritten(k)
      ? html`${k.auto_sources?.cutOff ? html`<div class="card-b tight">${notice('warn', null, 'Claude ran out of room before the end, so the last part may be missing. Update it to try again.')}</div>` : ''}
          <div class="card-b"><div class="kn-doc">${renderMarkdown(k.auto_body, repoUrl)}</div></div>
          <details class="kn-raw"><summary>${icon('chevron-right', 14, 'chev')}Markdown<span class="muted"> · exactly what Claude reads</span></summary><pre class="prompt-pre">${k.auto_body}</pre></details>
          <div class="card-note">${[k.auto_model, k.auto_input_tokens ? `${n((k.auto_input_tokens ?? 0) + (k.auto_output_tokens ?? 0))} tokens` : '', used !== null && k.auto_input_tokens ? formatCost(used) : ''].filter(Boolean).join(' · ')}${k.auto_full_at ?? k.auto_at ? html` · written ${ago((k.auto_full_at ?? k.auto_at)!)}` : ''}${updatedSince(k) ? html` · updated with merged changes ${ago(k.auto_at!)}` : ''}${upcoming ? ` · ${upcoming}` : ''}</div>`
      : '';
    const writtenInner = html`
      ${busy(s)
        ? html`<div class="kn-progress">${icon('loader-circle', 20, 'kn-spin')}<div><strong>${s === 'running' ? `Claude is reading ${a.name}’s repository and ${repoIssues.total ? `${n(repoIssues.total)} issues` : 'issues'}…` : 'Waiting its turn…'}</strong><p class="small muted">It takes about a minute, in the background: you can leave this page.${isWritten(k) ? ' Until then, tickets use the version below.' : ''}</p></div><button type="button" class="btn sm js-only" data-kn-open="${a.id}">${icon('eye', 14)}Watch</button></div>`
        : ''}
      ${s === 'failed' ? html`<div class="card-b tight">${notice('warn', isWritten(k) ? 'Couldn’t update it' : 'Couldn’t write it', `${k?.auto_error ?? 'Something went wrong.'}${isWritten(k) ? ' Tickets still use the version below.' : ''}`, { action: writeBtn('Try again', false) || null })}</div>` : ''}
      ${isWritten(k)
        ? writtenDoc
        : busy(s) || s === 'failed'
          ? ''
          : html`<div class="kn-empty">
              <span class="kn-empty-ic">${icon('sparkles', 20)}</span>
              <h3>Claude hasn’t written it yet</h3>
              <p>It reads ${a.name}’s README, changelog, docs and releases, and its ${repoIssues.total ? `${n(repoIssues.total)} issues (${n(repoIssues.open)} open)` : 'issues'}, then writes what it needs to triage tickets:</p>
              <ul class="kn-sections">${KNOWLEDGE_SECTIONS.map((x) => html`<li><strong>${x.title}</strong><span>${x.text}</span></li>`)}</ul>
              ${edit
                ? key
                  ? html`<div class="row">${writeBtn('Write it with Claude', true)}${price ? html`<span class="small muted">${price}</span>` : ''}</div>`
                  : html`<p class="small muted">${needsKey(ctx)}</p>`
                : html`<p class="small muted">Someone with Edit on Knowledge can ask Claude to write it.</p>`}
            </div>`}
      ${busy(s) ? '' : raw('<span data-live-reload hidden></span>')}`;
    if ((req.query as { partial?: string }).partial === '1') {
      return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(writtenInner.toString());
    }

    // ---- Claude's questions.
    const issuePages = canOpenIssue(ctx.membership);
    const sourceLink = (x: Question['sources'][number]) => {
      const label = x.number ? `${x.repoName}#${String(x.number)}` : 'ticket';
      const title = `${x.kind === 'ticket' ? 'Discord ticket' : 'Opened on GitHub'}${x.title ? `: ${x.title}` : ''}`;
      if (x.kind === 'ticket') return html`<a href="${ctx.base}/tickets/${x.submissionId!}" title="${title}">${label}</a>`;
      return issuePages
        ? html`<a href="${ctx.base}/issues/${String(x.repoId)}/${String(x.number)}" title="${title}">${label}</a>`
        : html`<a href="https://github.com/${a.repo_owner}/${x.repoName}/issues/${String(x.number)}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`;
    };
    const question = (q: Question) => html`<li class="kn-q${q.fresh ? ' fresh' : ''}">
      <p class="kn-q-text">${q.text}</p>
      ${q.answer ? html`<div class="kn-q-answer">${icon('check', 12)}<div>${renderMarkdown(q.answer, repoUrl)}</div></div>` : ''}
      <div class="kn-q-meta">
        ${q.fresh ? html`<span class="kn-q-new">New</span>` : ''}
        <span>${q.sources.length > 1 ? `Asked ${String(q.sources.length)} times · ` : ''}${ago(q.at)}</span>
        <span class="kn-q-src">${q.sources.slice(0, 3).map((x, j) => html`${j ? ', ' : ''}${sourceLink(x)}`)}${q.sources.length > 3 ? html` <span class="muted">+${String(q.sources.length - 3)}</span>` : ''}</span>
        ${edit && !q.answer ? html`<button type="button" class="link-btn kn-q-add js-only" data-kn-add="${q.text}" title="Add this question to your team’s notes, ready for the answer">${icon('corner-down-left', 12)}Answer</button>` : ''}
      </div>
    </li>`;
    const team = questions.filter((q) => q.status === 'team');
    const waiting = questions.filter((q) => q.status === 'waiting');
    const answered = questions.filter((q) => q.status === 'answered');
    const fresh = questions.filter((q) => q.fresh).length;
    const group = (title: string, desc: string, list: Question[]) => html`<div class="kn-qg"><div class="kn-qg-h"><span class="t">${title}<span class="muted"> · ${String(list.length)}</span></span><span class="d">${desc}</span></div><ul class="kn-qs">${list.map(question)}</ul></div>`;
    const questionsCard = html`<section class="card" id="questions" aria-labelledby="kn-q-h">
      <div class="card-h"><div><div class="title"><h2 id="kn-q-h">Questions from Claude</h2>${fresh ? badge(fresh, 'accent') : ''}</div><div class="desc">Asked while triaging ${a.name} tickets, when a fact about the app would have made Claude surer.</div></div></div>
      ${team.length ? group('Needs your team', 'Not in the repository or the issues. Answer in your notes and later tickets use it.', team) : ''}
      ${waiting.length ? group('Claude will look', isWritten(k) ? 'Asked since it last wrote the TRIAGE.md: it looks for the answers next time.' : 'It looks for the answers when it writes the TRIAGE.md.', waiting) : ''}
      ${answered.length ? html`<details class="kn-qg kn-answered"><summary>${icon('chevron-right', 14, 'chev')}Answered by Claude<span class="muted"> · ${String(answered.length)}</span></summary><ul class="kn-qs">${answered.map(question)}</ul></details>` : ''}
      ${questions.length
        ? more ? html`<div class="card-note">${plural(more, 'older question')} not shown.</div>` : ''
        : html`<div class="card-b tight"><p class="small muted">No questions yet. When Claude isn’t sure about something it can’t find in a ticket, its question shows up here with the tickets it came from.</p></div>`}
    </section>`;

    // ---- What Claude read.
    const src = k?.auto_sources;
    const fileLink = (path: string) => html`<a class="mono" href="${repoUrl}/blob/HEAD/${path}" target="_blank" rel="noopener noreferrer">${path}</a>`;
    const sourcesCard = src && isWritten(k)
      ? html`<section class="card" aria-labelledby="kn-src-h">
          <div class="card-h"><div><h2 id="kn-src-h">What Claude read</h2><div class="desc">The last time it wrote this TRIAGE.md.</div></div></div>
          <dl class="props kn-props">
            <dt>README</dt><dd>${src.readme ? fileLink(src.readme) : html`<span class="muted">${src.filesBlocked ? 'Not allowed' : 'None found'}</span>`}</dd>
            <dt>Docs</dt><dd>${src.files.length ? html`<span class="kn-paths">${src.files.map(fileLink)}</span>` : html`<span class="muted">None found</span>`}</dd>
            <dt>Releases</dt><dd>${src.releases ? `${n(src.releases)}${src.latestRelease ? ` · latest ${src.latestRelease}` : ''}` : html`<span class="muted">None</span>`}</dd>
            <dt>Issues</dt><dd><span>${n(src.issues.total)}<span class="muted"> · ${n(src.issues.open)} open, ${n(src.issues.fixed)} fixed, ${n(src.issues.notPlanned)} not planned</span></span></dd>
            <dt>Tickets</dt><dd>${src.tickets ? `${n(src.tickets)} recent` : html`<span class="muted">None yet</span>`}</dd>
            <dt>Questions</dt><dd>${src.questions ? n(src.questions) : html`<span class="muted">None</span>`}</dd>
          </dl>
          ${src.filesBlocked ? html`<div class="card-note">GitHub didn’t let Claude read the repository’s files. To include the README and changelog, give the GitHub app <strong>Contents: Read-only</strong>.</div>` : ''}
        </section>`
      : '';

    // ---- What was merged.
    const tracking = c.knowledgeAuto && c.knowledgeChanges !== 'off';
    const waitingN = changed.get(a.id)?.pending ?? 0;
    const due = tracking && triageOn ? changesDue(k?.auto_at ?? null, c.knowledgeChanges) : null;
    const kindIcon = (x: AppChange) => icon(x.kind === 'pr' ? 'git-merge' : x.kind === 'commit' ? 'git-commit-horizontal' : 'tag', 14);
    const changeChip = (x: AppChange) => x.status === 'added'
      ? tag('Added to TRIAGE.md', { cls: 'kn-ch-chip added' })
      : x.status === 'pending' ? tag('Waiting', { cls: 'kn-ch-chip waiting', title: due && isWritten(k) ? cap(due) : 'Added at the next update' })
        : x.noise ? tag(x.noise, { cls: 'kn-ch-chip skipped', title: NOISE[x.noise] ?? 'Not sent to Claude' })
          : x.note === NOT_USED ? tag('Not used', { cls: 'kn-ch-chip skipped', title: 'Claude didn’t add it to the TRIAGE.md' })
            : tag('Not relevant', { cls: 'kn-ch-chip skipped', title: 'Claude didn’t add it to the TRIAGE.md' });
    const issueLink = (num: number) => html`<a href="https://github.com/${a.repo_owner}/${a.repo_name}/issues/${String(num)}" target="_blank" rel="noopener noreferrer">#${String(num)}</a>`;
    const changesCard = tracking || changeList.length
      ? html`<section class="card" id="changes" aria-labelledby="kn-ch-h">
          <div class="card-h"><div><div class="title"><h2 id="kn-ch-h">Changes</h2>${waitingN ? badge(waitingN, 'accent') : ''}</div><div class="desc">${tracking
            ? html`Merged into ${a.repo_owner}/${a.repo_name}${sync?.default_branch ? html` (<span class="mono">${sync.default_branch}</span>)` : ''}: pull requests, commits pushed without one, and releases. ${!triageOn ? 'Checked once AI triage is on.' : sync?.checked_at ? html`Checked ${ago(sync.checked_at)}.` : 'Checked every 15 minutes.'}`
            : html`To follow what’s merged into ${a.repo_owner}/${a.repo_name}, turn on <a href="${listUrl(ctx)}">Keep them up to date</a> and choose when in “After merged PRs”.`}</div></div></div>
          ${sync?.last_error && tracking && triageOn ? html`<div class="card-b tight">${notice('warn', null, sync.last_error)}</div>` : ''}
          ${changeList.length
            ? html`<ul class="kn-chs">${changeList.map((x) => html`<li class="kn-ch is-${x.status}">${kindIcon(x)}<div class="kn-ch-b">
                <a class="kn-ch-t" href="${x.url}" target="_blank" rel="noopener noreferrer">${x.title}</a>
                <div class="kn-ch-m"><span class="mono">${changeLabel(x)}</span>${x.author ? ` · ${x.author}` : ''} · ${ago(x.merged_at)}${x.closes.length ? html` · closes ${x.closes.map((num, j) => html`${j ? ', ' : ''}${issueLink(num)}`)}` : ''}</div>
                ${x.status === 'skipped' && x.note && !x.noise && x.note !== NOT_USED ? html`<div class="kn-ch-note">${x.note}</div>` : ''}
              </div>${changeChip(x)}</li>`)}</ul>`
            : html`<div class="card-b tight"><p class="small muted">${tracking ? 'Nothing merged in the last 14 days.' : 'Nothing tracked yet.'}</p></div>`}
          ${edit && waitingN && key && !busy(s) && isWritten(k)
            ? html`<div class="card-f"><span class="small muted">${plural(waitingN, 'change')} waiting${due ? ` · ${due}` : ''}</span>${postBtn(writeUrl, waitingN === 1 ? 'Add it now' : 'Add them now', ctx.csrf, { size: 'sm', icon: 'git-merge', loading: 'Starting…', fields: { mode: 'changes' } })}</div>`
            : ''}
        </section>`
      : '';

    // ---- The team's notes.
    const notes = k?.body ?? '';
    const notesCard = html`<form method="post" action="${knowledgeHref(ctx, a.id)}" class="card kn-editor" id="notes" ${edit ? raw('data-dirty data-kn-editor') : ''}>
      ${csrfField(ctx.csrf)}
      <div class="card-h"><div><div class="title"><h2>Notes from your team</h2>${tag('Optional', { cls: 'subtle' })}</div><div class="desc">What the repository and the issues don’t say: decisions, workarounds, where to send things. Claude reads them with its own and follows yours when they disagree; its updates never change them.${k?.notes_at && !isBlank(notes) ? html` Saved ${ago(k.notes_at)}${k.updated_by_name ? ` by ${k.updated_by_name}` : ''}.` : ''}</div></div>
        <span class="kn-meter" data-kn-meter-for="kn-body" data-max="${String(KNOWLEDGE_MAX)}">${n(notes.length)} / ${n(KNOWLEDGE_MAX)} · ${tokens(notes.length)}</span></div>
      <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
        <label class="sr-only" for="kn-body">Notes from your team on ${a.name}</label>
        <textarea id="kn-body" name="body" class="kn-text" rows="8" maxlength="${String(KNOWLEDGE_MAX)}" spellcheck="true" placeholder="${'- Refunds and licences are handled by the store, not on GitHub.\n- The beta web editor shares the desktop canvas engine.'}">${notes}</textarea>
      </fieldset>
      <div class="card-f">${edit
        ? html`<span class="small muted">Used from the next ticket.<span class="kn-keys js-only"> <kbd>⌘</kbd><kbd>S</kbd> saves.</span></span><div class="end">
            <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
            ${submitBtn('Save notes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
          </div>`
        : viewOnlyFooter('these notes')}</div>
    </form>`;

    const i = apps.findIndex((x) => x.id === a.id);
    const prev = apps[i - 1];
    const next = apps[i + 1];
    const statePill = busy(s) ? pill('Writing…', 'warn') : s === 'failed' ? pill(isWritten(k) ? 'Couldn’t update' : 'Couldn’t write', 'danger') : s === 'done' ? pill(c.knowledgeAuto ? 'Kept up to date' : 'Written', 'ok') : '';
    const pageBody = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'triage') ?? undefined, label: 'AI triage' }, { href: listUrl(ctx), label: 'Knowledge' }, { label: a.name }],
        title: html`<span class="kn-title">${avatar(a.name, 28, { square: true, letters: 2 })}${a.name}</span>`,
        after: [tag('TRIAGE.md', { icon: 'file-text', cls: 'mono' })],
        description: isWritten(k) && k.auto_at
          ? html`Written by Claude ${ago(k.auto_full_at ?? k.auto_at)}${updatedSince(k) ? html`, updated with merged changes ${ago(k.auto_at)},` : ''} from ${a.repo_owner}/${a.repo_name}. Claude reads it with every ${a.name} ticket${c.knowledgeAuto ? ` and rewrites it ${scheduleText(c.knowledgeEveryDays, c.knowledgeSooner)}` : ''}.${c.knowledgeAuto ? changesText(c.knowledgeChanges) : ''}`
          : `Claude writes it from ${a.repo_owner}/${a.repo_name}, then reads it with every ${a.name} ticket.`,
        actions: [
          prev ? linkBtn(knowledgeHref(ctx, prev.id), prev.name, { icon: 'chevron-left', variant: 'ghost', size: 'sm' }) : null,
          next ? linkBtn(knowledgeHref(ctx, next.id), next.name, { trail: 'chevron-right', variant: 'ghost', size: 'sm' }) : null,
        ],
      })}
      <div class="panel-grid kn-layout">
        <div class="stack">
          <section class="card kn-written" id="written" aria-labelledby="kn-w-h">
            <div class="card-h"><div><div class="title">${icon('sparkles', 16)}<h2 id="kn-w-h">Written by Claude</h2>${statePill}</div><div class="desc">From the repository and its issues, open and closed. Corrections go in your notes below: Claude rewrites this part each time.</div></div>${isWritten(k) && !busy(s) && s !== 'failed' ? writeBtn('Update now', false) : ''}</div>
            ${busy(s) ? html`<div data-live="4000" data-live-src="${knowledgeHref(ctx, a.id)}?partial=1">${writtenInner}</div>` : writtenInner}
          </section>
          ${notesCard}
        </div>
        <div class="stack kn-side">${questionsCard}${changesCard}${sourcesCard}</div>
      </div>`;
    return web.render(reply, ctx, `${a.name} · Knowledge · AI triage`, 'triage', pageBody, { width: 'full' });
  });

  // ---- Asking Claude to write --------------------------------------------------------------------

  app.post('/w/:wid/triage/knowledge/write', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    if (!(await resolveApiKey(deps, wid))) {
      setFlash(reply, 'error', 'Add a Claude API key in Settings first.');
      return reply.redirect(listUrl(ctx));
    }
    const all = (req.body as { scope?: string } | null)?.scope === 'all';
    const [apps, knowledge] = await Promise.all([listApps(deps.db, wid), listKnowledge(deps.db, wid)]);
    const queued = await requestWrites(deps.db, wid, apps.filter((a) => all || !isWritten(knowledge.get(a.id))).map((a) => a.id), ctx.user.id);
    setFlash(reply, queued ? 'success' : 'info', queued
      ? `Claude is ${all ? 'updating' : 'writing'} ${plural(queued, 'TRIAGE.md', 'TRIAGE.md files')}, about a minute each.`
      : 'They’re already being written.');
    return reply.redirect(`${listUrl(ctx)}?watch=1`);
  });

  app.post('/w/:wid/triage/knowledge/auto', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const f = (req.body ?? {}) as { auto?: string; every?: string; sooner?: string; changes?: string };
    const on = f.auto !== undefined;
    const respond = (ok: boolean, message: string) => {
      if (web.wantsJson(req)) return reply.code(ok ? 200 : 400).send(ok ? { ok, message } : { ok, error: message });
      setFlash(reply, ok ? 'success' : 'error', message);
      return reply.redirect(listUrl(ctx));
    };
    const settings = await getTriageSettings(deps.db, wid);
    const c = settings.config;
    // A field missing from the form keeps its value.
    const every = f.every === undefined ? c.knowledgeEveryDays : Number(f.every);
    const sooner = f.sooner === undefined ? c.knowledgeSooner : Number(f.sooner);
    const changes = (f.changes === undefined ? c.knowledgeChanges : f.changes) as KnowledgeChanges;
    if (!(KNOWLEDGE_EVERY_DAYS as readonly number[]).includes(every) || !(KNOWLEDGE_SOONER as readonly number[]).includes(sooner) || !KNOWLEDGE_CHANGES.includes(changes)) return respond(false, 'Choose a schedule from the list.');
    if (on && !(await resolveApiKey(deps, wid))) return respond(false, 'Add a Claude API key in Settings first.');
    await saveTriageConfig(deps.db, wid, parseTriageConfig({ ...c, knowledgeAuto: on, knowledgeEveryDays: every, knowledgeSooner: sooner, knowledgeChanges: changes }));
    const when = `${scheduleText(every, sooner)}.${changesText(changes)}`.replace(/\.$/, '');
    if (!on) return respond(true, c.knowledgeAuto ? 'Claude no longer updates them by itself. You can still update each one.' : `Schedule saved: ${when}. Switch it on to start.`);
    const later = settings.enabled || settings.githubEnabled ? '' : ' Updates start once AI triage is on.';
    if (c.knowledgeAuto) return respond(true, `Claude rewrites each TRIAGE.md ${when}.${later}`);
    // Just switched on: the ones never written start now; the others follow the schedule.
    const [apps, knowledge] = await Promise.all([listApps(deps.db, wid), listKnowledge(deps.db, wid)]);
    const queued = await requestWrites(deps.db, wid, apps.filter((a) => !isWritten(knowledge.get(a.id))).map((a) => a.id), ctx.user.id);
    const message = `${queued ? `Claude is writing the ${plural(queued, 'missing TRIAGE.md', 'missing TRIAGE.md files')} now, then rewrites them ${when}.` : `Claude rewrites each TRIAGE.md ${when}.`}${later}`;
    // Writes started: the page reloads with the Live studio open.
    if (queued && web.wantsJson(req)) return reply.send({ ok: true, message, go: `${listUrl(ctx)}?watch=1` });
    return respond(true, message);
  });

  app.post('/w/:wid/triage/knowledge/:appId/write', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const a = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!a) throw new UserFacingError('That app was removed.', 404);
    if (!(await resolveApiKey(deps, ctx.workspace.id))) setFlash(reply, 'error', 'Add a Claude API key in Settings first.');
    else {
      const changes = (req.body as { mode?: string } | null)?.mode === 'changes';
      const queued = await requestWrites(deps.db, ctx.workspace.id, [a.id], ctx.user.id, changes ? 'changes' : 'full');
      setFlash(reply, queued ? 'success' : 'info', queued ? (changes ? `Claude is adding the merged changes to the TRIAGE.md for ${a.name}.` : `Claude is writing the TRIAGE.md for ${a.name}, in about a minute.`) : 'It’s already being written.');
      return reply.redirect(`${knowledgeHref(ctx, a.id)}?watch=1`);
    }
    return reply.redirect(knowledgeHref(ctx, a.id));
  });

  // ---- Live: what the studio and its pill show, and Stop ----------------------------------------

  app.get('/w/:wid/triage/knowledge/live', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    reply.header('Cache-Control', 'no-store');
    const run = await latestRun(deps.db, wid);
    if (!run) return reply.send({ run: null });
    const [{ rows }, settings] = await Promise.all([
      deps.db.query<RunAppRow>(
        `SELECT k.app_id, a.name, a.position, a.repo_owner, a.repo_name, k.auto_status, k.auto_requested_at, k.auto_started_at, k.auto_finished_at,
                k.auto_model, k.auto_input_tokens, k.auto_output_tokens, k.auto_body, k.auto_error, k.auto_live
           FROM app_knowledge k JOIN apps a ON a.id = k.app_id WHERE k.auto_run_id = $1`,
        [run.id],
      ),
      getTriageSettings(deps.db, wid),
    ]);
    const now = Date.now();
    const edit = can(ctx.membership, 'triage.knowledge.edit');
    const apps = rows.map((r) => ({ r, state: runAppState(r) }));
    // A run with nothing left (an app removed while it waited) ends here.
    if (!run.finished_at && !apps.some((x) => x.state === 'running' || x.state === 'queued')) {
      await finishRunIfDone(deps.db, run.id);
      run.finished_at = new Date(now);
    }
    // Finished first (as they finished), then the one being written, then the waiting ones in turn.
    const rank: Record<RunAppState, number> = { done: 0, failed: 0, stopped: 0, running: 1, queued: 2 };
    const ms = (d: Date | null) => d?.getTime() ?? 0;
    apps.sort((x, y) => rank[x.state] - rank[y.state] || (x.state === 'queued'
      ? ms(x.r.auto_requested_at) - ms(y.r.auto_requested_at) || x.r.position - y.r.position
      : ms(x.r.auto_finished_at) - ms(y.r.auto_finished_at)));
    const running = apps.find((x) => x.state === 'running');
    const waiting = apps.filter((x) => x.state === 'queued');
    const finished = apps.filter((x) => x.state === 'done' || x.state === 'failed' || x.state === 'stopped');
    const done = apps.filter((x) => x.state === 'done');
    const failed = apps.filter((x) => x.state === 'failed').length;
    const skipped = apps.filter((x) => x.state === 'stopped').length;
    const durations = apps.filter((x) => (x.state === 'done' || x.state === 'failed') && x.r.auto_started_at && x.r.auto_finished_at).map((x) => ms(x.r.auto_finished_at) - ms(x.r.auto_started_at));
    const each = durations.length ? durations.reduce((t, d) => t + d, 0) / durations.length : 60_000;
    const runningFor = running?.r.auto_started_at ? now - ms(running.r.auto_started_at) : 0;
    const eta = waiting.length * each + (running ? Math.max(5_000, each - runningFor) : 0);
    const spent = done.reduce((t, x) => t + (tokenCost(x.r.auto_model ?? '', x.r.auto_input_tokens ?? 0, x.r.auto_output_tokens ?? 0) ?? 0), 0);
    const cost = done.length && tokenCost(settings.config.model, 1, 1) !== null ? formatCost(spent) : null;
    const active = !run.finished_at;
    const elapsed = ms(run.finished_at ?? new Date(now)) - ms(run.started_at);
    const scheduled = !run.started_by;
    const total = apps.length;
    const summary = [
      `${done.length} written`,
      failed ? `${failed} couldn’t be written` : '',
      skipped ? `${skipped} stopped` : '',
    ].filter(Boolean).join(' · ');
    const runningLive = running?.r.auto_live ?? emptyLive();
    const runningStep = runningLive.steps.at(-1)?.key;
    const writingFrom = runningLive.steps.find((x) => x.key === 'writing')?.from;
    const speed = running && writingFrom !== undefined && runningLive.text ? Math.round(runningLive.text.length / 4 / Math.max(1, (runningFor - writingFrom) / 1000)) : 0;

    // The app shown in the middle: the one asked for, else the one being written, else the last done.
    const askedFor = String((req.query as { app?: string }).app ?? '');
    const pick = apps.find((x) => x.r.app_id === askedFor) ?? running ?? finished.at(-1) ?? apps[0];
    let selected = null;
    if (pick) {
      const live = pick.r.auto_live ?? emptyLive();
      const repoUrl = `https://github.com/${pick.r.repo_owner}/${pick.r.repo_name}`;
      const pickFor = pick.r.auto_started_at ? (pick.state === 'running' ? now : ms(pick.r.auto_finished_at) || now) - ms(pick.r.auto_started_at) : 0;
      const shown = pick.state === 'running' ? splitAnswers(live.text).body : pick.state === 'queued' ? '' : pick.r.auto_body;
      const step = live.steps.at(-1)?.key;
      const writing = pick.state === 'running' && (step === 'writing' || step === 'answers');
      const tokens = pick.state === 'running' ? (live.text ? `≈ ${plural(Math.round(live.text.length / 4), 'token')}` : '') : live.outputTokens ? `${plural(live.outputTokens, 'token')} written${live.inputTokens ? ` · ${n(live.inputTokens)} read` : ''}` : '';
      selected = {
        id: pick.r.app_id,
        name: pick.r.name,
        initials: initials(pick.r.name, 2),
        state: pick.state,
        steps: pick.state === 'queued' ? [] : liveSteps(live, pick.state, pickFor),
        html: shown.trim() ? renderMarkdown(shown, repoUrl).toString() : '',
        empty: pick.state === 'queued'
          ? 'Waiting its turn: Claude writes the apps one at a time.'
          : pick.state === 'failed' ? `Couldn’t write it: ${live.error ?? pick.r.auto_error ?? 'something went wrong'}.`
            : pick.state === 'stopped' ? (pick.r.auto_body.trim() ? 'Stopped: its previous TRIAGE.md stays (below).' : 'Stopped before Claude wrote anything.')
              : pick.state === 'running' && !shown.trim() ? (step ? `${PHASES[step]}…` : 'Starting…') : '',
        writing,
        tokens,
        speed: pick === running ? speed : 0,
        cutOff: Boolean(live.cutOff),
        log: live.log.map((l) => ({ time: clock(l.at), tag: l.tag, label: TAGS[l.tag], text: l.text })),
        answers: live.answers.map((a) => ({ question: a.question, html: a.answer ? renderMarkdown(a.answer, repoUrl).toString() : '', state: a.done ? (a.answer ? 'found' : 'unknown') : 'pending' })),
        found: `${live.answers.filter((a) => a.answer).length} of ${live.answers.length} found`,
        skip: edit && (pick.state === 'running' || pick.state === 'queued') && active ? { app: pick.r.app_id, label: pick.state === 'running' ? `Skip ${pick.r.name}` : 'Take it out of the queue' } : null,
      };
    }
    return reply.send({
      run: {
        id: run.id,
        active,
        stopped: Boolean(run.stopped_at),
        title: active
          ? `Claude is ${scheduled ? 'updating' : 'writing'} your TRIAGE.md files`
          : run.stopped_at ? `Stopped · ${summary}` : done.length === total ? (total === 1 ? 'TRIAGE.md written' : `All ${total} TRIAGE.md files written`) : summary,
        sub: active
          ? [`${finished.length} of ${total}`, `${clock(elapsed)} elapsed`, timeLeft(eta), cost ? `${cost} so far` : '', settings.config.model].filter(Boolean).join(' · ')
          : [`Took ${clock(elapsed)}`, cost, settings.config.model, scheduled ? 'scheduled update' : run.started_by_name ? `started by ${run.started_by_name}` : ''].filter(Boolean).join(' · '),
        total,
        finished: finished.length,
        percent: active ? Math.min(99, Math.round(((finished.length + (running ? Math.min(0.9, runningFor / each) : 0)) / Math.max(1, total)) * 100)) : 100,
        pill: active
          ? { icon: 'running', title: running ? `Writing ${running.r.name}` : 'Writing TRIAGE.md files', sub: [speed ? `${speed} tok/s` : runningStep ? PHASES[runningStep] : 'Starting', timeLeft(eta)].join(' · ') }
          : { icon: failed ? 'failed' : run.stopped_at ? 'stopped' : 'done', title: run.stopped_at ? `Stopped · ${done.length} written` : done.length === total ? (total === 1 ? 'TRIAGE.md written' : `All ${total} written`) : summary, sub: [cost, 'Open to see them'].filter(Boolean).join(' · ') },
      },
      apps: apps.map((x, i) => ({
        id: x.r.app_id,
        name: x.r.name,
        state: x.state,
        note: x.state === 'running' ? clock(runningFor) : x.state === 'queued' ? (i === apps.indexOf(waiting[0]!) ? 'Up next' : '') : x.state === 'done' ? took(ms(x.r.auto_finished_at) - ms(x.r.auto_started_at)) : x.state === 'failed' ? 'Failed' : 'Stopped',
        asked: x.r.auto_live?.answers.length ?? 0,
        answered: x.r.auto_live?.answers.filter((a) => a.answer).length ?? 0,
        url: knowledgeHref(ctx, x.r.app_id),
      })),
      current: running?.r.app_id ?? null,
      selected,
      edit,
      page: listUrl(ctx),
    });
  });

  app.post('/w/:wid/triage/knowledge/stop', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const respond = (ok: boolean, message: string) => {
      if (web.wantsJson(req)) return reply.code(ok ? 200 : 400).send(ok ? { ok, message } : { ok, error: message });
      setFlash(reply, ok ? 'success' : 'error', message);
      return reply.redirect(listUrl(ctx));
    };
    const appId = String((req.body as { app?: string } | null)?.app ?? '');
    if (appId) {
      const a = await getApp(deps.db, wid, appId);
      if (!a) return respond(false, 'That app was removed.');
      const r = await stopWrites(deps.db, wid, [a.id], ctx.user.id);
      return respond(true, r.cancelled ? `Skipping ${a.name}: it keeps the TRIAGE.md it had.` : r.unqueued ? `${a.name} won’t be written this time.` : `${a.name} isn’t being written.`);
    }
    const r = await stopWrites(deps.db, wid, 'all', ctx.user.id);
    return respond(true, r.unqueued || r.cancelled ? 'Stopped. The ones already written keep their new TRIAGE.md.' : 'Nothing was being written.');
  });

  // ---- The team's notes --------------------------------------------------------------------------

  app.post('/w/:wid/triage/knowledge/:appId', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const a = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!a) throw new UserFacingError('That app was removed.', 404);
    const input = String((req.body as { body?: unknown } | null)?.body ?? '');
    try {
      if (input.replace(/\r\n?/g, '\n').trim().length > KNOWLEDGE_MAX) throw new UserFacingError(`Notes can be up to ${n(KNOWLEDGE_MAX)} characters. Shorten them and save again.`);
      // Headings with nothing under them say nothing: they're saved as empty.
      const body = isBlank(cleanKnowledge(input)) ? '' : input;
      const changed = await saveKnowledge(deps.db, ctx.workspace.id, a.id, body, ctx.user.id);
      setFlash(reply, changed ? 'success' : 'info', changed ? `Notes on ${a.name} saved. Claude uses them from the next ticket.` : 'No changes to save.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${knowledgeHref(ctx, a.id)}#notes`);
  });
}

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
  requestWrites,
  saveKnowledge,
  sectionsOf,
  type AppKnowledge,
  type Question,
} from '../../triage/knowledge.js';
import { WRITE_ESTIMATE } from '../../triage/knowledge-writer.js';
import { formatCost, getTriageSettings, parseTriageConfig, resolveApiKey, saveTriageConfig, tokenCost } from '../../triage/settings.js';
import { renderMarkdown } from '../markdown.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { avatar, badge, csrfField, empty, formatDate, icon, linkBtn, notice, pageHeader, pill, plural, postBtn, setting, submitBtn, switchInput, tag, timeAgo } from '../ui.js';
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

type State = 'none' | 'queued' | 'running' | 'done' | 'failed';

function stateOf(k: AppKnowledge | null | undefined): State {
  if (k?.auto_status === 'queued' || k?.auto_status === 'running' || k?.auto_status === 'failed') return k.auto_status;
  return isWritten(k) ? 'done' : 'none';
}

const busy = (s: State) => s === 'queued' || s === 'running';

/** "TRIAGE.md · Written by Claude 2 days ago", with the state of the latest write. */
function fileLine(k: AppKnowledge | null | undefined): SafeHtml {
  const s = stateOf(k);
  const lead = s === 'running' ? icon('loader-circle', 14, 'kn-spin') : s === 'queued' ? icon('clock', 14) : s === 'failed' ? icon('triangle-alert', 14, 'warn') : icon('file-text', 14);
  const text: Record<State, SafeHtml | string> = {
    running: 'Claude is writing it…',
    queued: 'Waiting to be written…',
    failed: isWritten(k) ? 'Couldn’t update it' : 'Couldn’t write it',
    done: k?.auto_at ? html`Written by Claude ${ago(k.auto_at)}` : '',
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
    const [counts, issues] = await Promise.all([questionCounts(deps.db, wid, knowledge), issuesPerRepo(deps.db, apps.map((a) => a.repo_id))]);
    const c = settings.config;
    const edit = can(ctx.membership, 'triage.knowledge.edit');
    const states = new Map(apps.map((a) => [a.id, stateOf(knowledge.get(a.id))]));
    const working = apps.filter((a) => busy(states.get(a.id)!)).length;
    const written = apps.filter((a) => isWritten(knowledge.get(a.id))).length;
    const missing = apps.filter((a) => !isWritten(knowledge.get(a.id)) && !busy(states.get(a.id)!)).length;
    const fresh = [...counts.values()].reduce((s, x) => s + x.fresh, 0);
    const sizes = apps.map((a) => knowledgePromptFor(apps, knowledge, [a.id]).length).filter(Boolean);
    const perTicket = sizes.length ? Math.round(sizes.reduce((s, x) => s + x, 0) / sizes.length) : 0;
    const anyOn = settings.enabled || settings.githubEnabled;
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
        <span class="kn-card-text">${sections.length
          ? html`<span class="tags">${sections.map((x) => tag(x))}</span>`
          : s === 'failed' && k?.auto_error
            ? html`<span class="warn-text">${k.auto_error}</span>`
            : `Claude reads its README, changelog and releases${repoIssues ? `, and its ${n(repoIssues)} issues,` : ''} to write it.`}</span>
        <span class="kn-card-f"><span class="kn-card-meta">${isWritten(k)
            ? `${plural(k.auto_sources?.issues.total ?? 0, 'issue')} read · ${tokens(knowledgePromptFor(apps, knowledge, [a.id]).length)}`
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
    const write = !edit
      ? ''
      : working
        ? html`<span class="kn-busy">${icon('loader-circle', 16, 'kn-spin')}Writing ${plural(working, 'TRIAGE.md', 'TRIAGE.md files')}…</span>`
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

    const autoControl = edit
      ? html`<form method="post" action="${listUrl(ctx)}/auto" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'auto', checked: c.knowledgeAuto, label: 'Keep every TRIAGE.md up to date', disabled: !key && !c.knowledgeAuto })}<button type="submit" class="btn sm nojs">Save</button></form>`
      : pill(c.knowledgeAuto ? 'On' : 'Off', c.knowledgeAuto ? 'ok' : 'neutral');

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
          <div class="kn-auto">${setting('Keep them up to date', `While AI triage is on, Claude rewrites each app’s TRIAGE.md every week from the latest issues and releases, and sooner when it has new questions about the app.${costLine(c.model) ? ` Each update: ${costLine(c.model)}.` : ''}`, autoControl, { switchRow: true })}</div>
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
    const [{ questions, more }, issues] = await Promise.all([listQuestions(deps.db, wid, a.id, k), issuesPerRepo(deps.db, [a.repo_id])]);
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
    const writtenDoc = isWritten(k)
      ? html`<div class="card-b"><div class="kn-doc">${renderMarkdown(k.auto_body, repoUrl)}</div></div>
          <details class="kn-raw"><summary>${icon('chevron-right', 14, 'chev')}Markdown<span class="muted"> · exactly what Claude reads</span></summary><pre class="prompt-pre">${k.auto_body}</pre></details>
          <div class="card-note">${[k.auto_model, k.auto_input_tokens ? `${n((k.auto_input_tokens ?? 0) + (k.auto_output_tokens ?? 0))} tokens` : '', used !== null && k.auto_input_tokens ? formatCost(used) : ''].filter(Boolean).join(' · ')}${k.auto_at ? html` · written ${ago(k.auto_at)}` : ''}</div>`
      : '';
    const writtenInner = html`
      ${busy(s)
        ? html`<div class="kn-progress">${icon('loader-circle', 20, 'kn-spin')}<div><strong>${s === 'running' ? `Claude is reading ${a.name}’s repository and ${repoIssues.total ? `${n(repoIssues.total)} issues` : 'issues'}…` : 'Waiting its turn…'}</strong><p class="small muted">It takes about a minute, in the background: you can leave this page.${isWritten(k) ? ' Until then, tickets use the version below.' : ''}</p></div></div>`
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
          ? html`Written by Claude ${ago(k.auto_at)} from ${a.repo_owner}/${a.repo_name}. Claude reads it with every ${a.name} ticket${c.knowledgeAuto ? ' and rewrites it every week' : ''}.`
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
        <div class="stack kn-side">${questionsCard}${sourcesCard}</div>
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
      ? `Claude is ${all ? 'updating' : 'writing'} ${plural(queued, 'TRIAGE.md', 'TRIAGE.md files')}, about a minute each. This page updates as they’re done.`
      : 'They’re already being written.');
    return reply.redirect(listUrl(ctx));
  });

  app.post('/w/:wid/triage/knowledge/auto', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const on = (req.body as { auto?: string } | null)?.auto !== undefined;
    const respond = (ok: boolean, message: string) => {
      if (web.wantsJson(req)) return reply.code(ok ? 200 : 400).send(ok ? { ok, message } : { ok, error: message });
      setFlash(reply, ok ? 'success' : 'error', message);
      return reply.redirect(listUrl(ctx));
    };
    if (on && !(await resolveApiKey(deps, wid))) return respond(false, 'Add a Claude API key in Settings first.');
    const settings = await getTriageSettings(deps.db, wid);
    await saveTriageConfig(deps.db, wid, parseTriageConfig({ ...settings.config, knowledgeAuto: on }));
    if (!on) return respond(true, 'Claude no longer updates them by itself. You can still update each one.');
    // The ones never written start now; the others follow their weekly turn.
    const [apps, knowledge] = await Promise.all([listApps(deps.db, wid), listKnowledge(deps.db, wid)]);
    const queued = await requestWrites(deps.db, wid, apps.filter((a) => !isWritten(knowledge.get(a.id))).map((a) => a.id), ctx.user.id);
    const later = settings.enabled || settings.githubEnabled ? '' : ' Weekly updates start once AI triage is on.';
    return respond(true, `${queued ? `Claude is writing the ${plural(queued, 'missing TRIAGE.md', 'missing TRIAGE.md files')} now, then keeps them all up to date.` : 'Claude keeps every TRIAGE.md up to date.'}${later}`);
  });

  app.post('/w/:wid/triage/knowledge/:appId/write', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const a = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!a) throw new UserFacingError('That app was removed.', 404);
    if (!(await resolveApiKey(deps, ctx.workspace.id))) setFlash(reply, 'error', 'Add a Claude API key in Settings first.');
    else {
      const queued = await requestWrites(deps.db, ctx.workspace.id, [a.id], ctx.user.id);
      setFlash(reply, queued ? 'success' : 'info', queued ? `Claude is writing the TRIAGE.md for ${a.name}, in about a minute. This page updates when it’s done.` : 'It’s already being written.');
    }
    return reply.redirect(knowledgeHref(ctx, a.id));
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

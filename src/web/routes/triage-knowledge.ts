/**
 * AI triage › Knowledge: a TRIAGE.md per app that Claude reads with every ticket, and the
 * questions Claude asks when a fact about the product would have made it surer. Team-only:
 * nothing here is posted on GitHub or shown to members.
 */
import type { FastifyInstance } from 'fastify';
import { can } from '../../domain/permissions.js';
import { getApp, listApps } from '../../domain/store.js';
import { UserFacingError, type AppRow } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { systemPromptFor } from '../../triage/engine.js';
import {
  approxTokens,
  cleanKnowledge,
  getKnowledge,
  isBlank,
  KNOWLEDGE_MAX,
  KNOWLEDGE_SECTIONS,
  KNOWLEDGE_TEMPLATE,
  listKnowledge,
  listQuestions,
  questionCounts,
  saveKnowledge,
  sectionsOf,
  wordCount,
  type AppKnowledge,
  type Question,
} from '../../triage/knowledge.js';
import { getTriageSettings } from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { avatar, badge, csrfField, empty, formatDate, icon, linkBtn, notice, pageHeader, plural, submitBtn, tag, timeAgo } from '../ui.js';
import { areaHref, canOpen, canOpenIssue, knowledgeHref, pageLink, toolHeader, toolHref } from './tool.js';
import { viewOnlyFooter } from './triage.js';

const n = (x: number) => x.toLocaleString('en-US');

/** "about 600 tokens", rounded so it doesn't flicker with every word. */
function tokens(chars: number): string {
  const t = Math.ceil(chars / 4);
  return `about ${n(t >= 1000 ? Math.round(t / 100) * 100 : t >= 100 ? Math.round(t / 10) * 10 : t)} tokens`;
}

/** "Updated 3 days ago by Sam" (with the exact date on hover). */
function updatedLine(k: AppKnowledge): SafeHtml {
  return html`Updated <time datetime="${k.updated_at.toISOString()}" title="${formatDate(k.updated_at)}">${timeAgo(k.updated_at)}</time>${k.updated_by_name ? html` by ${k.updated_by_name}` : ''}`;
}

export function registerTriageKnowledgeRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  // ---- Every app --------------------------------------------------------------------------------

  app.get('/w/:wid/triage/knowledge', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const [apps, knowledge, counts, settings] = await Promise.all([listApps(deps.db, wid), listKnowledge(deps.db, wid), questionCounts(deps.db, wid), getTriageSettings(deps.db, wid)]);
    const edit = can(ctx.membership, 'triage.knowledge.edit');
    const written = apps.filter((a) => !isBlank(knowledge.get(a.id)?.body ?? ''));
    const fresh = [...counts.values()].reduce((s, c) => s + c.fresh, 0);
    const notesChars = written.reduce((s, a) => s + (knowledge.get(a.id)?.body.length ?? 0), 0);
    const anyOn = settings.enabled || settings.githubEnabled;
    const actions = canOpen(ctx.membership, 'triage.actions') ? areaHref(ctx, 'triage.actions') : null;

    const appCard = (a: AppRow) => {
      const k = knowledge.get(a.id);
      const body = k?.body ?? '';
      const blank = isBlank(body);
      const q = counts.get(a.id);
      const sections = blank ? [] : sectionsOf(body);
      return html`<li><a class="kn-card${blank ? ' blank' : ''}" href="${knowledgeHref(ctx, a.id)}">
        <span class="kn-card-h">${avatar(a.name, 32, { square: true, letters: 2 })}<span class="kn-card-name"><span class="cell-title">${a.name}</span><span class="sub mono">${a.repo_owner}/${a.repo_name}</span></span>
          ${q?.fresh ? html`<span class="kn-new" title="Questions Claude asked since this TRIAGE.md was last saved">${icon('lightbulb', 12)}${plural(q.fresh, 'new question')}</span>` : ''}</span>
        <span class="kn-file">${icon('file-text', 14)}<span class="mono">TRIAGE.md</span><span class="muted">·</span>${blank
          ? html`<span class="muted">${k ? 'Empty' : 'Not written yet'}</span>`
          : html`<span class="muted">${updatedLine(k!)}</span>`}</span>
        ${blank
          ? html`<span class="kn-card-text">${edit ? 'Start with what Claude can’t find in a ticket: known issues and their numbers, what works as intended, versions, names members use.' : 'Nothing written for this app yet.'}</span>`
          : html`<span class="kn-card-text">${sections.length ? html`<span class="tags">${sections.map((s) => tag(s))}</span>` : html`<span class="kn-excerpt">${body.slice(0, 180)}</span>`}</span>`}
        <span class="kn-card-f"><span>${blank ? (q?.total ? `${plural(q.total, 'question')} from Claude` : 'No questions yet') : html`${plural(wordCount(body), 'word')} · ${tokens(body.length)}`}</span>
          <span class="kn-open">${blank ? (edit ? 'Write it' : 'Open') : edit ? 'Edit' : 'Read'}${icon('arrow-right', 14)}</span></span>
      </a></li>`;
    };

    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.knowledge')}
      <div class="stack">
        ${!anyOn ? notice('info', null, html`AI triage is off, so Claude isn’t reading these yet. ${canOpen(ctx.membership, 'triage.actions') ? html`Turn it on in ${pageLink(ctx, 'triage.actions', 'Actions')}.` : 'An admin can turn it on.'}`) : ''}
        <div class="card rv-stats">
          <div class="card-h"><div><h2>What Claude knows about your apps</h2><div class="desc">A TRIAGE.md for each app, read with every ticket: the things your team knows that a ticket doesn’t say. Claude asks below when a fact would have made it surer. Only your team sees these; they’re never posted on GitHub or shown to members.</div></div></div>
          <div class="stats four">
            <div class="stat" title="Apps whose TRIAGE.md has something in it"><div class="l">${icon('file-text', 14)}Written</div><div class="v">${n(written.length)}<span class="kn-of">of ${n(apps.length)}</span></div><div class="sub">${apps.length && written.length === apps.length ? 'every app' : apps.length ? `${plural(apps.length - written.length, 'app')} to go` : 'no apps yet'}</div></div>
            <div class="stat" title="Questions Claude asked since each app’s TRIAGE.md was last saved"><div class="l">${icon('lightbulb', 14)}New questions</div><div class="v${fresh ? ' accent' : ''}">${n(fresh)}</div><div class="sub">${fresh ? 'answer them in each app’s TRIAGE.md' : 'nothing new'}</div></div>
            <div class="stat" title="Every app’s TRIAGE.md is part of the instructions, which are cached between tickets"><div class="l">${icon('sparkles', 14)}In the prompt</div><div class="v">${notesChars ? n(Math.ceil(notesChars / 4)) : '0'}</div><div class="sub">tokens per ticket, cached</div></div>
            ${(() => {
              const inner = html`<div class="l">${icon('image', 14)}Screenshots</div><div class="v">${settings.config.screenshots ? 'On' : 'Off'}</div><div class="sub">${settings.config.screenshots ? 'Claude sees what members attach' : 'Claude only reads the text'}</div>`;
              return actions ? html`<a class="stat" href="${actions}#limits" title="Set in Actions › Model, scope and limits">${inner}</a>` : html`<div class="stat">${inner}</div>`;
            })()}
          </div>
        </div>
        ${apps.length
          ? html`<ul class="kn-grid">${apps.map(appCard)}</ul>`
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
    const [k, apps, knowledge, settings] = await Promise.all([getKnowledge(deps.db, wid, a.id), listApps(deps.db, wid), listKnowledge(deps.db, wid), getTriageSettings(deps.db, wid)]);
    const { questions, more } = await listQuestions(deps.db, wid, a.id, k?.updated_at ?? null);
    const edit = can(ctx.membership, 'triage.knowledge.edit');
    const body = k?.body ?? '';
    const fresh = questions.filter((q) => q.fresh).length;
    const listHref = areaHref(ctx, 'triage.knowledge');
    const i = apps.findIndex((x) => x.id === a.id);
    const prev = apps[i - 1];
    const next = apps[i + 1];
    const promptTokens = approxTokens(systemPromptFor(settings.config, apps, knowledge));
    const issuePages = canOpenIssue(ctx.membership);

    const sourceLink = (s: Question['sources'][number]) => {
      const label = s.number ? `${s.repoName}#${String(s.number)}` : 'ticket';
      const title = `${s.kind === 'ticket' ? 'Discord ticket' : 'Opened on GitHub'}${s.title ? `: ${s.title}` : ''}`;
      if (s.kind === 'ticket') return html`<a href="${ctx.base}/tickets/${s.submissionId!}" title="${title}">${label}</a>`;
      return issuePages
        ? html`<a href="${ctx.base}/issues/${String(s.repoId)}/${String(s.number)}" title="${title}">${label}</a>`
        : html`<a href="https://github.com/${a.repo_owner}/${s.repoName}/issues/${String(s.number)}" target="_blank" rel="noopener noreferrer" title="${title}">${label}</a>`;
    };
    const question = (q: Question) => html`<li class="kn-q${q.fresh ? ' fresh' : ''}">
      <p class="kn-q-text">${q.text}</p>
      <div class="kn-q-meta">
        ${q.fresh ? html`<span class="kn-q-new">New</span>` : ''}
        <span>${q.sources.length > 1 ? `Asked ${String(q.sources.length)} times · ` : ''}<time datetime="${q.at.toISOString()}" title="${formatDate(q.at)}">${timeAgo(q.at)}</time></span>
        <span class="kn-q-src">${q.sources.slice(0, 3).map((s, j) => html`${j ? ', ' : ''}${sourceLink(s)}`)}${q.sources.length > 3 ? html` <span class="muted">+${String(q.sources.length - 3)}</span>` : ''}</span>
        ${edit ? html`<button type="button" class="link-btn kn-q-add js-only" data-kn-add="${q.text}" title="Add this question to TRIAGE.md, ready for your answer">${icon('corner-down-left', 12)}Answer</button>` : ''}
      </div>
    </li>`;

    const meter = html`<span class="kn-meter" data-kn-meter-for="kn-body" data-max="${String(KNOWLEDGE_MAX)}">${n(body.length)} / ${n(KNOWLEDGE_MAX)} · ${tokens(body.length)}</span>`;
    const pageBody = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'triage') ?? undefined, label: 'AI triage' }, { href: listHref, label: 'Knowledge' }, { label: a.name }],
        title: html`<span class="kn-title">${avatar(a.name, 28, { square: true, letters: 2 })}${a.name}</span>`,
        after: [tag('TRIAGE.md', { icon: 'file-text', cls: 'mono' })],
        description: k && !isBlank(body)
          ? html`${updatedLine(k)} · ${plural(wordCount(body), 'word')}. Claude reads it with every ticket, for every app.`
          : 'Not written yet. What you write here, Claude reads with every ticket, for every app.',
        actions: [
          prev ? linkBtn(knowledgeHref(ctx, prev.id), prev.name, { icon: 'chevron-left', variant: 'ghost', size: 'sm' }) : null,
          next ? linkBtn(knowledgeHref(ctx, next.id), next.name, { trail: 'chevron-right', variant: 'ghost', size: 'sm' }) : null,
        ],
      })}
      <div class="panel-grid kn-layout">
        <form method="post" action="${knowledgeHref(ctx, a.id)}" class="card kn-editor" ${edit ? raw('data-dirty data-kn-editor') : ''}>
          ${csrfField(ctx.csrf)}
          <div class="kn-file-h">
            <span class="kn-file">${icon('file-text', 14)}<span class="mono">TRIAGE.md</span><span class="muted">· ${a.name}</span></span>
            ${edit && isBlank(body) ? html`<button type="button" class="btn sm ghost js-only" data-kn-template="${KNOWLEDGE_TEMPLATE}">${icon('plus', 14)}Add the sections</button>` : ''}
            ${meter}
          </div>
          <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
            <label class="sr-only" for="kn-body">TRIAGE.md for ${a.name}</label>
            <textarea id="kn-body" name="body" class="kn-text" rows="24" maxlength="${String(KNOWLEDGE_MAX)}" spellcheck="true" placeholder="${`## Known issues\n- ${KNOWLEDGE_SECTIONS[0]!.example}\n\n## Works as intended\n- ${KNOWLEDGE_SECTIONS[1]!.example}\n\n## Versions and platforms\n- ${KNOWLEDGE_SECTIONS[2]!.example}`}">${body}</textarea>
          </fieldset>
          <div class="card-f">${edit
            ? html`<span class="small muted">Used from the next ticket. ${canOpen(ctx.membership, 'triage.runs') ? html`${pageLink(ctx, 'triage.runs', 'Re-run')} triage to try it on older ones.` : ''}<span class="kn-keys js-only"> <kbd>⌘</kbd><kbd>S</kbd> saves.</span></span><div class="end">
                <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
                ${submitBtn('Save TRIAGE.md', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
              </div>`
            : viewOnlyFooter('this TRIAGE.md')}</div>
        </form>
        <div class="stack kn-side">
          <section class="card" id="questions" aria-labelledby="kn-q-h">
            <div class="card-h"><div><div class="title"><h2 id="kn-q-h">Questions from Claude</h2>${fresh ? badge(fresh, 'accent') : ''}</div><div class="desc">When a fact about ${a.name} would have made Claude surer, it asks. Answer once here and later tickets use it.</div></div></div>
            ${questions.length
              ? html`<ul class="kn-qs">${questions.map(question)}</ul>${more ? html`<div class="card-note">${plural(more, 'older question')} not shown.</div>` : ''}`
              : html`<div class="card-b tight"><p class="small muted">No questions yet. When Claude isn’t sure about something only your team knows, its question shows up here, with the tickets it came from.</p></div>`}
          </section>
          <section class="card" aria-labelledby="kn-tips-h">
            <div class="card-h"><div><h2 id="kn-tips-h">What helps Claude</h2><div class="desc">Short, factual lines. Claude treats this as coming from your team.</div></div></div>
            <ul class="kn-tips">${KNOWLEDGE_SECTIONS.map((s) => html`<li><strong>${s.title}</strong><span>${s.text}</span><span class="kn-eg">${s.example}</span></li>`)}</ul>
            <div class="card-note">Claude’s instructions, with every app’s TRIAGE.md, are about ${n(promptTokens)} tokens, cached between tickets.${canOpen(ctx.membership, 'triage.prompt') ? html` ${pageLink(ctx, 'triage.prompt', 'See the full prompt')}` : ''}</div>
          </section>
        </div>
      </div>`;
    return web.render(reply, ctx, `${a.name} · Knowledge · AI triage`, 'triage', pageBody, { width: 'full' });
  });

  app.post('/w/:wid/triage/knowledge/:appId', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.knowledge.edit' });
    if (!ctx) return reply;
    const a = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!a) throw new UserFacingError('That app was removed.', 404);
    const input = String((req.body as { body?: unknown } | null)?.body ?? '');
    try {
      if (input.replace(/\r\n?/g, '\n').trim().length > KNOWLEDGE_MAX) throw new UserFacingError(`TRIAGE.md can be up to ${n(KNOWLEDGE_MAX)} characters. Shorten it and save again.`);
      // The template with nothing filled in says nothing: it's saved as empty.
      const body = isBlank(cleanKnowledge(input)) ? '' : input;
      const changed = await saveKnowledge(deps.db, ctx.workspace.id, a.id, body, ctx.user.id);
      setFlash(reply, changed ? 'success' : 'info', changed ? `TRIAGE.md for ${a.name} saved. Claude uses it from the next ticket.` : 'No changes to save.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(knowledgeHref(ctx, a.id));
  });
}

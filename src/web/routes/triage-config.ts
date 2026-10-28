/**
 * AI triage › Custom labels and AI triage › Prompt: the labels Claude picks from, and what Claude is
 * told (about the products, each check, examples), with a page showing the full prompt.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { can, type MemberAccess } from '../../domain/permissions.js';
import { listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { verdictSchema } from '../../triage/ai.js';
import { knowledgePromptFor, systemPromptFor } from '../../triage/engine.js';
import { isWritten, listKnowledge, notesOf } from '../../triage/knowledge.js';
import { recentChanges, type AppChange } from '../../triage/knowledge-changes.js';
import { buildUserPrompt, DEFAULT_CHECK_RULES, DEFAULT_EXAMPLES } from '../../triage/prompt.js';
import {
  FLAGS,
  getTriageSettings,
  githubMode,
  groupKind,
  LABEL_GROUP_PRESETS,
  MAX_GROUP_OPTIONS,
  MAX_LABEL_GROUPS,
  MODES,
  parseTriageConfig,
  saveTriageConfig,
  workOn,
  type LabelGroup,
  type Mode,
  type TriageConfig,
} from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, empty, icon, iconBtn, labelTag, linkBtn, menu, meter, notice, pageHeader, pill, postBtn, segRadios, selectWrap, submitBtn, timeAgo, type Tone } from '../ui.js';
import { openLabels, openMissing } from '../../triage/label-stats.js';
import { textField } from './panel.js';
import { areaHref, canOpen, knowledgeHref, pageLink, toolHeader, toolHref } from './tool.js';
import { FLAG_COPY, MODE_NAMES, MODE_OPTIONS, viewOnlyFooter } from './triage.js';

const PICK_NAMES: Record<LabelGroup['pick'], string> = { one: 'One label', two: 'Up to two labels', any: 'Any number of labels' };
const n = (x: number) => x.toLocaleString('en-US');
const MODE_TONE: Record<Mode, Tone> = { off: 'neutral', suggest: 'warn', auto: 'ok' };

/** "label: description" lines, as the options box had them. */
function parseOptions(text: string): LabelGroup['options'] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  return checkOptions(lines.map((line) => {
    const i = line.indexOf(':');
    return { label: (i >= 0 ? line.slice(0, i) : line).trim(), description: i >= 0 ? line.slice(i + 1).trim() : '' };
  }));
}

/** A category's labels, checked: 1 to 50 characters each, a sentence of up to 200, no label twice. */
function checkOptions(options: LabelGroup['options']): LabelGroup['options'] {
  if (!options.length) throw new UserFacingError('Add at least one label.');
  if (options.length > MAX_GROUP_OPTIONS) throw new UserFacingError(`A category can have up to ${MAX_GROUP_OPTIONS} labels.`);
  const seen = new Set<string>();
  for (const { label, description } of options) {
    if (!label) throw new UserFacingError(`“${description.slice(0, 60)}” has no label: give it a name, or clear the row.`);
    if (label.length > 50) throw new UserFacingError(`“${label.slice(0, 60)}” is too long: labels are 1 to 50 characters.`);
    if (description.length > 200) throw new UserFacingError(`The sentence for “${label}” is longer than 200 characters.`);
    if (seen.has(label.toLowerCase())) throw new UserFacingError(`“${label}” is listed twice.`);
    seen.add(label.toLowerCase());
  }
  return options;
}

/** Approximate tokens of a text (about four characters each). */
function tokensOf(text: string): string {
  return `about ${(Math.round(text.length / 4 / 100) * 100 || Math.ceil(text.length / 4)).toLocaleString('en-US')} tokens`;
}

/** " Edit it in Prompt and Actions.": the pages that shape the prompt this person can change (empty: none). */
function editIn(m: MemberAccess): string {
  const pages = ([['triage.prompt', 'Prompt'], ['triage.actions', 'Actions'], ['triage.labels', 'Custom labels'], ['triage.knowledge', 'Knowledge']] as const)
    .filter(([a]) => can(m, `${a}.edit`))
    .map(([, name]) => name);
  if (!pages.length) return '';
  return ` Edit it in ${pages.length > 1 ? `${pages.slice(0, -1).join(', ')} and ${pages.at(-1)!}` : pages[0]!}.`;
}

export function registerTriageConfigRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const labelsUrl = (ctx: WorkspaceRequestContext) => areaHref(ctx, 'triage.labels');
  const promptUrl = (ctx: WorkspaceRequestContext) => areaHref(ctx, 'triage.prompt');

  async function update(ctx: WorkspaceRequestContext, change: (c: TriageConfig) => void): Promise<void> {
    const c = structuredClone((await getTriageSettings(deps.db, ctx.workspace.id)).config);
    change(c);
    await saveTriageConfig(deps.db, ctx.workspace.id, parseTriageConfig(c));
  }

  // ---- Custom labels ------------------------------------------------------------------------

  app.get('/w/:wid/triage/labels', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.labels.view' });
    if (!ctx) return reply;
    const b = labelsUrl(ctx);
    const edit = can(ctx.membership, 'triage.labels.edit');
    const [settings, apps] = await Promise.all([getTriageSettings(deps.db, ctx.workspace.id), listApps(deps.db, ctx.workspace.id)]);
    const c = settings.config;
    const groups = c.labelGroups;
    const repoIds = [...new Set(apps.map((a) => a.repo_id))];
    const [open, missing] = await Promise.all([openLabels(deps.db, repoIds), openMissing(deps.db, repoIds, groups)]);
    const full = groups.length >= MAX_LABEL_GROUPS;
    // A backfill of a category, or of one label, starts on Re-run (Custom labels only).
    const runs = can(ctx.membership, 'triage.runs.edit') ? areaHref(ctx, 'triage.runs') : null;
    const backfill = (g: LabelGroup, label?: string) => `${runs}?what=labels&group=${encodeURIComponent(g.id)}${label ? `&only=${encodeURIComponent(label.toLowerCase())}` : ''}`;
    const presets = (Object.keys(LABEL_GROUP_PRESETS) as (keyof typeof LABEL_GROUP_PRESETS)[]).filter((k) => !groups.some((g) => g.name.toLowerCase() === LABEL_GROUP_PRESETS[k].name.toLowerCase()));
    const addMenu = full
      ? html`<span class="small muted">${String(MAX_LABEL_GROUPS)} categories at most</span>`
      : menu([
          ...presets.map((k) => ({ post: `${b}/add`, label: `${LABEL_GROUP_PRESETS[k].name} (ready-made)`, icon: 'tags' as const, fields: { preset: k } })),
          presets.length ? ('sep' as const) : null,
          { post: `${b}/add`, label: 'Empty category', icon: 'plus' as const, fields: { preset: 'empty' } },
        ], { csrf: ctx.csrf, label: 'Add a category', button: { label: 'Add category', opts: { variant: 'primary', icon: 'plus' } } });
    const count = (label: string) => open.byLabel.get(label.toLowerCase()) ?? 0;
    const labelCount = groups.reduce((t, g) => t + g.options.length, 0);
    // The first sentence of what a category is about, for its closed row (the whole text is in the editor).
    const gist = (text: string) => /^(.+?[.!?])(\s|$)/.exec(text.trim())?.[1] ?? text.trim();

    /** One label's row in the editor: its name, when to use it, and how many open issues have it. */
    const row = (g: LabelGroup | null, o: { label: string; description: string } | null) => html`<div class="cl-row" data-row>
        <input type="text" name="opt_label" value="${o?.label ?? ''}" maxlength="50" placeholder="parity" aria-label="Label" autocomplete="off" spellcheck="false">
        <textarea name="opt_desc" rows="1" maxlength="200" placeholder="When Claude should pick it, in one sentence." aria-label="When to use it">${o?.description ?? ''}</textarea>
        <span class="cl-n">${o && g ? html`<span class="num" title="Open issues with this label now">${n(count(o.label))}</span>${runs && edit ? html`<a class="cl-bf" href="${backfill(g, o.label)}" title="Backfill just ${o.label} on open tickets and issues">${icon('history', 14)}<span class="sr-only">Backfill ${o.label}</span></a>` : ''}` : html`<span class="em">new</span>`}</span>
        ${edit ? iconBtn('x', 'Remove this label', { size: 'sm', attrs: raw('data-row-remove') }) : html`<span></span>`}
      </div>`;

    /**
     * A category: closed, one row to read at a glance (its name, how many Claude picks, what it's
     * about, its labels with their open issues, its modes and how many open issues have one); open,
     * its editor. Closed until someone opens it, or comes back to it after saving.
     */
    const category = (g: LabelGroup) => {
      const none = missing.get(g.id) ?? 0;
      const done = open.open ? Math.round(((open.open - none) / open.open) * 100) : 0;
      const ghMode = githubMode(c, groupKind(g.id));
      return html`<details class="cl-cat" id="g-${g.id}" data-flash>
      <summary class="cl-sum">
        <span class="cl-chev" aria-hidden="true">${icon('chevron-right', 14)}</span>
        <span class="cl-main">
          <span class="cl-title"><h2 id="h-${g.id}">${g.name}</h2><span class="cl-pick">${PICK_NAMES[g.pick]} per ticket</span></span>
          ${g.instruction.trim() ? html`<span class="cl-about">${gist(g.instruction)}</span>` : ''}
          <span class="cl-chips">${g.options.map((o) => html`<span class="cl-chip" title="${o.description || o.label}">${labelTag(o.label)}<span class="n">${n(count(o.label))}</span></span>`)}</span>
        </span>
        <span class="cl-side">
          <span class="cl-modes">${pill(`Discord: ${MODE_NAMES[g.mode]}`, MODE_TONE[g.mode])}${pill(`GitHub: ${MODE_NAMES[ghMode]}`, MODE_TONE[ghMode])}</span>
          ${open.open ? html`<span class="cl-cov" title="${`${n(open.open - none)} of ${n(open.open)} open issues have a ${g.name} label`}"><span class="cl-cover-bar">${meter([{ pct: done, cls: 'cl-cover-fill' }])}</span><span><b>${String(done)}%</b> labelled${none ? html`<span class="muted"> · ${n(none)} have none</span>` : ''}</span></span>` : ''}
          <span class="btn sm cl-open" aria-hidden="true"><span class="o">${edit ? 'Edit' : 'Details'}</span><span class="c">Close</span></span>
        </span>
      </summary>
      <div class="cl-body">
        ${open.open || edit ? html`<div class="cl-tools">
          <span class="small muted">${open.open ? html`<b>${n(open.open - none)}</b> of ${n(open.open)} open issues have a ${g.name} label` : ''}</span>
          <div class="row">
            ${runs && edit && none ? linkBtn(backfill(g), `Backfill the ${n(none)} with none`, { size: 'sm', icon: 'history', title: `Add ${g.name} labels to the open tickets and issues that have none` }) : ''}
            ${edit ? postBtn(`${b}/${g.id}/delete`, 'Delete', ctx.csrf, { size: 'sm', variant: 'ghost danger', icon: 'trash-2', confirm: { title: `Delete the ${g.name} category?`, body: 'Claude stops picking these labels. Labels already on issues stay on GitHub.', label: 'Delete category', danger: true } }) : ''}
          </div>
        </div>` : ''}
        <form method="post" action="${b}/${g.id}" ${edit ? raw('data-dirty') : ''}>${csrfField(ctx.csrf)}
          <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
          <div class="section">
            <div class="fields">
              <div class="fields-2">
                <div class="field"><label for="name-${g.id}">Name</label><input id="name-${g.id}" type="text" name="name" value="${g.name}" maxlength="40" required></div>
                <div class="field"><label for="pick-${g.id}">How many Claude picks</label>${selectWrap(html`<select id="pick-${g.id}" name="pick">${(['one', 'two', 'any'] as const).map((p) => html`<option value="${p}" ${p === g.pick ? raw('selected') : ''}>${PICK_NAMES[p]}</option>`)}</select>`)}</div>
              </div>
              ${textField({ id: `instruction-${g.id}`, name: 'instruction', label: 'What this category is about (optional)', value: g.instruction, max: 600, rows: Math.min(6, Math.max(2, Math.ceil(g.instruction.length / 120))), placeholder: 'What kind of work this is for the team, judged by the text.' })}
              <div class="field">
                <div class="lbl-row"><span class="lbl">Labels</span><span class="xs muted">Claude only picks these, by their sentence. New ones are created on GitHub the first time they’re used.</span></div>
                <div class="cl-rows" data-rows data-rows-max="${String(MAX_GROUP_OPTIONS)}">
                  <div class="cl-head" aria-hidden="true"><span>Label</span><span>When to use it</span><span class="num">Open</span><span></span></div>
                  ${g.options.map((o) => row(g, o))}
                  ${edit ? html`<template data-row-template>${row(null, null)}</template>` : ''}
                </div>
                ${edit ? html`<div class="row cl-add"><button type="button" class="btn sm" data-row-add>${icon('plus', 14)}Add label</button><span class="xs muted">Up to ${String(MAX_GROUP_OPTIONS)}.</span></div>` : ''}
              </div>
            </div>
          </div>
          <div class="section">
            <div class="section-h"><div><h3>When Claude picks</h3><div class="desc">For new tickets. Suggest shows the labels for someone to apply; Automatic adds them when Claude is at least ${String(c.threshold)}% sure. A backfill adds them whatever this says.</div></div>
              <div class="src-modes${settings.githubEnabled ? '' : ' gh-off'}">
                <span class="src-l">${icon('message-circle', 14)}Discord tickets</span>${segRadios('mode', MODE_OPTIONS, g.mode, `${g.name} for Discord tickets`)}
                <span class="src-l gh">${icon('github', 14)}Opened on GitHub</span><span class="gh">${segRadios('gh_mode', MODE_OPTIONS, ghMode, `${g.name} for issues opened on GitHub`)}</span>
              </div></div>
          </div>
          </fieldset>
          <div class="card-f">${edit ? html`<span></span><div class="end">
            <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
            ${submitBtn('Save category', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
          </div>` : viewOnlyFooter('this category')}</div>
        </form>
      </div>
    </details>`;
    };

    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.labels')}
      <div class="cl-page">
        <div class="cl-top">
          <div>
            <h2>Custom labels</h2>
            <p class="muted">Your own labels, in categories. For every ticket Claude picks from each category, only from your labels. Open one to edit it.</p>
          </div>
          <div class="row">
            ${runs && groups.length ? linkBtn(`${runs}?what=labels`, 'Backfill…', { icon: 'history' }) : ''}
            ${edit ? addMenu : ''}
          </div>
        </div>
        ${groups.length ? html`<div class="cl-sum-row">
          <span class="chip-stat"><b>${n(groups.length)}</b> ${groups.length === 1 ? 'category' : 'categories'}</span>
          <span class="chip-stat"><b>${n(labelCount)}</b> ${labelCount === 1 ? 'label' : 'labels'}</span>
          <span class="chip-stat"><b>${n(open.open)}</b> open issues</span>
        </div>` : ''}
        ${groups.length
          ? groups.map(category)
          : html`<div class="card">${empty('tags', 'No custom labels yet', edit
            ? 'Each category is a question Claude answers for every ticket, like “what kind of work is this?”, and your labels are its answers. Add one to start, ready-made or empty.'
            : 'An admin can add them here.', edit ? addMenu : null)}</div>`}
        <p class="xs muted cl-foot">Which ticket types each category runs for is set in ${pageLink(ctx, 'triage.actions', 'Actions › Rules by ticket type', '#rules')}. Counts are the open issues on GitHub now.</p>
      </div>`;
    return web.render(reply, ctx, 'Custom labels · AI triage', 'triage', body);
  });

  app.post('/w/:wid/triage/labels/add', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.labels.edit' });
    if (!ctx) return reply;
    const preset = String((req.body as { preset?: string }).preset ?? '');
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    try {
      await update(ctx, (c) => {
        if (c.labelGroups.length >= MAX_LABEL_GROUPS) throw new UserFacingError(`You can have up to ${MAX_LABEL_GROUPS} categories.`);
        const base = preset in LABEL_GROUP_PRESETS
          ? structuredClone(LABEL_GROUP_PRESETS[preset as keyof typeof LABEL_GROUP_PRESETS])
          : { name: 'New category', instruction: '', pick: 'one' as const, options: [{ label: 'example', description: 'Replace with your own labels.' }] };
        c.labelGroups.push({ id, mode: 'off', ...base });
      });
      setFlash(reply, 'success', 'Category added. It starts Off for Discord tickets and for GitHub issues: edit its labels, then choose Suggest or Automatic.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${labelsUrl(ctx)}#g-${id}`);
  });

  app.post('/w/:wid/triage/labels/:gid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.labels.edit' });
    if (!ctx) return reply;
    const gid = (req.params as { gid: string }).gid;
    const f = (req.body ?? {}) as Record<string, string | string[] | undefined>;
    const one = (k: string) => { const v = f[k]; return Array.isArray(v) ? v[0] : v; };
    const all = (k: string) => { const v = f[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; };
    try {
      const name = String(one('name') ?? '').trim();
      if (!name || name.length > 40) throw new UserFacingError('Give the category a name of up to 40 characters.');
      const mode = (MODES as readonly string[]).includes(String(one('mode'))) ? (one('mode') as Mode) : 'off';
      const ghMode = one('gh_mode') === undefined ? undefined : (MODES as readonly string[]).includes(String(one('gh_mode'))) ? (one('gh_mode') as Mode) : 'off';
      const pick = (['one', 'two', 'any'] as const).find((p) => p === one('pick')) ?? 'one';
      const instruction = String(one('instruction') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 600);
      // The editor sends a row per label; "label: description" lines still work.
      const labels = all('opt_label');
      const options = f.opt_label !== undefined
        ? checkOptions(labels.map((label, i) => ({ label: label.trim(), description: String(all('opt_desc')[i] ?? '').replace(/\s+/g, ' ').trim() })).filter((o) => o.label || o.description))
        : parseOptions(String(one('options') ?? ''));
      await update(ctx, (c) => {
        const g = c.labelGroups.find((x) => x.id === gid);
        if (!g) throw new UserFacingError('That category was deleted.', 404);
        if (c.labelGroups.some((x) => x.id !== gid && x.name.toLowerCase() === name.toLowerCase())) throw new UserFacingError(`There’s already a category called ${name}.`);
        Object.assign(g, { name, mode, pick, instruction, options });
        if (ghMode) c.githubModes[groupKind(gid)] = ghMode;
      });
      setFlash(reply, 'success', `${name} saved`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${labelsUrl(ctx)}#g-${gid}`);
  });

  app.post('/w/:wid/triage/labels/:gid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.labels.edit' });
    if (!ctx) return reply;
    const gid = (req.params as { gid: string }).gid;
    await update(ctx, (c) => {
      c.labelGroups = c.labelGroups.filter((g) => g.id !== gid);
      delete c.githubModes[groupKind(gid)];
      // Rules by ticket type no longer mention it.
      for (const rule of Object.values(c.typeRules)) rule.off = rule.off.filter((k) => k !== `group:${gid}`);
    });
    setFlash(reply, 'success', 'Category deleted');
    return reply.redirect(labelsUrl(ctx));
  });

  // ---- Prompt -------------------------------------------------------------------------------

  app.get('/w/:wid/triage/prompt', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.prompt.view' });
    if (!ctx) return reply;
    const [settings, apps, knowledge] = await Promise.all([getTriageSettings(deps.db, ctx.workspace.id), listApps(deps.db, ctx.workspace.id), listKnowledge(deps.db, ctx.workspace.id)]);
    const c = settings.config;
    const b = promptUrl(ctx);
    const system = systemPromptFor(c, apps);
    const notes = canOpen(ctx.membership, 'triage.knowledge');
    const modeOf = (f: (typeof FLAGS)[number]) => c[f].mode;
    const edit = can(ctx.membership, 'triage.prompt.edit');
    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.prompt', { actions: linkBtn(`${b}/full`, 'See the full prompt', { icon: 'file-text' }) })}
      <form method="post" action="${b}" ${edit ? raw('data-dirty') : ''}>
        ${csrfField(ctx.csrf)}
        <fieldset class="plain stack${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
        <div class="card">
          <div class="card-h"><div><h2>About your products</h2><div class="desc">Claude reads this with every ticket. It already gets each app’s name, repository, description and TRIAGE.md.</div></div>${can(ctx.membership, 'apps.view') ? linkBtn(`${ctx.base}/apps`, can(ctx.membership, 'apps.edit') ? 'Edit apps' : 'See apps', { size: 'sm', variant: 'ghost', trail: 'arrow-right' }) : ''}</div>
          <div class="card-b tight">${apps.length
            ? html`<ul class="tri-effects">${apps.map((a) => {
                const k = knowledge.get(a.id);
                const file = html`${icon('file-text', 12)}TRIAGE.md ${isWritten(k) && k.auto_at ? html`written ${timeAgo(k.auto_at)}` : notesOf(k) ? 'team notes only' : 'not written'}`;
                return html`<li><span><strong>${a.name}</strong> <span class="muted mono xs">${a.repo_owner}/${a.repo_name}</span>${a.description ? html`<span class="muted"> · ${a.description}</span>` : html`<span class="em"> · no description</span>`}
                  <span class="muted"> · </span>${notes ? html`<a class="small" href="${knowledgeHref(ctx, a.id)}">${file}</a>` : html`<span class="small muted">${file}</span>`}</span></li>`;
              })}</ul>`
            : html`<p class="small muted">No apps yet.</p>`}</div>
          <div class="section">${textField({ id: 'products', label: 'More about your products (optional)', value: c.products, max: 6000, rows: 6, placeholder: 'PhotoCraft and VectorCraft share the same canvas engine and installer. Members often say “PC” for PhotoCraft. The web version is in beta.', hint: 'How the apps relate, what they share, words members use for them, what’s in beta. Shared code helps Claude spot problems shared across apps; names help it spot tickets filed under the wrong app.' })}</div>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Checks</h2><div class="desc">How Claude decides each check. The built-in wording is tuned to avoid false positives; change it to match how your team triages. Each check is answered on its own; whether it does anything is set in Actions.</div></div></div>
          ${FLAGS.map((f) => html`<div class="section">${textField({
            id: `rule_${f}`,
            label: `${FLAG_COPY[f].title} · Discord: ${MODE_NAMES[modeOf(f)]} · GitHub: ${MODE_NAMES[githubMode(c, f)]}`,
            value: c.checkRules[f]?.trim() || DEFAULT_CHECK_RULES[f],
            max: 2000,
            rows: Math.min(10, Math.max(3, Math.ceil(DEFAULT_CHECK_RULES[f].length / 110))),
            defaultValue: DEFAULT_CHECK_RULES[f],
            hint: html`${c.checkRules[f]?.trim() ? html`<span class="warn-text">Changed.</span> ` : ''}<button type="button" class="link-btn" data-reset-fields="rule_${f}">Reset to default</button>`,
          })}</div>`)}
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Examples</h2><div class="desc">Short worked examples show Claude how the checks apply. Made-up tickets work best; never paste real members’ tickets.</div></div></div>
          <div class="section">${textField({
            id: 'examples',
            label: 'Examples',
            value: c.examples ?? DEFAULT_EXAMPLES,
            max: 6000,
            rows: 10,
            placeholder: 'No examples',
            defaultValue: DEFAULT_EXAMPLES,
            hint: html`One per line: <code>- Ticket: “…”. Candidate: “…”. → what to answer</code>. Leave empty for none. <button type="button" class="link-btn" data-reset-fields="examples">Reset to default</button>`,
          })}</div>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Notes for Claude</h2><div class="desc">Anything else Claude should know: what’s urgent for you, what to ignore. Added at the end, as trusted instructions.</div></div></div>
          <div class="section">${textField({ id: 'instructions', label: 'Notes (optional)', value: c.instructions, max: 2000, rows: 4, placeholder: 'Anything about payments or sign-in is high priority. Questions about pricing are low priority.' })}</div>
          <div class="card-f"><span class="small muted">The prompt is ${tokensOf(system)} before each ticket, plus its app’s TRIAGE.md.</span>${edit ? html`<div class="end">
            <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
            ${submitBtn('Save prompt', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
          </div>` : viewOnlyFooter('the prompt')}</div>
        </div>
        </fieldset>
      </form>`;
    return web.render(reply, ctx, 'Prompt · AI triage', 'triage', body);
  });

  app.post('/w/:wid/triage/prompt', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.prompt.edit' });
    if (!ctx) return reply;
    const f = (req.body ?? {}) as Record<string, string | undefined>;
    const text = (k: string, max: number) => (f[k] === undefined ? undefined : String(f[k]).replace(/\r\n/g, '\n').trim().slice(0, max));
    await update(ctx, (c) => {
      const products = text('products', 6000);
      if (products !== undefined) c.products = products;
      const instructions = text('instructions', 2000);
      if (instructions !== undefined) c.instructions = instructions;
      // Wording equal to the built-in one isn't stored, so later improvements still apply.
      for (const flag of FLAGS) {
        const rule = text(`rule_${flag}`, 2000);
        if (rule === undefined) continue;
        if (!rule || rule === DEFAULT_CHECK_RULES[flag]) delete c.checkRules[flag];
        else c.checkRules[flag] = rule;
      }
      const examples = text('examples', 6000);
      if (examples !== undefined) c.examples = examples === DEFAULT_EXAMPLES ? null : examples;
    });
    setFlash(reply, 'success', 'Prompt saved. New tickets use it; re-run triage to try it on older ones.');
    return reply.redirect(promptUrl(ctx));
  });

  app.get('/w/:wid/triage/prompt/full', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.prompt.view' });
    if (!ctx) return reply;
    const [settings, apps, knowledge] = await Promise.all([getTriageSettings(deps.db, ctx.workspace.id), listApps(deps.db, ctx.workspace.id), listKnowledge(deps.db, ctx.workspace.id)]);
    const c = settings.config;
    const system = systemPromptFor(c, apps);
    // The TRIAGE.md block, for the first app that has one (with what was merged lately, when that's followed).
    const merged = c.knowledgeAuto ? await recentChanges(deps.db, apps.map((a) => a.id)) : new Map<string, AppChange[]>();
    const shown = apps.find((a) => knowledgePromptFor(apps, knowledge, [a.id], merged));
    const known = shown ? knowledgePromptFor(apps, knowledge, [shown.id], merged) : '';
    const groups = c.labelGroups.filter((g) => g.mode !== 'off');
    const sample = buildUserPrompt(
      { app: apps[0]?.name ?? 'Your app', type: 'Bug Report', title: 'Example: the app closes when I export to PNG', description: 'Every time I export a two-page spread to PNG the app closes. Version 0.9 on Windows 11.' },
      [{ ref: `${apps[0] ? `${apps[0].repo_owner}/${apps[0].repo_name}` : 'owner/repo'}#12`, repo: apps[0] ? `${apps[0].repo_owner}/${apps[0].repo_name}` : 'owner/repo', sameRepo: true, number: 12, state: 'closed', stateReason: 'completed', createdAt: new Date('2026-01-15'), app: apps[0]?.name ?? null, title: 'Crash when exporting spreads', text: 'Exporting a spread crashes the app.' }],
      [],
      [],
      // Being worked on, Already fixed: an example pull request.
      workOn(c) ? [{ ref: '#15', kind: 'pull', number: 15, title: 'Fix the crash when exporting spreads to PNG', url: '', state: 'open', text: 'Renders each page of a spread separately. Fixes #12.', for: [12], mergedAt: null, author: 'someone' }] : undefined,
    );
    const fields = Object.keys(verdictSchema({ groups, apps: apps.map((a) => a.name), work: workOn(c) }).shape);
    const body = html`
      ${pageHeader({ title: 'Full prompt', crumbs: [{ href: toolHref(ctx, 'triage') ?? undefined, label: 'AI triage' }, { href: promptUrl(ctx), label: 'Prompt' }, { label: 'Full prompt' }], description: `Exactly what Claude is told, with your current settings.${editIn(ctx.membership)}` })}
      <div class="stack">
        ${settings.enabled ? '' : notice('info', null, 'Triage is off. This is what Claude would be told.')}
        <div class="card">
          <div class="card-h"><div><h2>Instructions</h2><div class="desc">Sent with every Discord ticket: ${tokensOf(system)}. Issues opened on GitHub get the same, with the custom labels that are on for them.</div></div></div>
          <pre class="prompt-pre">${system}</pre>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Then, the app’s TRIAGE.md</h2><div class="desc">${shown
            ? html`Each ticket gets its own app’s, cached on its own${merged.size ? ', with what was merged into its repository lately' : ''}. ${shown.name}’s here: ${tokensOf(known)}.`
            : 'Each ticket gets its own app’s TRIAGE.md, once Claude has written it.'}${canOpen(ctx.membership, 'triage.knowledge') ? html` ${pageLink(ctx, 'triage.knowledge', 'See every app’s in Knowledge')}.` : ''}</div></div></div>
          ${known ? html`<pre class="prompt-pre">${known}</pre>` : ''}
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Then, for each ticket</h2><div class="desc">The ticket${c.screenshots ? ', its screenshots (up to 5, before the text)' : ''} and up to 40 similar issues from your repositories (each shortened to 800 characters). A made-up ticket here.</div></div></div>
          <pre class="prompt-pre">${sample}</pre>
        </div>
        <div class="card">
          <div class="card-h"><div><h2>Answer format</h2><div class="desc">Claude must answer with these fields, in this order. Label options and app names are fixed lists, and every issue it names is checked against what it was shown.</div></div></div>
          <div class="card-b tight"><div class="tags">${fields.map((k) => html`<code class="xs">${k}</code>`)}</div></div>
        </div>
      </div>`;
    return web.render(reply, ctx, 'Full prompt · AI triage', 'triage', body);
  });
}

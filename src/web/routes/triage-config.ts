/**
 * AI triage › Label groups and AI triage › Prompt: the labels Claude picks from, and what Claude is
 * told (about the products, each check, examples), with a page showing the full prompt.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { can, type MemberAccess } from '../../domain/permissions.js';
import { listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { verdictSchema } from '../../triage/ai.js';
import { systemPromptFor } from '../../triage/engine.js';
import { isBlank, listKnowledge } from '../../triage/knowledge.js';
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
  type LabelGroup,
  type Mode,
  type TriageConfig,
} from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, empty, icon, labelTag, linkBtn, notice, pageHeader, pill, postBtn, segRadios, selectWrap, submitBtn, timeAgo, type Tone } from '../ui.js';
import { textField } from './panel.js';
import { areaHref, canOpen, knowledgeHref, pageLink, toolHeader, toolHref } from './tool.js';
import { FLAG_COPY, MODE_NAMES, MODE_OPTIONS, viewOnlyFooter } from './triage.js';

const PICK_NAMES: Record<LabelGroup['pick'], string> = { one: 'One option', two: 'Up to two options', any: 'Any number of options' };
const MODE_TONE: Record<Mode, Tone> = { off: 'neutral', suggest: 'warn', auto: 'ok' };

/** "label: description" lines, as edited in the options box. */
function optionsText(g: Pick<LabelGroup, 'options'>): string {
  return g.options.map((o) => (o.description ? `${o.label}: ${o.description}` : o.label)).join('\n');
}

function parseOptions(text: string): LabelGroup['options'] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new UserFacingError('Add at least one option.');
  if (lines.length > MAX_GROUP_OPTIONS) throw new UserFacingError(`A group can have up to ${MAX_GROUP_OPTIONS} options.`);
  const seen = new Set<string>();
  return lines.map((line) => {
    const i = line.indexOf(':');
    const label = (i >= 0 ? line.slice(0, i) : line).trim();
    const description = i >= 0 ? line.slice(i + 1).trim() : '';
    if (!label || label.length > 50) throw new UserFacingError(`“${label.slice(0, 60) || line.slice(0, 60)}” isn’t a valid label: labels are 1 to 50 characters, before the colon.`);
    if (description.length > 200) throw new UserFacingError(`The description of “${label}” is longer than 200 characters.`);
    if (seen.has(label.toLowerCase())) throw new UserFacingError(`“${label}” is listed twice.`);
    seen.add(label.toLowerCase());
    return { label, description };
  });
}

/** Approximate tokens of a text (about four characters each). */
function tokensOf(text: string): string {
  return `about ${(Math.round(text.length / 4 / 100) * 100 || Math.ceil(text.length / 4)).toLocaleString('en-US')} tokens`;
}

/** " Edit it in Prompt and Actions.": the pages that shape the prompt this person can change (empty: none). */
function editIn(m: MemberAccess): string {
  const pages = ([['triage.prompt', 'Prompt'], ['triage.actions', 'Actions'], ['triage.labels', 'Label groups'], ['triage.knowledge', 'Knowledge']] as const)
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

  // ---- Label groups -------------------------------------------------------------------------

  app.get('/w/:wid/triage/labels', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.labels.view' });
    if (!ctx) return reply;
    const b = labelsUrl(ctx);
    const edit = can(ctx.membership, 'triage.labels.edit');
    const c = (await getTriageSettings(deps.db, ctx.workspace.id)).config;
    const groups = c.labelGroups;
    const full = groups.length >= MAX_LABEL_GROUPS;
    const presets = (Object.keys(LABEL_GROUP_PRESETS) as (keyof typeof LABEL_GROUP_PRESETS)[]).filter((k) => !groups.some((g) => g.name.toLowerCase() === LABEL_GROUP_PRESETS[k].name.toLowerCase()));
    const addButtons = html`${presets.map((k) => postBtn(`${b}/add`, LABEL_GROUP_PRESETS[k].name, ctx.csrf, { size: 'sm', icon: 'plus', fields: { preset: k }, disabled: full }))}
      ${postBtn(`${b}/add`, 'Empty group', ctx.csrf, { size: 'sm', variant: 'ghost', icon: 'plus', fields: { preset: 'empty' }, disabled: full })}`;

    const settings = await getTriageSettings(deps.db, ctx.workspace.id);
    const groupCard = (g: LabelGroup) => html`<div class="card" id="g-${g.id}">
      <div class="card-h"><div><div class="title"><h2>${g.name}</h2>${pill(`Discord: ${MODE_NAMES[g.mode]}`, MODE_TONE[g.mode])}${pill(`GitHub: ${MODE_NAMES[githubMode(c, groupKind(g.id))]}`, MODE_TONE[githubMode(c, groupKind(g.id))])}</div><div class="desc">${PICK_NAMES[g.pick]} · <span class="tags">${g.options.slice(0, 8).map((o) => labelTag(o.label))}${g.options.length > 8 ? html`<span class="small muted">+${String(g.options.length - 8)} more</span>` : ''}</span></div></div>
        ${edit ? postBtn(`${b}/${g.id}/delete`, 'Delete', ctx.csrf, { size: 'sm', variant: 'ghost danger', icon: 'trash-2', confirm: { title: `Delete the ${g.name} group?`, body: 'Claude stops picking these labels. Labels already added to issues stay on GitHub.', label: 'Delete group', danger: true } }) : ''}</div>
      <form method="post" action="${b}/${g.id}" ${edit ? raw('data-dirty') : ''}>${csrfField(ctx.csrf)}
        <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
        <div class="section">
          <div class="section-h"><div><h3>When Claude picks</h3><div class="desc">Set separately for Discord tickets and issues opened on GitHub. Suggest shows the labels for someone to apply; Automatic adds them when Claude is at least ${String(c.threshold)}% sure.</div></div>
            <div class="src-modes${settings.githubEnabled ? '' : ' gh-off'}">
              <span class="src-l">${icon('message-circle', 14)}Discord tickets</span>${segRadios('mode', MODE_OPTIONS, g.mode, `${g.name} for Discord tickets`)}
              <span class="src-l gh">${icon('github', 14)}Opened on GitHub</span><span class="gh">${segRadios('gh_mode', MODE_OPTIONS, githubMode(c, groupKind(g.id)), `${g.name} for issues opened on GitHub`)}</span>
            </div></div>
          <div class="fields">
            <div class="fields-2">
              <div class="field"><label for="name-${g.id}">Name</label><input id="name-${g.id}" type="text" name="name" value="${g.name}" maxlength="40" required></div>
              <div class="field"><label for="pick-${g.id}">How many to pick</label>${selectWrap(html`<select id="pick-${g.id}" name="pick">${(['one', 'two', 'any'] as const).map((p) => html`<option value="${p}" ${p === g.pick ? raw('selected') : ''}>${PICK_NAMES[p]}</option>`)}</select>`)}</div>
            </div>
            ${textField({ id: `instruction-${g.id}`, name: 'instruction', label: 'What this group is about (optional)', value: g.instruction, max: 600, rows: 2, placeholder: 'The part of the app the ticket is about.' })}
            ${textField({ id: `options-${g.id}`, name: 'options', label: 'Options', value: optionsText(g), max: 5000, rows: Math.min(12, Math.max(4, g.options.length + 1)), placeholder: 'crash: The app crashes, freezes or loses work.\nbug: Wrong behaviour.', hint: html`One per line: <code>label: when to use it</code>. Claude can only pick these labels; each is created on GitHub the first time it’s used. Up to ${String(MAX_GROUP_OPTIONS)}.` })}
          </div>
        </div>
        </fieldset>
        <div class="card-f">${edit ? html`<span></span><div class="end">
          <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
          ${submitBtn('Save group', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
        </div>` : viewOnlyFooter('this group')}</div>
      </form>
    </div>`;

    const body = html`
      ${await toolHeader(web, ctx, 'triage', 'triage.labels')}
      <div class="stack">
        <div class="card">
          <div class="card-h"><div><h2>Label groups</h2><div class="desc">Sets of labels Claude sorts tickets with, such as the type of problem, the part of the app and the platform. Claude only picks from the options you list, using each one’s description. New groups start Off.</div></div></div>
          ${!edit
            ? (groups.length ? '' : empty('tags', 'No label groups yet', 'An admin can add groups here.'))
            : groups.length
              ? html`<div class="card-b tight"><div class="row"><span class="small muted">Add a group:</span>${addButtons}</div>${full ? html`<p class="small muted mt-8">You have the maximum of ${String(MAX_LABEL_GROUPS)} groups.</p>` : ''}</div>`
              : empty('tags', 'No label groups yet', 'Start from a ready-made group and edit its options, or start empty.', html`<div class="row">${addButtons}</div>`)}
          <div class="card-note">Which ticket types each group runs for is set in ${pageLink(ctx, 'triage.actions', 'Actions › Rules by ticket type', '#rules')}.</div>
        </div>
        ${groups.map(groupCard)}
      </div>`;
    return web.render(reply, ctx, 'Label groups · AI triage', 'triage', body);
  });

  app.post('/w/:wid/triage/labels/add', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.labels.edit' });
    if (!ctx) return reply;
    const preset = String((req.body as { preset?: string }).preset ?? '');
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    try {
      await update(ctx, (c) => {
        if (c.labelGroups.length >= MAX_LABEL_GROUPS) throw new UserFacingError(`You can have up to ${MAX_LABEL_GROUPS} label groups.`);
        const base = preset in LABEL_GROUP_PRESETS
          ? structuredClone(LABEL_GROUP_PRESETS[preset as keyof typeof LABEL_GROUP_PRESETS])
          : { name: 'New group', instruction: '', pick: 'one' as const, options: [{ label: 'example', description: 'Replace with your own options.' }] };
        c.labelGroups.push({ id, mode: 'off', ...base });
      });
      setFlash(reply, 'success', 'Label group added. It starts Off for Discord tickets and for GitHub issues: edit its options, then choose Suggest or Automatic.');
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
    const f = (req.body ?? {}) as Record<string, string | undefined>;
    try {
      const name = String(f.name ?? '').trim();
      if (!name || name.length > 40) throw new UserFacingError('Give the group a name of up to 40 characters.');
      const mode = (MODES as readonly string[]).includes(String(f.mode)) ? (f.mode as Mode) : 'off';
      const ghMode = f.gh_mode === undefined ? undefined : (MODES as readonly string[]).includes(String(f.gh_mode)) ? (f.gh_mode as Mode) : 'off';
      const pick = (['one', 'two', 'any'] as const).find((p) => p === f.pick) ?? 'one';
      const instruction = String(f.instruction ?? '').replace(/\r\n/g, '\n').trim().slice(0, 600);
      const options = parseOptions(String(f.options ?? ''));
      await update(ctx, (c) => {
        const g = c.labelGroups.find((x) => x.id === gid);
        if (!g) throw new UserFacingError('That label group was deleted.', 404);
        if (c.labelGroups.some((x) => x.id !== gid && x.name.toLowerCase() === name.toLowerCase())) throw new UserFacingError(`There’s already a group called ${name}.`);
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
    setFlash(reply, 'success', 'Label group deleted');
    return reply.redirect(labelsUrl(ctx));
  });

  // ---- Prompt -------------------------------------------------------------------------------

  app.get('/w/:wid/triage/prompt', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.prompt.view' });
    if (!ctx) return reply;
    const [settings, apps, knowledge] = await Promise.all([getTriageSettings(deps.db, ctx.workspace.id), listApps(deps.db, ctx.workspace.id), listKnowledge(deps.db, ctx.workspace.id)]);
    const c = settings.config;
    const b = promptUrl(ctx);
    const system = systemPromptFor(c, apps, knowledge);
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
                const written = k && !isBlank(k.body);
                const file = html`${icon('file-text', 12)}TRIAGE.md ${written ? html`updated ${timeAgo(k.updated_at)}` : 'not written'}`;
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
          <div class="card-f"><span class="small muted">The prompt is ${tokensOf(system)} before each ticket.</span>${edit ? html`<div class="end">
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
    const system = systemPromptFor(c, apps, knowledge);
    const groups = c.labelGroups.filter((g) => g.mode !== 'off');
    const sample = buildUserPrompt(
      { app: apps[0]?.name ?? 'Your app', type: 'Bug Report', title: 'Example: the app closes when I export to PNG', description: 'Every time I export a two-page spread to PNG the app closes. Version 0.9 on Windows 11.' },
      [{ ref: `${apps[0] ? `${apps[0].repo_owner}/${apps[0].repo_name}` : 'owner/repo'}#12`, repo: apps[0] ? `${apps[0].repo_owner}/${apps[0].repo_name}` : 'owner/repo', sameRepo: true, number: 12, state: 'closed', stateReason: 'completed', createdAt: new Date('2026-01-15'), app: apps[0]?.name ?? null, title: 'Crash when exporting spreads', text: 'Exporting a spread crashes the app.' }],
    );
    const fields = Object.keys(verdictSchema({ groups, apps: apps.map((a) => a.name) }).shape);
    const body = html`
      ${pageHeader({ title: 'Full prompt', crumbs: [{ href: toolHref(ctx, 'triage') ?? undefined, label: 'AI triage' }, { href: promptUrl(ctx), label: 'Prompt' }, { label: 'Full prompt' }], description: `Exactly what Claude is told, with your current settings.${editIn(ctx.membership)}` })}
      <div class="stack">
        ${settings.enabled ? '' : notice('info', null, 'Triage is off. This is what Claude would be told.')}
        <div class="card">
          <div class="card-h"><div><h2>Instructions</h2><div class="desc">Sent with every Discord ticket: ${tokensOf(system)}. Issues opened on GitHub get the same, with the label groups that are on for them.</div></div></div>
          <pre class="prompt-pre">${system}</pre>
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

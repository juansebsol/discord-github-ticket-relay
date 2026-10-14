import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getInstallationRepos } from '../../domain/repos.js';
import { getGitHubConnection, listApps } from '../../domain/store.js';
import { CUSTOM_KINDS, FILES_HINT, FORM_MAX_SECTIONS, formFor, KIND_NAMES, LIMITS, MAX_FILES_LIMIT, validateForm, type FormSection, type SectionKind } from '../../domain/forms.js';
import {
  createTicketType,
  deleteTicketType,
  distinctRepos,
  findMissingTypeLabels,
  getTicketType,
  labelColor,
  listTicketTypes,
  moveTicketType,
  saveTicketTypeForm,
  updateTicketType,
  type TicketType,
  type TicketTypeInput,
} from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { formPreview, previewCaption } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { btn, csrfField, empty, icon, iconBtn, labelTag, linkBtn, locked, menu, notice, pageHeader, postBtn, submitBtn, switchInput, tag, typeIcon, type IconName } from '../ui.js';
import { ACTION_KINDS, ACTION_NAMES, actionsOffFor, getTriageSettings } from '../../triage/settings.js';
import { ticketsHeader } from './tickets.js';

const typeSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Keep the name under 80 characters.'),
  description: z.string().trim().max(100, 'Keep the description under 100 characters (Discord’s limit).').optional().default(''),
  label: z.string().trim().max(50, 'GitHub labels are at most 50 characters.').optional().default(''),
  title_prefix: z.string().trim().max(30, 'Keep the title prefix under 30 characters.').optional().default(''),
  enabled: z.string().optional(),
});

function toInput(d: z.infer<typeof typeSchema>): TicketTypeInput {
  return {
    name: d.name,
    description: d.description || null,
    label: d.label || null,
    title_prefix: d.title_prefix || null,
    guidance: null,
    placeholder: null,
    enabled: d.enabled !== undefined,
  };
}

const KIND_ICONS: Record<SectionKind, IconName> = {
  intro: 'text',
  title: 'heading',
  description: 'align-left',
  short: 'text-cursor-input',
  paragraph: 'align-left',
  files: 'paperclip',
};

function sectionName(s: FormSection): string {
  return s.kind === 'intro' ? 'Intro text' : s.label.trim() || KIND_NAMES[s.kind];
}

/** The Form column: how full the form is, linking to the builder. */
function formSummary(base: string, t: TicketType): SafeHtml {
  const sections = formFor(t);
  const own = sections.filter((x) => (CUSTOM_KINDS as readonly string[]).includes(x.kind)).length;
  return html`<a class="small nowrap" href="${base}/tickets/types/${t.id}/form">${String(sections.length)} of ${String(FORM_MAX_SECTIONS)} sections</a><div class="sub nowrap">${own ? `${own} extra question${own === 1 ? '' : 's'}` : 'Title and description'}</div>`;
}

// ---- Form builder ----------------------------------------------------------------------------------

function counterField(o: { id: string; name: string; label: string; value: string; max: number; placeholder?: string; hint?: string; rows?: number; optional?: boolean }): SafeHtml {
  const attrs = html`id="${o.id}" name="${o.name}" maxlength="${String(o.max)}" ${o.placeholder ? html`placeholder="${o.placeholder}"` : ''}`;
  return html`<div class="field"><div class="field-head"><label for="${o.id}">${o.label}${o.optional ? html` <span class="opt">(optional)</span>` : ''}</label><span class="counter" data-counter-for="${o.id}">${String(o.value.length)} / ${String(o.max)}</span></div>
    ${o.rows ? html`<textarea ${attrs} rows="${String(o.rows)}">${o.value}</textarea>` : html`<input type="text" class="full" ${attrs} value="${o.value}">`}
    ${o.hint ? html`<div class="hint">${o.hint}</div>` : ''}</div>`;
}

const LOCKED_NOTE: Partial<Record<SectionKind, string>> = {
  title: 'Every ticket needs a title. It becomes the GitHub issue title.',
  description: 'Every ticket needs a description. It becomes the main text of the issue.',
};

/** One section in the builder. `key` may be the template placeholder __KEY__. */
function sectionEditor(s: FormSection): SafeHtml {
  const k = s.key;
  const id = (f: string) => `fb-${k}-${f}`;
  const builtIn = s.kind === 'intro' || s.kind === 'title' || s.kind === 'description';
  const required = s.kind === 'title' || s.kind === 'description' || s.required;
  const questionFields = html`<div class="fields-2">
      ${counterField({ id: id('label'), name: `${k}.label`, label: 'Question', value: s.label, max: LIMITS.label, placeholder: s.kind === 'files' ? 'Screenshots' : 'e.g. Which version are you using?' })}
      ${s.kind === 'files'
        ? html`<div class="field"><label for="${id('max')}">Files members can attach</label><input type="number" id="${id('max')}" name="${k}.max" value="${String(s.maxFiles)}" min="1" max="${String(MAX_FILES_LIMIT)}" required class="wide"><div class="hint">1 to ${String(MAX_FILES_LIMIT)}. Images only (PNG, JPG, GIF, WebP), up to 10 MB each.</div></div>`
        : counterField({ id: id('placeholder'), name: `${k}.placeholder`, label: 'Placeholder', value: s.placeholder, max: LIMITS.placeholder, optional: true, hint: 'Example text inside the empty box.' })}
    </div>
    ${counterField({ id: id('hint'), name: `${k}.hint`, label: 'Hint', value: s.hint, max: LIMITS.hint, optional: true, hint: 'Shown under the question.' })}`;
  const body = s.kind === 'intro'
    ? counterField({ id: id('text'), name: `${k}.text`, label: 'Text', value: s.text, max: LIMITS.intro, rows: 3, hint: 'Shown at the top of the form. Members also always see whether their report is public, and a reminder not to share passwords.' })
    : html`${questionFields}${builtIn
        ? html`<p class="small muted">${LOCKED_NOTE[s.kind] ?? ''}</p>`
        : html`<label class="check"><input type="checkbox" name="${k}.required" value="1" ${s.required ? raw('checked') : ''}> Required</label>`}`;
  return html`<li class="fsec" data-kind="${s.kind}" data-key="${k}" data-kind-name="${KIND_NAMES[s.kind]}">
    <input type="hidden" name="sec" value="${k}"><input type="hidden" name="${k}.kind" value="${s.kind}">
    <div class="fsec-h">
      <span class="fsec-n" aria-hidden="true"></span>
      <span class="tile">${icon(KIND_ICONS[s.kind], 16)}</span>
      <div class="grow"><div class="fsec-t" data-fb-title>${sectionName(s)}</div><div class="sub" data-fb-sub>${KIND_NAMES[s.kind]}${s.kind === 'intro' ? '' : required ? ' · Required' : ' · Optional'}</div></div>
      <div class="fsec-actions">
        ${s.kind === 'intro' ? '' : html`${iconBtn('arrow-up', 'Move up', { size: 'sm', cls: 'js-only', attrs: raw('data-fb-move="up"') })}${iconBtn('arrow-down', 'Move down', { size: 'sm', cls: 'js-only', attrs: raw('data-fb-move="down"') })}`}
        ${s.kind === 'title' || s.kind === 'description' ? locked('Always included') : iconBtn('trash-2', 'Remove section', { size: 'sm', cls: 'js-only', attrs: raw('data-fb-remove') })}
      </div>
    </div>
    <div class="fsec-b fields">${body}</div>
  </li>`;
}

function blank(kind: SectionKind): FormSection {
  const label = kind === 'files' ? 'Screenshots' : '';
  return { key: kind === 'intro' ? 'intro' : '__KEY__', kind, label, hint: kind === 'files' ? FILES_HINT : '', placeholder: '', text: kind === 'intro' ? '' : '', required: false, maxFiles: 5 };
}

/** Reads the builder's fields back into sections, in the order they were on the page. */
function parseSections(body: Record<string, unknown>): FormSection[] | null {
  const raw = body.sec;
  const keys = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String).slice(0, 12);
  const sections: FormSection[] = [];
  for (const key of keys) {
    const get = (f: string) => {
      const v = body[`${key}.${f}`];
      return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '';
    };
    const kind = get('kind') as SectionKind;
    if (!Object.hasOwn(KIND_NAMES, kind)) return null;
    sections.push({
      key,
      kind,
      label: get('label').replace(/\s+/g, ' ').trim(),
      hint: get('hint').replace(/\s+/g, ' ').trim(),
      placeholder: get('placeholder').replace(/\s+/g, ' ').trim(),
      text: get('text').replace(/\r\n/g, '\n').trim(),
      required: kind === 'title' || kind === 'description' ? true : get('required') !== '',
      maxFiles: kind === 'files' ? Math.round(Number(get('max'))) || 0 : 5,
    });
  }
  return sections;
}

const UPDATE_PANEL = 'Update the panel so its steps match.';

export function registerTicketTypeRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const typesUrl = (ctx: WorkspaceRequestContext) => `${ctx.base}/tickets/types`;

  app.get('/w/:wid/tickets/types', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const b = ctx.base;
    const types = await listTicketTypes(deps.db, ctx.workspace.id);
    const triage = await getTriageSettings(deps.db, ctx.workspace.id);
    /** What triage does for a type, linking to the rules table. */
    const triageRule = (t: TicketType) => {
      const off = actionsOffFor(triage.config, t);
      const text = off.size === 0 ? 'All actions' : off.size === ACTION_KINDS.length ? 'Not triaged' : `All except ${ACTION_KINDS.filter((k) => off.has(k)).map((k) => ACTION_NAMES[k]).join(', ')}`;
      return html`<a class="small" href="${b}/tickets/triage#rules">${text}</a>`;
    };
    let gaps: Awaited<ReturnType<typeof findMissingTypeLabels>> = [];
    let gapError = '';
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (types.some((t) => t.enabled && t.label) && gh && deps.github) {
      try {
        gaps = await findMissingTypeLabels(deps.github, gh.installation_id, types, distinctRepos(await listApps(deps.db, ctx.workspace.id)));
      } catch {
        gapError = 'Couldn’t check the labels on GitHub right now. Reload to try again.';
      }
    }
    const newType = linkBtn(`${b}/tickets/types/new`, 'New type', { variant: 'primary', icon: 'plus' });
    const body = html`
      ${await ticketsHeader(web, ctx, 'types', { actions: newType })}
      ${gapError ? notice('warn', 'Labels not checked', gapError) : ''}
      ${gaps.length
        ? notice('warn', 'Some type labels don’t exist yet', html`Tickets are filed without a missing label until it exists.<ul>${gaps.map((g) => html`<li><code>${g.label}</code> is missing in ${g.repos.map((r) => `${r.owner}/${r.name}`).join(', ')}</li>`)}</ul>`, {
            action: postBtn(`${b}/tickets/types/create-labels`, 'Create missing labels', ctx.csrf, { size: 'sm', loading: 'Creating…', confirm: { title: 'Create the missing labels?', body: 'The labels are created in those GitHub repositories with a default color. You can rename or recolor them on GitHub later.', label: 'Create labels' } }),
          })
        : ''}
      <div class="card">
        ${types.length
          ? html`<div class="card-h"><div class="desc">Members pick a type after choosing an app. The label and title prefix are added to the GitHub issue, for example <code>[Bug] [Mobile App] Export fails</code>.</div></div>
              <div class="card-b flush"><div class="table-wrap"><table>
                <thead><tr><th>Type</th><th>GitHub label</th><th>Title prefix</th><th>Form</th>${triage.enabled ? html`<th>Triage</th>` : ''}<th class="center">Enabled</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${types.map((t, i) => html`<tr class="${t.enabled ? '' : 'off'}">
                  <td><div class="who-cell">${icon(typeIcon(t), 16, 'muted')}<div><div class="cell-title">${t.name}</div>${t.description ? html`<div class="sub">${t.description}</div>` : ''}</div></div></td>
                  <td>${t.label ? labelTag(t.label) : html`<span class="em">—</span>`}</td>
                  <td><code class="nowrap">[${t.title_prefix || t.name}]</code></td>
                  <td>${formSummary(b, t)}</td>
                  ${triage.enabled ? html`<td>${triageRule(t)}</td>` : ''}
                  <td class="center"><form method="post" action="${b}/tickets/types/${t.id}/toggle" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
                    ${switchInput({ name: 'enabled', checked: t.enabled, label: `${t.name} enabled` })}<button type="submit" class="btn sm nojs">Save</button></form></td>
                  <td class="actions"><div class="row">
                    ${iconBtn('clipboard-list', `Edit the ${t.name} form`, { size: 'sm', href: `${b}/tickets/types/${t.id}/form` })}
                    ${iconBtn('pencil', `Edit ${t.name}`, { size: 'sm', href: `${b}/tickets/types/${t.id}/edit` })}
                    ${menu([
                      i > 0 ? { post: `${b}/tickets/types/${t.id}/move`, label: 'Move up', icon: 'arrow-up', fields: { direction: 'up' } } : null,
                      i < types.length - 1 ? { post: `${b}/tickets/types/${t.id}/move`, label: 'Move down', icon: 'arrow-down', fields: { direction: 'down' } } : null,
                      'sep',
                      { post: `${b}/tickets/types/${t.id}/delete`, label: 'Delete type…', icon: 'trash-2', danger: true, confirm: { title: `Delete “${t.name}”?`, body: 'Members can’t pick it anymore after you update the panel. Tickets already filed keep their label.', label: 'Delete type', danger: true } },
                    ], { csrf: ctx.csrf, label: `More actions for ${t.name}` })}
                  </div></td></tr>`)}
                </tbody></table></div></div>
              <div class="card-note">The order here is the order in Discord. After changing types, update the panel on the Panel tab.</div>`
          : empty('tag', 'No ticket types', 'Without types, members go straight to the form. Add types like Bug report or Feature request so maintainers can tell tickets apart.', newType)}
      </div>`;
    return web.render(reply, ctx, 'Ticket types', 'tickets', body);
  });

  async function renderForm(ctx: WorkspaceRequestContext, reply: FastifyReply, existing: TicketType | null, values: Partial<TicketTypeInput>, errors: string[] = []) {
    const b = ctx.base;
    const title = existing ? `Edit ${existing.name}` : 'New ticket type';
    // Suggest labels that already exist in the apps' repositories.
    let suggestions: string[] = [];
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (gh && deps.github) {
      try {
        const repos = distinctRepos(await listApps(deps.db, ctx.workspace.id));
        const accessible = new Set((await getInstallationRepos(deps, gh.installation_id)).map((r) => r.id));
        const all = await Promise.all(repos.filter((r) => accessible.has(r.id)).map((r) => deps.github!.listLabels(gh.installation_id, r.owner, r.name)));
        suggestions = [...new Set(all.flat())].sort((x, y) => x.localeCompare(y));
      } catch {
        suggestions = [];
      }
    }
    const v = (k: keyof TicketTypeInput) => (values[k] as string | null | undefined) ?? '';
    const body = html`
      ${pageHeader({
        crumbs: [{ href: `${b}/tickets`, label: 'Tickets' }, { href: `${b}/tickets/types`, label: 'Ticket types' }, { label: existing ? existing.name : 'New type' }],
        title,
        description: 'Members see the name and description. The GitHub label and title prefix are added to the issue.',
      })}
      ${errors.length ? notice('danger', 'Please fix the following', html`<ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>`) : ''}
      <form method="post" action="${existing ? `${b}/tickets/types/${existing.id}` : `${b}/tickets/types`}" class="card">
        ${csrfField(ctx.csrf)}
        <div class="card-b"><div class="fields">
          <div class="fields-2">
            <div class="field"><label for="name">Name</label><input id="name" type="text" name="name" value="${v('name')}" required maxlength="80" placeholder="Bug report"><div class="hint">Shown in the type menu in Discord.</div></div>
            <div class="field"><label for="description">Short description <span class="opt">(optional)</span></label><input id="description" type="text" name="description" value="${v('description')}" maxlength="100" placeholder="Something isn’t working"></div>
            <div class="field"><label for="label">GitHub label <span class="opt">(optional)</span></label><input id="label" type="text" name="label" value="${v('label')}" maxlength="50" list="label-suggestions" placeholder="bug" autocomplete="off">
              <datalist id="label-suggestions">${suggestions.map((l) => html`<option value="${l}"></option>`)}</datalist>
              <div class="hint">Added together with the app’s labels. Pick an existing label or type a new one; missing labels can be created from the Ticket types tab.</div></div>
            <div class="field"><label for="title_prefix">Title prefix <span class="opt">(optional)</span></label><input id="title_prefix" type="text" name="title_prefix" value="${v('title_prefix')}" maxlength="30" placeholder="Defaults to the name"><div class="hint"><code>Bug</code> gives <code>[Bug] [Mobile App] Export fails</code>.</div></div>
          </div>
          <div class="field"><div class="label">Form</div>
            ${existing
              ? html`<div class="form-link"><span class="grow small">${formFor(existing).map((x) => sectionName(x)).join(' · ')}</span>${linkBtn(`${b}/tickets/types/${existing.id}/form`, 'Edit form', { size: 'sm', icon: 'clipboard-list' })}</div>`
              : html`<div class="hint">You can change the questions members answer after creating the type.</div>`}</div>
          <label class="check"><input type="checkbox" name="enabled" value="1" ${values.enabled !== false ? raw('checked') : ''}> Show this type on the panel</label>
        </div></div>
        <div class="card-f"><span></span><div class="end">${linkBtn(`${b}/tickets/types`, 'Cancel')}${submitBtn(existing ? 'Save changes' : 'Create type', { variant: 'primary', loading: 'Saving…' })}</div></div>
      </form>`;
    return web.render(reply, ctx, title, 'tickets', body);
  }

  app.get('/w/:wid/tickets/types/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    return renderForm(ctx, reply, null, { enabled: true });
  });

  app.get('/w/:wid/tickets/types/:tid/edit', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const existing = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!existing) return reply.callNotFound();
    return renderForm(ctx, reply, existing, existing);
  });

  async function save(req: FastifyRequest, reply: FastifyReply, id: string | null) {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const existing = id ? await getTicketType(deps.db, ctx.workspace.id, id) : null;
    if (id && !existing) return reply.callNotFound();
    const parsed = typeSchema.safeParse(req.body);
    const raw = (req.body ?? {}) as Record<string, string>;
    const values: Partial<TicketTypeInput> = { ...raw, enabled: raw.enabled !== undefined };
    if (!parsed.success) return renderForm(ctx, reply.code(400), existing, values, parsed.error.issues.map((i) => i.message));
    // Guidance and placeholder are edited in the form builder now; keep what's stored.
    const input = { ...toInput(parsed.data), guidance: existing?.guidance ?? null, placeholder: existing?.placeholder ?? null };
    try {
      if (existing) await updateTicketType(deps.db, ctx.workspace.id, existing.id, input);
      else await createTicketType(deps.db, ctx.workspace.id, input);
    } catch (err) {
      if (err instanceof UserFacingError) return renderForm(ctx, reply.code(400), existing, values, [err.message]);
      throw err;
    }
    setFlash(reply, 'success', `${existing ? 'Saved' : 'Created'} “${parsed.data.name}”. ${UPDATE_PANEL}`);
    return reply.redirect(typesUrl(ctx));
  }

  app.post('/w/:wid/tickets/types', (req, reply) => save(req, reply, null));
  app.post('/w/:wid/tickets/types/:tid', (req, reply) => save(req, reply, (req.params as { tid: string }).tid));

  /** Shows or hides a type. With `set=1` the switch state is sent explicitly; otherwise it flips. */
  app.post('/w/:wid/tickets/types/:tid/toggle', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    const body = (req.body ?? {}) as { set?: string; enabled?: string };
    const enabled = body.set === '1' ? body.enabled !== undefined : !t.enabled;
    await updateTicketType(deps.db, ctx.workspace.id, t.id, { ...t, enabled });
    const message = `“${t.name}” ${enabled ? 'shown on' : 'hidden from'} the panel. ${UPDATE_PANEL}`;
    if (web.wantsJson(req)) return reply.send({ ok: true, message });
    setFlash(reply, 'success', message);
    return reply.redirect(typesUrl(ctx));
  });

  app.post('/w/:wid/tickets/types/:tid/move', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const direction = (req.body as { direction?: string }).direction === 'up' ? 'up' : 'down';
    await moveTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid, direction);
    return reply.redirect(typesUrl(ctx));
  });

  app.post('/w/:wid/tickets/types/:tid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    await deleteTicketType(deps.db, ctx.workspace.id, t.id);
    setFlash(reply, 'success', `Deleted “${t.name}”. ${UPDATE_PANEL}`);
    return reply.redirect(typesUrl(ctx));
  });

  // ---- Form builder ------------------------------------------------------------------------------

  async function renderBuilder(ctx: WorkspaceRequestContext, reply: FastifyReply, t: TicketType, sections: FormSection[], errors: string[] = []) {
    const b = ctx.base;
    const apps = (await listApps(deps.db, ctx.workspace.id)).filter((a) => a.enabled);
    const sample = apps[0] ? { name: apps[0].name, repoPrivate: apps[0].repo_private } : { name: 'Your app', repoPrivate: false };
    const custom = Boolean(t.form);
    const addButtons: { kind: SectionKind; label: string; icon: IconName }[] = [
      { kind: 'short', label: 'Short answer', icon: 'text-cursor-input' },
      { kind: 'paragraph', label: 'Paragraph', icon: 'align-left' },
      { kind: 'files', label: 'File upload', icon: 'paperclip' },
      { kind: 'intro', label: 'Intro text', icon: 'text' },
    ];
    const body = html`
      ${pageHeader({
        crumbs: [{ href: `${b}/tickets`, label: 'Tickets' }, { href: `${b}/tickets/types`, label: 'Ticket types' }, { label: t.name }],
        title: `${t.name} form`,
        after: custom ? tag('Customized') : tag('Default'),
        description: `What members fill in after choosing “${t.name}”. A Discord form holds up to ${FORM_MAX_SECTIONS} sections.`,
        actions: custom
          ? menu([{ post: `${b}/tickets/types/${t.id}/form/reset`, label: 'Restore the default form', icon: 'undo-2', confirm: { title: 'Restore the default form?', body: 'Your questions are replaced by the default form for this kind of ticket. Members see it the next time they open the form.', label: 'Restore default' } }], { csrf: ctx.csrf, size: 'md' })
          : undefined,
      })}
      ${errors.length ? notice('danger', 'The form wasn’t saved', html`<ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>`) : ''}
      <div class="panel-grid">
        <form method="post" action="${b}/tickets/types/${t.id}/form" class="card" id="form-builder" data-dirty>
          ${csrfField(ctx.csrf)}
          <div class="card-h"><div><h2>Sections</h2><div class="desc">Members see them in this order. Every ticket has a title and a description; the rest is up to you.</div></div>
            <div class="slots"><span class="pips" aria-hidden="true">${Array.from({ length: FORM_MAX_SECTIONS }, (_, i) => html`<span class="pip${i < sections.length ? ' on' : ''}"></span>`)}</span><span class="small nowrap" data-slot-text>${String(sections.length)} of ${String(FORM_MAX_SECTIONS)} used</span></div></div>
          <ol class="fsecs" id="fsecs">${sections.map((x) => sectionEditor(x))}</ol>
          <div class="fadd js-only">
            <span class="small muted">Add a section</span>
            <div class="row">${addButtons.map((a) => btn(a.label, { size: 'sm', icon: a.icon, attrs: html`data-fb-add="${a.kind}"` }))}</div>
            <p class="small muted" data-fb-full hidden>The form is full. Remove a section to add another.</p>
          </div>
          <div class="card-f"><span class="small muted">Saved forms apply the next time a member opens one. The panel doesn’t need updating.</span>
            <div class="end">${linkBtn(`${b}/tickets/types`, 'Cancel')}${submitBtn('Save form', { variant: 'primary', loading: 'Saving…' })}</div></div>
          ${addButtons.map((a) => html`<template data-fb-template="${a.kind}">${sectionEditor(blank(a.kind))}</template>`)}
        </form>
        <div class="panel-preview">
          ${previewCaption(null, null, 'Form · ')}
          ${formPreview(sample, { name: t.name }, sections, { id: 'form-preview' })}
          <p class="dp-note">On GitHub, each answer appears under its question below the description, and files appear in an Attachments section of the issue.</p>
        </div>
      </div>`;
    return web.render(reply, ctx, `${t.name} form`, 'tickets', body);
  }

  app.get('/w/:wid/tickets/types/:tid/form', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    return renderBuilder(ctx, reply, t, formFor(t));
  });

  app.post('/w/:wid/tickets/types/:tid/form', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    const sections = parseSections((req.body ?? {}) as Record<string, unknown>);
    if (!sections) return renderBuilder(ctx, reply.code(400), t, formFor(t), ['The form couldn’t be read. Reload the page and try again.']);
    const errors = validateForm(sections);
    if (errors.length) return renderBuilder(ctx, reply.code(400), t, sections, errors);
    await saveTicketTypeForm(deps.db, ctx.workspace.id, t.id, sections);
    setFlash(reply, 'success', `Saved the “${t.name}” form. Members see it the next time they open it.`);
    return reply.redirect(`${ctx.base}/tickets/types/${t.id}/form`);
  });

  app.post('/w/:wid/tickets/types/:tid/form/reset', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    await saveTicketTypeForm(deps.db, ctx.workspace.id, t.id, null);
    setFlash(reply, 'success', `Restored the default “${t.name}” form.`);
    return reply.redirect(`${ctx.base}/tickets/types/${t.id}/form`);
  });

  /** Creates missing type labels in the apps' repositories — only when an admin clicks it. */
  app.post('/w/:wid/tickets/types/create-labels', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!gh || !deps.github) {
      setFlash(reply, 'error', 'Connect GitHub first.');
      return reply.redirect(typesUrl(ctx));
    }
    try {
      const types = await listTicketTypes(deps.db, ctx.workspace.id);
      const gaps = await findMissingTypeLabels(deps.github, gh.installation_id, types, distinctRepos(await listApps(deps.db, ctx.workspace.id)));
      let created = 0;
      for (const gap of gaps) {
        for (const repo of gap.repos) {
          if (await deps.github.createLabel(gh.installation_id, repo.owner, repo.name, gap.label, labelColor(gap.label))) created++;
        }
      }
      setFlash(reply, 'success', created ? `Created ${created} label${created === 1 ? '' : 's'} on GitHub` : 'All labels already exist');
    } catch {
      setFlash(reply, 'error', 'GitHub didn’t let the app create the labels. It needs “Issues: Read and write” on those repositories.');
    }
    return reply.redirect(typesUrl(ctx));
  });
}

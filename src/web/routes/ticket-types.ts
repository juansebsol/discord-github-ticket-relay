import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getInstallationRepos } from '../../domain/repos.js';
import { getGitHubConnection, listApps } from '../../domain/store.js';
import {
  createTicketType,
  deleteTicketType,
  distinctRepos,
  findMissingTypeLabels,
  getTicketType,
  labelColor,
  listTicketTypes,
  moveTicketType,
  updateTicketType,
  type TicketType,
  type TicketTypeInput,
} from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { DEFAULT_GUIDANCE } from '../../discord/messages.js';
import { html, raw } from '../../lib/html.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, empty, icon, iconBtn, labelTag, linkBtn, menu, notice, pageHeader, postBtn, submitBtn, switchInput, typeIcon } from '../ui.js';
import { textField } from './panel.js';
import { ticketsHeader } from './tickets.js';

const typeSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Keep the name under 80 characters.'),
  description: z.string().trim().max(100, 'Keep the description under 100 characters (Discord’s limit).').optional().default(''),
  label: z.string().trim().max(50, 'GitHub labels are at most 50 characters.').optional().default(''),
  title_prefix: z.string().trim().max(30, 'Keep the title prefix under 30 characters.').optional().default(''),
  guidance: z.string().trim().max(500, 'Keep the guidance under 500 characters.').optional().default(''),
  placeholder: z.string().trim().max(100, 'Keep the placeholder under 100 characters (Discord’s limit).').optional().default(''),
  enabled: z.string().optional(),
});

function toInput(d: z.infer<typeof typeSchema>): TicketTypeInput {
  return {
    name: d.name,
    description: d.description || null,
    label: d.label || null,
    title_prefix: d.title_prefix || null,
    guidance: d.guidance || null,
    placeholder: d.placeholder || null,
    enabled: d.enabled !== undefined,
  };
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
                <thead><tr><th>Type</th><th>GitHub label</th><th>Title prefix</th><th class="center">Enabled</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${types.map((t, i) => html`<tr class="${t.enabled ? '' : 'off'}">
                  <td><div class="who-cell">${icon(typeIcon(t), 16, 'muted')}<div><div class="cell-title">${t.name}</div>${t.description ? html`<div class="sub">${t.description}</div>` : ''}</div></div></td>
                  <td>${t.label ? labelTag(t.label) : html`<span class="em">—</span>`}</td>
                  <td><code>[${t.title_prefix || t.name}]</code></td>
                  <td class="center"><form method="post" action="${b}/tickets/types/${t.id}/toggle" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
                    ${switchInput({ name: 'enabled', checked: t.enabled, label: `${t.name} enabled` })}<button type="submit" class="btn sm nojs">Save</button></form></td>
                  <td class="actions"><div class="row">
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
          ${textField({ id: 'guidance', label: 'Form guidance (optional)', value: v('guidance'), max: 500, rows: 3, placeholder: DEFAULT_GUIDANCE, hint: 'Shown at the top of the form. For features, for example: “What problem would this solve? Who would use it?”' })}
          <div class="field"><label for="placeholder">Description placeholder <span class="opt">(optional)</span></label><input id="placeholder" type="text" name="placeholder" value="${v('placeholder')}" maxlength="100" placeholder="1. Go to…  2. Click…  Expected: …  Actual: …"></div>
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
    try {
      if (existing) await updateTicketType(deps.db, ctx.workspace.id, existing.id, toInput(parsed.data));
      else await createTicketType(deps.db, ctx.workspace.id, toInput(parsed.data));
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

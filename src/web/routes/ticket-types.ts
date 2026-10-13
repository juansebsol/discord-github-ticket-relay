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
import { UserFacingError, type Deps } from '../../domain/types.js';
import { DEFAULT_GUIDANCE } from '../../discord/messages.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { alert, badge, button, csrfField, pageHead, postButton } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';

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

/** The "Ticket types" card on the Validate & publish page. */
export async function ticketTypesCard(deps: Deps, ctx: WorkspaceRequestContext): Promise<SafeHtml> {
  const b = ctx.base;
  const types = await listTicketTypes(deps.db, ctx.workspace.id);
  let gaps: Awaited<ReturnType<typeof findMissingTypeLabels>> = [];
  let gapError = '';
  const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
  if (types.some((t) => t.enabled && t.label) && gh && deps.github) {
    try {
      gaps = await findMissingTypeLabels(deps.github, gh.installation_id, types, distinctRepos(await listApps(deps.db, ctx.workspace.id)));
    } catch {
      gapError = 'Could not check the labels on GitHub right now.';
    }
  }
  return html`<div class="card" id="ticket-types">
    <div class="card-head"><h2>Ticket types</h2><a class="btn sm" href="${b}/ticket-types/new">+ Add ticket type</a></div>
    <p class="small muted">Members pick a type after choosing the app (required when types exist). Members see the name; the GitHub label and the title prefix are added to the issue, e.g. <code>[Bug] [Mobile App] Export fails</code>. With no types, the form works as before.</p>
    ${types.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>Order</th><th>Type (shown to members)</th><th>GitHub label</th><th>Title prefix</th><th>Status</th><th></th></tr></thead>
          <tbody>${types.map((t, i) => html`<tr class="${t.enabled ? '' : 'disabled'}">
            <td class="nowrap">
              ${postButton(`${b}/ticket-types/${t.id}/move`, '↑', ctx.csrf, { variant: 'sm', fields: { direction: 'up' }, disabled: i === 0 })}
              ${postButton(`${b}/ticket-types/${t.id}/move`, '↓', ctx.csrf, { variant: 'sm', fields: { direction: 'down' }, disabled: i === types.length - 1 })}
            </td>
            <td><strong>${t.name}</strong>${t.description ? html`<div class="sub">${t.description}</div>` : ''}</td>
            <td>${t.label ? html`<span class="badge plain">${t.label}</span>` : html`<span class="muted">—</span>`}</td>
            <td class="mono small">[${t.title_prefix || t.name}]</td>
            <td>${t.enabled ? badge('Enabled', 'ok') : badge('Disabled', '')}</td>
            <td class="nowrap">
              <a class="btn sm" href="${b}/ticket-types/${t.id}/edit">Edit</a>
              ${postButton(`${b}/ticket-types/${t.id}/toggle`, t.enabled ? 'Disable' : 'Enable', ctx.csrf, { variant: 'sm' })}
              ${postButton(`${b}/ticket-types/${t.id}/delete`, 'Remove', ctx.csrf, { variant: 'sm danger', confirm: `Remove the “${t.name}” ticket type? Tickets already filed keep their label.` })}
            </td></tr>`)}
          </tbody></table></div>`
      : html`<div class="empty"><h3>No ticket types</h3><p>Add types like “Bug report” or “Feature request” so maintainers can tell tickets apart.</p></div>`}
    ${gapError ? alert('warn', gapError) : ''}
    ${gaps.length
      ? alert('warn', html`<p><strong>Some type labels don’t exist yet.</strong> Tickets are filed without a missing label until it exists.</p>
          <ul>${gaps.map((g) => html`<li><code>${g.label}</code> is missing in ${g.repos.map((r) => `${r.owner}/${r.name}`).join(', ')}</li>`)}</ul>
          ${postButton(`${b}/ticket-types/create-labels`, 'Create missing labels', ctx.csrf, { variant: 'primary sm', loading: 'Creating…', confirm: 'Create the missing labels in these GitHub repositories?' })}`)
      : ''}
    ${types.length ? html`<p class="small muted">After changing types, click <strong>Update panel</strong> above so the panel’s steps match.</p>` : ''}
  </div>`;
}

export function registerTicketTypeRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  async function renderForm(ctx: WorkspaceRequestContext, reply: FastifyReply, existing: TicketType | null, values: Partial<TicketTypeInput>, errors: string[] = []) {
    const b = ctx.base;
    const title = existing ? `Edit ${existing.name}` : 'Add a ticket type';
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
      ${pageHead(title, 'Members see the name and description. The GitHub label and title prefix are added to the issue.')}
      ${errors.length ? alert('error', html`<p><strong>Please fix the following:</strong></p><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>`) : ''}
      <form method="post" action="${existing ? `${b}/ticket-types/${existing.id}` : `${b}/ticket-types`}" class="card">
        ${csrfField(ctx.csrf)}
        <div class="grid grid-2">
          <div class="field"><label for="name">Name</label><input id="name" type="text" name="name" value="${v('name')}" required maxlength="80" placeholder="e.g. Bug report"><div class="hint">Shown in the type dropdown in Discord.</div></div>
          <div class="field"><label for="description">Short description <span class="muted">(optional)</span></label><input id="description" type="text" name="description" value="${v('description')}" maxlength="100" placeholder="e.g. Something isn’t working"></div>
          <div class="field"><label for="label">GitHub label <span class="muted">(optional)</span></label><input id="label" type="text" name="label" value="${v('label')}" maxlength="50" list="label-suggestions" placeholder="e.g. bug" autocomplete="off">
            <datalist id="label-suggestions">${suggestions.map((l) => html`<option value="${l}"></option>`)}</datalist>
            <div class="hint">Added to the issue together with the app’s labels. Pick an existing label or type a new one (you can create it from the Ticket types card).</div></div>
          <div class="field"><label for="title_prefix">Title prefix <span class="muted">(optional)</span></label><input id="title_prefix" type="text" name="title_prefix" value="${v('title_prefix')}" maxlength="30" placeholder="Defaults to the name"><div class="hint">E.g. <code>Bug</code> → <code>[Bug] [Mobile App] Export fails</code>.</div></div>
        </div>
        <div class="field"><label for="guidance">Form guidance <span class="muted">(optional)</span></label><textarea id="guidance" name="guidance" maxlength="500" rows="3" placeholder="${DEFAULT_GUIDANCE}">${v('guidance')}</textarea><div class="hint">Shown at the top of the form. E.g. for features: “What problem would this solve? Who would use it?”</div></div>
        <div class="field"><label for="placeholder">Description placeholder <span class="muted">(optional)</span></label><input id="placeholder" type="text" name="placeholder" value="${v('placeholder')}" maxlength="100" placeholder="1. Go to…  2. Click…  Expected: …  Actual: …"></div>
        <div class="field"><label class="checkbox"><input type="checkbox" name="enabled" value="1" ${values.enabled !== false ? raw('checked') : ''}> Enabled</label></div>
        <div class="row">${button(existing ? 'Save changes' : 'Add ticket type', { variant: 'primary', loading: 'Saving…' })}<a class="btn" href="${b}/panel#ticket-types">Cancel</a></div>
      </form>`;
    return web.render(reply, ctx, title, 'panel', body);
  }

  app.get('/w/:wid/ticket-types/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    return renderForm(ctx, reply, null, { enabled: true });
  });

  app.get('/w/:wid/ticket-types/:tid/edit', async (req, reply) => {
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
    setFlash(reply, 'success', `${existing ? 'Saved' : 'Added'} “${parsed.data.name}”. Click Update panel so the panel matches.`);
    return reply.redirect(`${ctx.base}/panel#ticket-types`);
  }

  app.post('/w/:wid/ticket-types', (req, reply) => save(req, reply, null));
  app.post('/w/:wid/ticket-types/:tid', (req, reply) => save(req, reply, (req.params as { tid: string }).tid));

  app.post('/w/:wid/ticket-types/:tid/toggle', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    await updateTicketType(deps.db, ctx.workspace.id, t.id, { ...t, enabled: !t.enabled });
    setFlash(reply, 'success', `“${t.name}” ${t.enabled ? 'disabled' : 'enabled'}.`);
    return reply.redirect(`${ctx.base}/panel#ticket-types`);
  });

  app.post('/w/:wid/ticket-types/:tid/move', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const direction = (req.body as { direction?: string }).direction === 'up' ? 'up' : 'down';
    await moveTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid, direction);
    return reply.redirect(`${ctx.base}/panel#ticket-types`);
  });

  app.post('/w/:wid/ticket-types/:tid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const t = await getTicketType(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    if (!t) return reply.callNotFound();
    await deleteTicketType(deps.db, ctx.workspace.id, t.id);
    setFlash(reply, 'success', `Removed “${t.name}”.`);
    return reply.redirect(`${ctx.base}/panel#ticket-types`);
  });

  /** Creates missing type labels in the apps' repositories — only when an admin clicks it. */
  app.post('/w/:wid/ticket-types/create-labels', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const back = `${ctx.base}/panel#ticket-types`;
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!gh || !deps.github) {
      setFlash(reply, 'error', 'Connect GitHub first.');
      return reply.redirect(back);
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
      setFlash(reply, 'success', created ? `Created ${created} label${created === 1 ? '' : 's'} on GitHub.` : 'All labels already exist.');
    } catch {
      setFlash(reply, 'error', 'GitHub did not let the app create the labels. It needs “Issues: Read and write” on those repositories.');
    }
    return reply.redirect(back);
  });
}

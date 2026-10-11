import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RepoInfo } from '../../github/client.js';
import { getInstallationRepos } from '../../domain/repos.js';
import { checkPanel } from '../../domain/panel.js';
import { createApp, deleteApp, getApp, getGitHubConnection, listApps, moveApp, setAppEnabled, updateApp } from '../../domain/store.js';
import { UserFacingError, type AppRow, type Deps } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { alert, badge, button, csrfField, pageHead, postButton } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';

const appSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Keep the name under 80 characters.'),
  description: z.string().trim().max(100, 'Keep the description under 100 characters (Discord’s limit).').optional().default(''),
  repo_id: z.coerce.number().int().positive('Choose a repository.'),
  labels: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  enabled: z.string().optional(),
});

interface FormValues {
  name: string;
  description: string;
  repoId: number | null;
  labels: string[];
  enabled: boolean;
}

/**
 * Validates an app against what the GitHub installation can actually access. This is the
 * server-side repository allowlist: a repository outside the installation can never be saved.
 */
async function validateAppInput(deps: Deps, installationId: number, body: unknown): Promise<{ values: FormValues; errors: string[]; repo?: RepoInfo }> {
  const parsed = appSchema.safeParse(body);
  const raw = (body ?? {}) as Record<string, unknown>;
  const values: FormValues = {
    name: String(raw.name ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    repoId: Number(raw.repo_id) || null,
    labels: parsed.success ? parsed.data.labels : [],
    enabled: raw.enabled !== undefined,
  };
  if (!parsed.success) return { values, errors: parsed.error.issues.map((i) => i.message) };
  const errors: string[] = [];
  const repos = await getInstallationRepos(deps, installationId, { fresh: true });
  const repo = repos.find((r) => r.id === parsed.data.repo_id);
  if (!repo) return { values, errors: ['Choose a repository the GitHub App can access.'] };
  if (repo.archived) errors.push(`${repo.fullName} is archived and can’t receive issues.`);
  if (!repo.hasIssues) errors.push(`Issues are disabled in ${repo.fullName}. Enable them in the repository settings first.`);
  const labels = [...new Set(parsed.data.labels.map((l) => l.trim()).filter(Boolean))];
  if (labels.length > 10) errors.push('Choose at most 10 labels.');
  if (labels.length) {
    const existing = new Set(await deps.github!.listLabels(installationId, repo.owner, repo.name));
    const unknown = labels.filter((l) => !existing.has(l));
    if (unknown.length) errors.push(`These labels don’t exist in ${repo.fullName}: ${unknown.join(', ')}.`);
  }
  values.labels = labels;
  return { values, errors, repo };
}

export function registerAppRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/apps', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const apps = await listApps(deps.db, ctx.workspace.id);
    const panel = await checkPanel(deps, ctx.workspace.id, { live: false });
    const b = ctx.base;
    const repoUse = new Map<number, number>();
    for (const a of apps) repoUse.set(a.repo_id, (repoUse.get(a.repo_id) ?? 0) + 1);

    const body = html`
      ${pageHead('Step 3 · Apps', 'The apps members can pick in the ticket panel. Each app files its tickets in one GitHub repository; several apps can share a repository.', html`<a class="btn primary" href="${b}/apps/new">Add app</a>`)}
      ${panel.state === 'published' && panel.outdated ? alert('info', html`<p>The panel in Discord doesn’t show your latest changes yet. <a href="${b}/panel">Update the panel</a>.</p>`) : ''}
      <div class="card">
        ${apps.length === 0
          ? html`<div class="empty"><h3>No apps yet</h3><p>Add the first app people can file tickets for, for example “Mobile app” or “Billing portal”.</p><a class="btn primary" href="${b}/apps/new">Add your first app</a></div>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Order</th><th>App (shown to members)</th><th>Files issues in</th><th>Labels</th><th>Status</th><th></th></tr></thead>
              <tbody>${apps.map((a, i) => html`<tr class="${a.enabled ? '' : 'disabled'}">
                <td class="nowrap">
                  ${postButton(`${b}/apps/${a.id}/move`, '↑', ctx.csrf, { variant: 'sm', fields: { direction: 'up' }, disabled: i === 0 })}
                  ${postButton(`${b}/apps/${a.id}/move`, '↓', ctx.csrf, { variant: 'sm', fields: { direction: 'down' }, disabled: i === apps.length - 1 })}
                </td>
                <td><strong>${a.name}</strong>${a.description ? html`<div class="sub">${a.description}</div>` : ''}</td>
                <td><span class="mono">${a.repo_owner}/${a.repo_name}</span> ${a.repo_private ? badge('Private', 'plain') : badge('Public', 'warn')}${repoUse.get(a.repo_id)! > 1 ? html`<div class="sub">Shared with ${repoUse.get(a.repo_id)! - 1} other app${repoUse.get(a.repo_id)! > 2 ? 's' : ''}</div>` : ''}</td>
                <td>${a.labels.length ? a.labels.map((l) => html`<span class="badge plain">${l}</span> `) : html`<span class="muted">—</span>`}</td>
                <td>${a.enabled ? badge('Enabled', 'ok') : badge('Disabled', '')}</td>
                <td class="nowrap">
                  <a class="btn sm" href="${b}/apps/${a.id}/edit">Edit</a>
                  ${postButton(`${b}/apps/${a.id}/toggle`, a.enabled ? 'Disable' : 'Enable', ctx.csrf, { variant: 'sm' })}
                  ${postButton(`${b}/apps/${a.id}/delete`, 'Remove', ctx.csrf, { variant: 'sm danger', confirm: `Remove “${a.name}”? Members won’t be able to pick it after you update the panel. Past submissions are kept.` })}
                </td></tr>`)}
              </tbody></table></div>
              <p class="small muted">Disabled apps are hidden from the panel. If there are more than 25 enabled apps, the panel shows the first 24 and a “More apps…” option that opens a page-by-page list.</p>`}
      </div>`;
    return web.render(reply, ctx, 'Apps', 'apps', body);
  });

  async function renderForm(ctx: WorkspaceRequestContext, reply: FastifyReply, existing: AppRow | null, values: FormValues, errors: string[] = []) {
    const b = ctx.base;
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    const title = existing ? `Edit ${existing.name}` : 'Add an app';
    if (!gh || !deps.github) {
      return web.render(reply, ctx, title, 'apps', html`${pageHead(title)}${alert('warn', html`<p>Connect GitHub first so you can choose a repository. <a href="${b}/setup/github">Connect GitHub</a></p>`)}`);
    }
    let repos: RepoInfo[] = [];
    let repoError = '';
    try {
      repos = await getInstallationRepos(deps, gh.installation_id);
    } catch {
      repoError = 'Could not load repositories from GitHub. Reload the page to try again.';
    }
    const action = existing ? `${b}/apps/${existing.id}` : `${b}/apps`;
    const body = html`
      ${pageHead(title, 'Members only see the name and description. The repository stays behind the scenes.')}
      ${errors.length ? alert('error', html`<p><strong>Please fix the following:</strong></p><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>`) : ''}
      ${repoError ? alert('error', repoError) : ''}
      <form method="post" action="${action}" class="card">
        ${csrfField(ctx.csrf)}
        <div class="field"><label for="name">Name</label><input id="name" type="text" name="name" value="${values.name}" required maxlength="80" placeholder="e.g. Mobile app"><div class="hint">Shown in the app picker in Discord.</div></div>
        <div class="field"><label for="description">Short description <span class="muted">(optional)</span></label><input id="description" type="text" name="description" value="${values.description}" maxlength="100" placeholder="e.g. iOS and Android app"><div class="hint">Helps members pick the right app. Up to 100 characters.</div></div>
        <div class="field"><label for="repo">GitHub repository</label>
          <select id="repo" name="repo_id" required>
            <option value="">Choose a repository…</option>
            ${repos.map((r) => {
              const unusable = r.archived ? ' — archived' : !r.hasIssues ? ' — Issues disabled' : '';
              return html`<option value="${String(r.id)}" data-private="${String(r.private)}" ${values.repoId === r.id ? raw('selected') : ''} ${unusable ? raw('disabled') : ''}>${r.fullName}${r.private ? ' (private)' : ' (public)'}${unusable}</option>`;
            })}
          </select>
          <div class="hint" id="repo-visibility"></div>
          ${repos.length === 0 && !repoError ? html`<div class="hint">No repositories are shared with the GitHub App yet. <a href="${b}/setup/github">Manage repository access</a>.</div>` : ''}
        </div>
        <div class="field"><span class="label-text"><strong>Labels</strong> <span class="muted">(optional)</span></span>
          <div class="hint">Existing labels from the repository to add to every ticket for this app.</div>
          <div class="label-list" id="label-list" data-endpoint="${b}/apps/labels" data-selected="${JSON.stringify(values.labels)}">
            ${values.labels.map((l) => html`<label class="checkbox"><input type="checkbox" name="labels" value="${l}" checked> ${l}</label>`)}
            ${values.labels.length ? '' : html`<span class="muted small">Choose a repository to see its labels.</span>`}
          </div>
        </div>
        <div class="field"><label class="checkbox"><input type="checkbox" name="enabled" value="1" ${values.enabled ? raw('checked') : ''}> Enabled (shown in the panel)</label></div>
        <div class="row">${button(existing ? 'Save changes' : 'Add app', { variant: 'primary', loading: 'Saving…' })}<a class="btn" href="${b}/apps">Cancel</a></div>
        ${existing ? html`<p class="small muted">Changing the repository only affects new tickets. Tickets already submitted keep going to the repository they were submitted for.</p>` : ''}
      </form>`;
    return web.render(reply, ctx, title, 'apps', body);
  }

  app.get('/w/:wid/apps/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    return renderForm(ctx, reply, null, { name: '', description: '', repoId: null, labels: [], enabled: true });
  });

  app.get('/w/:wid/apps/:appId/edit', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const existing = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!existing) return reply.callNotFound();
    return renderForm(ctx, reply, existing, { name: existing.name, description: existing.description ?? '', repoId: existing.repo_id, labels: existing.labels, enabled: existing.enabled });
  });

  async function save(req: FastifyRequest, reply: FastifyReply, appId: string | null) {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const existing = appId ? await getApp(deps.db, ctx.workspace.id, appId) : null;
    if (appId && !existing) return reply.callNotFound();
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!gh || !deps.github) return renderForm(ctx, reply, existing, { name: '', description: '', repoId: null, labels: [], enabled: true });
    let result;
    try {
      result = await validateAppInput(deps, gh.installation_id, req.body);
    } catch {
      return renderForm(ctx, reply.code(502), existing, { name: String((req.body as any)?.name ?? ''), description: '', repoId: null, labels: [], enabled: true }, ['Could not reach GitHub to check the repository. Try again.']);
    }
    if (result.errors.length || !result.repo) return renderForm(ctx, reply.code(400), existing, result.values, result.errors);
    const input = {
      name: result.values.name,
      description: result.values.description || null,
      repo: { id: result.repo.id, owner: result.repo.owner, name: result.repo.name, private: result.repo.private },
      labels: result.values.labels,
      enabled: result.values.enabled,
    };
    try {
      if (existing) await updateApp(deps.db, ctx.workspace.id, existing.id, input);
      else await createApp(deps.db, ctx.workspace.id, input);
    } catch (err) {
      if (err instanceof UserFacingError) return renderForm(ctx, reply.code(400), existing, result.values, [err.message]);
      throw err;
    }
    setFlash(reply, 'success', existing ? `Saved “${input.name}”.` : `Added “${input.name}”. Update the panel to show it in Discord.`);
    return reply.redirect(`${ctx.base}/apps`);
  }

  app.post('/w/:wid/apps', (req, reply) => save(req, reply, null));
  app.post('/w/:wid/apps/:appId', (req, reply) => save(req, reply, (req.params as { appId: string }).appId));

  app.post('/w/:wid/apps/:appId/toggle', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const existing = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!existing) return reply.callNotFound();
    await setAppEnabled(deps.db, ctx.workspace.id, existing.id, !existing.enabled);
    setFlash(reply, 'success', `${existing.name} ${existing.enabled ? 'disabled' : 'enabled'}. Update the panel to reflect this in Discord.`);
    return reply.redirect(`${ctx.base}/apps`);
  });

  app.post('/w/:wid/apps/:appId/move', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const direction = (req.body as { direction?: string }).direction === 'up' ? 'up' : 'down';
    await moveApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId, direction);
    return reply.redirect(`${ctx.base}/apps`);
  });

  app.post('/w/:wid/apps/:appId/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const existing = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!existing) return reply.callNotFound();
    await deleteApp(deps.db, ctx.workspace.id, existing.id);
    setFlash(reply, 'success', `Removed “${existing.name}”. Update the panel to remove it from Discord.`);
    return reply.redirect(`${ctx.base}/apps`);
  });

  /** JSON: labels of a repository, restricted to repositories the installation can access. */
  app.get('/w/:wid/apps/labels', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!gh || !deps.github) return reply.code(400).send({ error: 'Connect GitHub first.' });
    const repoId = Number((req.query as { repo?: string }).repo);
    try {
      const repo = (await getInstallationRepos(deps, gh.installation_id)).find((r) => r.id === repoId);
      if (!repo) return reply.code(404).send({ error: 'Repository not available.' });
      const labels = await deps.github.listLabels(gh.installation_id, repo.owner, repo.name);
      return { labels: labels.sort((x, y) => x.localeCompare(y)) };
    } catch {
      return reply.code(502).send({ error: 'Could not load labels from GitHub.' });
    }
  });
}

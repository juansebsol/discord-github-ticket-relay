import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RepoInfo } from '../../github/client.js';
import { getInstallationRepos } from '../../domain/repos.js';
import { checkPanel } from '../../domain/panel.js';
import { can } from '../../domain/permissions.js';
import { createApp, deleteApp, getApp, getGitHubConnection, listApps, moveApp, setAppEnabled, updateApp } from '../../domain/store.js';
import { UserFacingError, type AppRow, type Deps } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { isBlank, listKnowledge } from '../../triage/knowledge.js';
import { avatar, badge, csrfField, empty, formatDate, icon, iconBtn, labelTag, linkBtn, menu, notice, pageHeader, pill, plural, selectWrap, submitBtn, tag, timeAgo, viewOnlyTag } from '../ui.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { canOpen, knowledgeHref } from './tool.js';

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

/** How to get a change into Discord: update the panel, or ask an admin to (moderators can't open it). */
function panelStep(ctx: WorkspaceRequestContext, what: string): string {
  return can(ctx.membership, 'panel.edit') ? `Update the panel to ${what}.` : `Someone with Edit on the Panel needs to update it to ${what}.`;
}

export function registerAppRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/apps', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.view' });
    if (!ctx) return reply;
    const apps = await listApps(deps.db, ctx.workspace.id);
    const panel = await checkPanel(deps, ctx.workspace.id, { live: false });
    // Each app's TRIAGE.md (AI triage › Knowledge), for someone who can open it.
    const knowledge = canOpen(ctx.membership, 'triage.knowledge') ? await listKnowledge(deps.db, ctx.workspace.id) : null;
    // Repository health from the (cached) installation repository list, when GitHub is reachable.
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    const repoInfo = new Map<number, RepoInfo>();
    if (gh && gh.status === 'active' && deps.github) {
      try {
        for (const r of await getInstallationRepos(deps, gh.installation_id)) repoInfo.set(r.id, r);
      } catch {
        // Unknown health is shown as normal; the Panel tab runs the full checks.
      }
    }
    const ticketState = (a: AppRow) => {
      if (!a.enabled) return tag('Off');
      const r = repoInfo.get(a.repo_id);
      if (repoInfo.size && !r) return pill('No access', 'danger');
      if (r?.archived) return pill('Archived', 'warn');
      if (r && !r.hasIssues) return pill('Issues disabled', 'warn');
      return html`<span class="inline" aria-label="Files tickets" title="Files tickets">${icon('circle-check', 16, 'ok')}</span>`;
    };
    const b = ctx.base;
    const edit = can(ctx.membership, 'apps.edit');
    const repoUse = new Map<number, number>();
    for (const a of apps) repoUse.set(a.repo_id, (repoUse.get(a.repo_id) ?? 0) + 1);
    const addApp = edit ? linkBtn(`${b}/apps/new`, 'Add app', { variant: 'primary', icon: 'plus' }) : null;

    const body = html`
      ${pageHeader({
        eyebrow: 'Setup · Step 3 of 3',
        title: 'Apps & repositories',
        after: [apps.length ? badge(apps.length) : '', edit ? '' : viewOnlyTag('You can see the apps and their repositories. Ask an admin if you need to change them.')],
        description: 'The apps members pick in Discord, each mapped to a GitHub repository. Discord tickets and Contributor roles both use this list.',
        actions: addApp ?? undefined,
      })}
      ${panel.state === 'published' && panel.outdated
        ? notice('info', 'The ticket panel in Discord doesn’t show your latest changes yet', can(ctx.membership, 'panel.edit') ? 'Members still see the old list of apps.' : 'Members still see the old list of apps until someone updates the panel.', { action: can(ctx.membership, 'panel.edit') ? linkBtn(`${b}/tickets/panel`, 'Update panel', { size: 'sm' }) : undefined })
        : ''}
      <div class="card">
        ${apps.length === 0
          ? empty('boxes', 'No apps yet', edit ? 'Add the first app members can file tickets for, for example “Mobile app” or “Billing portal”.' : 'An admin can add the apps members file tickets for.', addApp)
          : html`<div class="card-b flush"><div class="table-wrap wide"><table>
              <thead><tr><th class="col-main">App</th><th>Repository</th><th class="center">Tickets</th><th class="center">Contributor roles</th><th>Extra labels</th>${knowledge ? html`<th title="What Claude knows about each app (AI triage › Knowledge)">TRIAGE.md</th>` : ''}${edit ? html`<th class="actions"><span class="sr-only">Actions</span></th>` : ''}</tr></thead>
              <tbody>${apps.map((a, i) => {
                const shared = repoUse.get(a.repo_id)! - 1;
                return html`<tr class="${a.enabled ? '' : 'off'}">
                  <td><span class="who-cell">${avatar(a.name, 28, { square: true, letters: 2 })}<span><span class="cell-title">${a.name}</span>${a.description ? html`<span class="sub">${a.description}</span>` : ''}</span></span></td>
                  <td><span class="inline nowrap">${icon('folder-git-2', 14, 'muted')}<span class="mono">${a.repo_owner}/${a.repo_name}</span>${tag(a.repo_private ? 'Private' : 'Public', { icon: a.repo_private ? 'lock' : 'globe' })}</span>${shared > 0 ? html`<div class="sub">Shared with ${plural(shared, 'other app')}</div>` : ''}</td>
                  <td class="center">${ticketState(a)}</td>
                  <td class="center">${a.contributor_enabled ? html`<span class="inline" aria-label="Counts for Contributor roles" title="Counts for Contributor roles">${icon('circle-check', 16, 'ok')}</span>` : html`<span class="em" aria-label="Not counted">—</span>`}</td>
                  <td>${a.labels.length ? html`<div class="tags">${a.labels.map((l) => labelTag(l))}</div>` : html`<span class="em">—</span>`}</td>
                  ${knowledge ? html`<td class="nowrap">${(() => {
                    const k = knowledge.get(a.id);
                    return k && !isBlank(k.body)
                      ? html`<a class="inline" href="${knowledgeHref(ctx, a.id)}">${icon('file-text', 14, 'muted')}<span>Updated <time datetime="${k.updated_at.toISOString()}" title="${formatDate(k.updated_at)}${k.updated_by_name ? ` by ${k.updated_by_name}` : ''}">${timeAgo(k.updated_at)}</time></span></a>`
                      : html`<a class="inline muted" href="${knowledgeHref(ctx, a.id)}">${icon('file-text', 14)}<span>${can(ctx.membership, 'triage.knowledge.edit') ? 'Write it' : 'Not written'}</span></a>`;
                  })()}</td>` : ''}
                  ${edit ? html`<td class="actions"><div class="row">
                    ${iconBtn('pencil', `Edit ${a.name}`, { size: 'sm', href: `${b}/apps/${a.id}/edit` })}
                    ${menu([
                      i > 0 ? { post: `${b}/apps/${a.id}/move`, label: 'Move up', icon: 'arrow-up', fields: { direction: 'up' } } : null,
                      i < apps.length - 1 ? { post: `${b}/apps/${a.id}/move`, label: 'Move down', icon: 'arrow-down', fields: { direction: 'down' } } : null,
                      { post: `${b}/apps/${a.id}/toggle`, label: a.enabled ? 'Hide from the panel' : 'Show on the panel', icon: a.enabled ? 'eye-off' : 'eye' },
                      'sep',
                      { post: `${b}/apps/${a.id}/delete`, label: 'Remove app…', icon: 'trash-2', danger: true, confirm: { title: `Remove “${a.name}”?`, body: 'Members can’t pick it after you update the panel. Past tickets are kept.', label: 'Remove app', danger: true } },
                    ], { csrf: ctx.csrf, label: `More actions for ${a.name}` })}
                  </div></td>` : ''}</tr>`;
              })}
              </tbody></table></div></div>
              <div class="card-note">Hidden apps don’t appear on the panel. With more than 25 apps, the panel shows 24 and a “More apps…” option that opens a page-by-page list.</div>`}
      </div>`;
    return web.render(reply, ctx, 'Apps & repositories', 'apps', body, { width: 'full' });
  });

  async function renderForm(ctx: WorkspaceRequestContext, reply: FastifyReply, existing: AppRow | null, values: FormValues, errors: string[] = []) {
    const b = ctx.base;
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    const title = existing ? `Edit ${existing.name}` : 'Add an app';
    const header = pageHeader({
      crumbs: [{ href: `${b}/apps`, label: 'Apps & repositories' }, { label: existing ? existing.name : 'New app' }],
      title,
      description: 'Members only see the name and description. The repository stays behind the scenes.',
    });
    if (!gh || !deps.github) {
      const admin = can(ctx.membership, 'manage');
      return web.render(reply, ctx, title, 'apps', html`${header}${notice('warn', 'Connect GitHub first', admin ? 'You need a connected GitHub account to choose a repository.' : 'An admin needs to connect GitHub before apps can be added.', { action: admin ? linkBtn(`${b}/setup/github`, 'Connect GitHub', { size: 'sm' }) : undefined })}`);
    }
    let repos: RepoInfo[] = [];
    let repoError = '';
    try {
      repos = await getInstallationRepos(deps, gh.installation_id);
    } catch {
      repoError = 'Couldn’t load repositories from GitHub. Reload the page to try again.';
    }
    const action = existing ? `${b}/apps/${existing.id}` : `${b}/apps`;
    const body = html`
      ${header}
      ${errors.length ? notice('danger', 'Please fix the following', html`<ul>${errors.map((e) => html`<li>${e}</li>`)}</ul>`) : ''}
      ${repoError ? notice('danger', null, repoError) : ''}
      <form method="post" action="${action}" class="card">
        ${csrfField(ctx.csrf)}
        <div class="card-b"><div class="fields">
          <div class="fields-2">
            <div class="field"><label for="name">Name</label><input id="name" type="text" name="name" value="${values.name}" required maxlength="80" placeholder="Mobile app"><div class="hint">Shown in the app menu in Discord.</div></div>
            <div class="field"><label for="description">Short description <span class="opt">(optional)</span></label><input id="description" type="text" name="description" value="${values.description}" maxlength="100" placeholder="iOS and Android"><div class="hint">Helps members pick the right app. Up to 100 characters.</div></div>
          </div>
          <div class="field"><label for="repo">GitHub repository</label>
            ${can(ctx.membership, 'manage') ? '' : html`<div class="hint">Repositories the GitHub App can access. Ask an admin if one is missing.</div>`}
            ${selectWrap(html`<select id="repo" name="repo_id" required>
              <option value="">Choose a repository…</option>
              ${repos.map((r) => {
                const unusable = r.archived ? ' · archived' : !r.hasIssues ? ' · Issues disabled' : '';
                return html`<option value="${String(r.id)}" data-private="${String(r.private)}" ${values.repoId === r.id ? raw('selected') : ''} ${unusable ? raw('disabled') : ''}>${r.fullName}${r.private ? ' (private)' : ' (public)'}${unusable}</option>`;
              })}
            </select>`)}
            <div class="hint" id="repo-visibility"></div>
            ${repos.length === 0 && !repoError ? html`<div class="hint">No repositories are shared with the GitHub App yet. ${can(ctx.membership, 'manage') ? html`<a href="${b}/setup/github">Manage repository access</a>.` : 'Ask an admin to share them in GitHub setup.'}</div>` : ''}
          </div>
          <div class="field"><span class="label">Labels <span class="opt">(optional)</span></span>
            <div class="hint">Existing labels from the repository, added to every ticket for this app.</div>
            <div class="check-list mt-8" id="label-list" data-endpoint="${b}/apps/labels" data-selected="${JSON.stringify(values.labels)}">
              ${values.labels.map((l) => html`<label class="check"><input type="checkbox" name="labels" value="${l}" checked><span class="mono">${l}</span></label>`)}
              ${values.labels.length ? '' : html`<span class="muted small">Choose a repository to see its labels.</span>`}
            </div>
          </div>
          <label class="check"><input type="checkbox" name="enabled" value="1" ${values.enabled ? raw('checked') : ''}> Show this app on the panel</label>
          ${existing ? html`<p class="small muted">Changing the repository only affects new tickets. Tickets already submitted stay with the repository they were filed for.</p>` : ''}
        </div></div>
        <div class="card-f"><span></span><div class="end">${linkBtn(`${b}/apps`, 'Cancel')}${submitBtn(existing ? 'Save changes' : 'Add app', { variant: 'primary', loading: 'Saving…' })}</div></div>
      </form>`;
    return web.render(reply, ctx, title, 'apps', body);
  }

  app.get('/w/:wid/apps/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
    if (!ctx) return reply;
    return renderForm(ctx, reply, null, { name: '', description: '', repoId: null, labels: [], enabled: true });
  });

  app.get('/w/:wid/apps/:appId/edit', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
    if (!ctx) return reply;
    const existing = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!existing) return reply.callNotFound();
    return renderForm(ctx, reply, existing, { name: existing.name, description: existing.description ?? '', repoId: existing.repo_id, labels: existing.labels, enabled: existing.enabled });
  });

  async function save(req: FastifyRequest, reply: FastifyReply, appId: string | null) {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
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
    setFlash(reply, 'success', existing ? `Saved “${input.name}”` : `Added “${input.name}”. ${panelStep(ctx, 'show it in Discord')}`);
    return reply.redirect(`${ctx.base}/apps`);
  }

  app.post('/w/:wid/apps', (req, reply) => save(req, reply, null));
  app.post('/w/:wid/apps/:appId', (req, reply) => save(req, reply, (req.params as { appId: string }).appId));

  app.post('/w/:wid/apps/:appId/toggle', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
    if (!ctx) return reply;
    const existing = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!existing) return reply.callNotFound();
    await setAppEnabled(deps.db, ctx.workspace.id, existing.id, !existing.enabled);
    setFlash(reply, 'success', `“${existing.name}” ${existing.enabled ? 'hidden from' : 'shown on'} the panel. ${panelStep(ctx, 'reflect this in Discord')}`);
    return reply.redirect(`${ctx.base}/apps`);
  });

  app.post('/w/:wid/apps/:appId/move', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
    if (!ctx) return reply;
    const direction = (req.body as { direction?: string }).direction === 'up' ? 'up' : 'down';
    await moveApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId, direction);
    return reply.redirect(`${ctx.base}/apps`);
  });

  app.post('/w/:wid/apps/:appId/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
    if (!ctx) return reply;
    const existing = await getApp(deps.db, ctx.workspace.id, (req.params as { appId: string }).appId);
    if (!existing) return reply.callNotFound();
    await deleteApp(deps.db, ctx.workspace.id, existing.id);
    setFlash(reply, 'success', `Removed “${existing.name}”. ${panelStep(ctx, 'remove it from Discord')}`);
    return reply.redirect(`${ctx.base}/apps`);
  });

  /** JSON: labels of a repository, restricted to repositories the installation can access. */
  app.get('/w/:wid/apps/labels', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'apps.edit' });
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

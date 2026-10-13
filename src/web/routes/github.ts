import type { FastifyInstance, FastifyReply } from 'fastify';
import { GitHubApiError, type InstallationInfo } from '../../github/client.js';
import { checkGitHubCredentials, explainGitHubAppError } from '../../domain/credentials.js';
import { completeVerification } from '../../domain/contributors.js';
import { consumeState, createState } from '../../domain/oauth-state.js';
import { clearRepoCache, getInstallationRepos } from '../../domain/repos.js';
import { deleteGitHubConnection, getGitHubConnection, listApps, saveGitHubConnection } from '../../domain/store.js';
import { getMembership } from '../../domain/workspaces.js';
import { can } from '../../domain/permissions.js';
import { escapeHtml, html, raw } from '../../lib/html.js';
import type { RepoInfo } from '../../github/client.js';
import { simplePage } from '../layout.js';
import { avatar, badge, choices, csrfField, empty, icon, linkBtn, menu, notice, pageHeader, pill, plural, postBtn, setting, submitBtn, tag, type IconName } from '../ui.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';

function installationSettingsUrl(conn: { account_login: string; account_type: string; installation_id: number }): string {
  return conn.account_type === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(conn.account_login)}/settings/installations/${conn.installation_id}`
    : `https://github.com/settings/installations/${conn.installation_id}`;
}

export function registerGitHubRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const callbackUrl = web.publicUrl('/oauth/github/callback');

  app.get('/w/:wid/setup/github', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const conn = await getGitHubConnection(deps.db, ctx.workspace.id);
    const b = ctx.base;

    let repos: RepoInfo[] | null = null;
    let repoError = '';
    const usedBy = new Map<number, string[]>();
    if (conn && deps.github) {
      try {
        repos = await getInstallationRepos(deps, conn.installation_id, { fresh: true });
        for (const a of await listApps(deps.db, ctx.workspace.id)) usedBy.set(a.repo_id, [...(usedBy.get(a.repo_id) ?? []), a.name]);
      } catch (err) {
        const removed = err instanceof GitHubApiError && (err.status === 404 || err.status === 401);
        repoError = removed ? 'GitHub says the app is no longer installed on this account. Reinstall it from the menu above.' : 'Couldn’t load repositories from GitHub right now. Reload to try again.';
      }
    }
    const credentials = deps.github && (!conn || conn.status !== 'active') ? await checkGitHubCredentials(deps) : null;
    const status = !conn
      ? pill('Not connected', 'neutral')
      : conn.status === 'active'
        ? pill('Connected', 'ok')
        : conn.status === 'suspended'
          ? pill('Suspended', 'warn')
          : pill(conn.status === 'removed' ? 'App uninstalled' : 'Problem', 'danger');
    const settingsUrl = conn ? installationSettingsUrl(conn) : '';

    const actions = conn
      ? [
          linkBtn(settingsUrl, 'Manage on GitHub', { trail: 'arrow-up-right', external: true }),
          menu([
            { post: `${b}/setup/github/install`, label: 'Reinstall or change account', icon: 'refresh-cw' },
            { post: `${b}/setup/github/link`, label: 'Link an existing installation', icon: 'link' },
            'sep',
            { post: `${b}/setup/github/disconnect`, label: 'Disconnect GitHub…', icon: 'unplug', danger: true, confirm: { title: 'Disconnect GitHub?', body: 'New tickets can’t be filed and contributor verification stops until you reconnect. Apps and history are kept.', label: 'Disconnect', danger: true } },
          ], { csrf: ctx.csrf, size: 'md' }),
        ]
      : [];

    const disabledRepos = (repos ?? []).filter((r) => !r.hasIssues && usedBy.has(r.id));
    const body = html`
      ${pageHeader({ eyebrow: 'General setup · Step 1 of 3', title: 'GitHub', after: status, description: 'The GitHub App files tickets as issues and reads contributions for Contributor Roles.', actions })}
      ${!deps.github ? notice('warn', 'The GitHub App isn’t registered for this deployment yet', 'Whoever runs the server needs to finish the deployment setup first.', { action: linkBtn(`${b}/deployment`, 'Open Deployment', { size: 'sm' }) }) : ''}
      ${credentials && !credentials.ok ? notice('danger', 'The server’s GitHub App credentials don’t work', html`${credentials.detail} Fix <code>.env</code> or <code>secrets/sec.pem</code> on the server, then run <code>pm2 restart all --update-env</code>.`) : ''}
      ${conn?.status_detail ? notice(conn.status === 'active' ? 'info' : 'danger', null, conn.status_detail) : ''}
      ${disabledRepos.map((r) => notice('warn', `Issues are disabled in ${r.fullName}`, `Tickets for ${usedBy.get(r.id)!.join(', ')} fail until Issues are turned on.`, { action: linkBtn(`${r.htmlUrl}/settings`, 'Open repository settings', { size: 'sm', trail: 'arrow-up-right', external: true }) }))}
      ${conn
        ? html`<div class="card">
            <div class="card-h"><div><h2>Installation</h2><div class="desc">Installed on ${conn.account_login} with access to ${conn.repository_selection === 'all' ? 'all' : 'selected'} repositories.</div></div></div>
            ${setting('Account', null, html`<span class="row">${avatar(conn.account_login, 32, { src: conn.account_avatar_url, square: true, letters: 2 })}<span class="name">${conn.account_login}</span>${tag(conn.account_type)}</span>`)}
            ${setting('Repository access', 'Only these repositories can be chosen for apps.', html`<span class="value">${conn.repository_selection === 'all' ? 'All repositories' : `Selected${repos ? ` · ${plural(repos.length, 'repository', 'repositories')}` : ''}`}</span>${linkBtn(settingsUrl, 'Change on GitHub', { variant: 'ghost', size: 'sm', trail: 'arrow-up-right', external: true })}`)}
            ${setting('Permissions', 'It never changes code.', html`<div class="tags">${tag('Issues: write')}${tag('Pull requests: read')}${tag('Contents: read')}</div>`)}
          </div>
          <div class="card">
            <div class="card-h"><h2>Repositories</h2>${repos ? badge(repos.length) : ''}</div>
            <div class="card-b flush">${repoError
              ? html`<div class="card-b">${notice('danger', null, repoError)}</div>`
              : repos && repos.length
                ? html`<div class="table-wrap"><table>
                    <thead><tr><th>Repository</th><th>Visibility</th><th>Issues</th><th>Used by</th></tr></thead>
                    <tbody>${repos.map((r) => html`<tr>
                      <td><a class="inline mono" href="${r.htmlUrl}" target="_blank" rel="noopener noreferrer">${icon('folder-git-2', 14, 'muted')}${r.fullName}</a>${r.archived ? html` ${tag('Archived')}` : ''}</td>
                      <td>${tag(r.private ? 'Private' : 'Public', { icon: r.private ? 'lock' : 'globe' })}</td>
                      <td>${r.hasIssues ? html`<span class="inline small">${icon('circle-check', 14, 'ok')}Enabled</span>` : pill('Disabled', 'warn')}</td>
                      <td class="small">${usedBy.get(r.id)?.join(', ') ?? html`<span class="em">—</span>`}</td></tr>`)}
                    </tbody></table></div>`
                : empty('folder-git-2', 'No repositories shared yet', 'Choose which repositories the app can access on GitHub, then reload this page.', linkBtn(settingsUrl, 'Choose on GitHub', { trail: 'arrow-up-right', external: true }))}</div>
          </div>`
        : html`<div class="card">
            <div class="card-h"><div><h2>Connect GitHub</h2><div class="desc">Install the app on the account or organization that owns your repositories.</div></div></div>
            <div class="card-b"><ol class="steps">
              <li><span>You’re sent to GitHub to install the app. Pick the account or organization that owns your repositories.</span></li>
              <li><span>Choose <strong>Only select repositories</strong> and pick the ones that should receive tickets. You can change this later.</span></li>
              <li><span>GitHub asks you to authorize the app. This only confirms you have access to the installation; your personal GitHub token isn’t kept.</span></li>
              <li><span>You come back here and see the connected account and its repositories.</span></li>
            </ol></div>
            ${setting('Permissions', 'Issues to create issues and read labels. Pull requests and Contents are read-only, for Contributor Roles. Installing on an organization may need an owner’s approval.', html`<div class="tags">${tag('Issues: write')}${tag('Pull requests: read')}${tag('Contents: read')}</div>`)}
            <div class="card-f"><span></span><div class="end">
              ${postBtn(`${b}/setup/github/link`, 'Link existing installation', ctx.csrf, { disabled: !deps.github })}
              ${postBtn(`${b}/setup/github/install`, 'Install the GitHub App', ctx.csrf, { variant: 'primary', icon: 'github', disabled: !deps.github })}
            </div></div>
          </div>`}`;
    return web.render(reply, ctx, 'GitHub', 'github', body);
  });

  app.post('/w/:wid/setup/github/install', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    if (!deps.github) return reply.redirect(`${ctx.base}/setup/github`);
    const state = await createState(deps.db, 'github_install', req.auth!.session.id, ctx.workspace.id, { mode: 'install' }, 30);
    return reply.redirect(deps.github.installUrl(state));
  });

  app.post('/w/:wid/setup/github/link', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    if (!deps.github) return reply.redirect(`${ctx.base}/setup/github`);
    const state = await createState(deps.db, 'github_install', req.auth!.session.id, ctx.workspace.id, { mode: 'link' }, 30);
    return reply.redirect(deps.github.authorizeUrl(state, callbackUrl));
  });

  app.post('/w/:wid/setup/github/disconnect', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const conn = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (conn) clearRepoCache(conn.installation_id);
    await deleteGitHubConnection(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'GitHub was disconnected. To fully remove access, uninstall the app in your GitHub settings too.');
    return reply.redirect(`${ctx.base}/setup/github`);
  });

  async function connectInstallation(reply: FastifyReply, workspaceId: string, userId: string, installationId: number) {
    let inst: InstallationInfo;
    try {
      inst = await deps.github!.getInstallation(installationId);
    } catch (err) {
      deps.log.warn({ installationId, status: (err as GitHubApiError).status, err: (err as Error).message }, 'could not load github installation');
      setFlash(reply, 'error', `The app was installed on GitHub, but this server could not connect to it. ${explainGitHubAppError(err)}`);
      return reply.redirect(`/w/${workspaceId}/setup/github`);
    }
    await saveGitHubConnection(deps.db, workspaceId, { ...inst, installationId: inst.id }, userId);
    clearRepoCache(installationId);
    setFlash(reply, 'success', `Connected to GitHub as ${inst.accountLogin}.${inst.suspended ? ' The installation is suspended; unsuspend it on GitHub.' : ''}`);
    return reply.redirect(`/w/${workspaceId}/setup/github`);
  }

  /**
   * GitHub redirects here after installation (with "Request user authorization during
   * installation" enabled) or after the link flow. The installation_id query parameter
   * can be spoofed, so we only accept installations the authorizing user can access.
   */
  app.get('/oauth/github/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; installation_id?: string; setup_action?: string; error?: string };
    const state = await consumeState(deps.db, q.state, ['github_install', 'contributor_verify']);
    if (state?.purpose === 'contributor_verify' && deps.github) {
      // A Discord member returning from GitHub sign-in on the contributor panel.
      const result = await completeVerification(deps, state, q.error ? undefined : q.code);
      const view = {
        verified: { icon: 'circle-check', tone: 'ok', title: `You are verified${result.roleName ? `: ${result.roleName}` : ''}` },
        not_contributor: { icon: 'info', tone: 'muted', title: 'Not enough contributions yet' },
        conflict: { icon: 'triangle-alert', tone: 'warn', title: 'Account already linked' },
        error: { icon: 'circle-x', tone: 'danger', title: 'Verification failed' },
      }[result.outcome] as { icon: IconName; tone: string; title: string };
      return reply.type('text/html').send(simplePage('Contributor verification', html`<div class="auth-result"><span class="circle">${icon(view.icon, 20, view.tone)}</span><h1>${view.title}</h1>
        <p class="muted">${raw(escapeHtml(result.explanation).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'))}</p>
        <p class="small muted">You can close this tab and return to Discord.</p></div>`));
    }
    if (!state || !deps.github) {
      return reply.type('text/html').send(simplePage('Finish connecting GitHub', html`<h1>Almost done</h1>
        <p class="muted">The app was installed on GitHub, but this link can’t be matched to a workspace. It may have expired, or the installation was started from GitHub directly.</p>
        <p class="muted">Open your workspace’s <strong>GitHub</strong> page and choose <strong>Link an existing installation</strong> from its menu.</p>${linkBtn('/', 'Go to the console', { variant: 'primary', block: true })}`));
    }
    const wid = state.workspace_id!;
    const back = `/w/${wid}/setup/github`;
    const ghMember = req.auth ? await getMembership(deps.db, req.auth.user.id, wid) : null;
    if (!req.auth || req.auth.session.id !== state.session_id || !ghMember || !can(ghMember, 'manage')) {
      return reply.redirect('/login');
    }
    if (q.setup_action === 'request') {
      setFlash(reply, 'info', 'Installation requested. An organization owner has to approve it on GitHub. After approval, come back and choose “Link an existing installation”.');
      return reply.redirect(back);
    }
    if (q.error || !q.code) {
      setFlash(reply, 'error', 'GitHub authorization was cancelled, so nothing was connected.');
      return reply.redirect(back);
    }

    let installations: InstallationInfo[];
    try {
      const userToken = await deps.github.exchangeOAuthCode(q.code, callbackUrl);
      installations = await deps.github.listUserInstallations(userToken);
    } catch (err) {
      deps.log.warn({ status: (err as GitHubApiError).status }, 'github authorization failed');
      setFlash(reply, 'error', 'GitHub authorization failed. Please try again.');
      return reply.redirect(back);
    }

    const requested = Number(q.installation_id);
    const match = installations.find((i) => i.id === requested);
    if (match) return connectInstallation(reply, wid, req.auth.user.id, match.id);
    if (q.installation_id) {
      setFlash(reply, 'error', 'Your GitHub account does not have access to that installation. Ask someone with access to connect it.');
      return reply.redirect(back);
    }
    if (installations.length === 0) {
      setFlash(reply, 'error', 'No installation of the GitHub App was found for your GitHub account. Install it first.');
      return reply.redirect(back);
    }
    if (installations.length === 1) return connectInstallation(reply, wid, req.auth.user.id, installations[0]!.id);

    // Several installations: let the admin pick one, restricted to the verified list.
    const pickState = await createState(deps.db, 'github_install', req.auth.session.id, wid, { mode: 'pick', allowed: installations.map((i) => i.id) }, 15);
    const body = html`
      <h1>Choose a GitHub account</h1>
      <p class="muted">The app is installed on several accounts you can access. Which one should this workspace use?</p>
      <form method="post" action="/oauth/github/choose" class="stack">${csrfField(req.auth.session.csrf_token)}
        <input type="hidden" name="state" value="${pickState}">
        ${choices('installation_id', installations.map((i) => ({ value: String(i.id), title: i.accountLogin, desc: i.accountType })), String(installations[0]!.id))}
        ${submitBtn('Connect', { variant: 'primary', block: true })}
      </form>`;
    return reply.type('text/html').send(simplePage('Choose account', body));
  });

  app.post('/oauth/github/choose', async (req, reply) => {
    const body = req.body as { state?: string; installation_id?: string };
    const state = await consumeState(deps.db, body.state, ['github_install']);
    if (!state || state.data.mode !== 'pick' || !req.auth || req.auth.session.id !== state.session_id || !deps.github) return reply.redirect('/');
    const wid = state.workspace_id!;
    const chooser = await getMembership(deps.db, req.auth.user.id, wid);
    if (!chooser || !can(chooser, 'manage')) return reply.redirect('/');
    const id = Number(body.installation_id);
    if (!(state.data.allowed as number[]).includes(id)) {
      setFlash(reply, 'error', 'That installation is not available to you.');
      return reply.redirect(`/w/${wid}/setup/github`);
    }
    return connectInstallation(reply, wid, req.auth.user.id, id);
  });
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import { GitHubApiError, type InstallationInfo } from '../../github/client.js';
import { checkGitHubCredentials, explainGitHubAppError } from '../../domain/credentials.js';
import { consumeState, createState } from '../../domain/oauth-state.js';
import { clearRepoCache, getInstallationRepos } from '../../domain/repos.js';
import { deleteGitHubConnection, getGitHubConnection, listApps, saveGitHubConnection } from '../../domain/store.js';
import { getMembership } from '../../domain/workspaces.js';
import { html } from '../../lib/html.js';
import { alert, badge, button, csrfField, pageHead, postButton, simplePage } from '../layout.js';
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

    let reposSection = html``;
    if (conn && deps.github) {
      try {
        const repos = await getInstallationRepos(deps, conn.installation_id, { fresh: true });
        const apps = await listApps(deps.db, ctx.workspace.id);
        const used = new Map<number, number>();
        for (const a of apps) used.set(a.repo_id, (used.get(a.repo_id) ?? 0) + 1);
        reposSection = repos.length
          ? html`<div class="table-wrap"><table><thead><tr><th>Repository</th><th>Visibility</th><th>Issues</th><th>Used by</th></tr></thead><tbody>
              ${repos.map((r) => html`<tr><td><a href="${r.htmlUrl}" target="_blank" rel="noopener noreferrer">${r.fullName}</a>${r.archived ? html` ${badge('Archived', 'warn')}` : ''}</td>
                <td>${r.private ? 'Private' : 'Public'}</td><td>${r.hasIssues ? badge('Enabled', 'ok') : badge('Disabled', 'danger')}</td>
                <td>${used.get(r.id) ? `${used.get(r.id)} app${used.get(r.id)! > 1 ? 's' : ''}` : html`<span class="muted">—</span>`}</td></tr>`)}
            </tbody></table></div>`
          : html`<div class="empty"><h3>No repositories shared yet</h3><p>Choose which repositories the app can access in GitHub, then reload this page.</p></div>`;
      } catch (err) {
        const removed = err instanceof GitHubApiError && (err.status === 404 || err.status === 401);
        reposSection = alert('error', removed ? 'GitHub says the app is no longer installed on this account. Reconnect GitHub below.' : 'Could not load repositories from GitHub right now. Reload to try again.');
      }
    }

    const credentials = deps.github && (!conn || conn.status !== 'active') ? await checkGitHubCredentials(deps) : null;

    const connectButtons = html`<div class="row">
      ${postButton(`${b}/setup/github/install`, conn ? 'Reinstall or change account' : 'Install the GitHub App', ctx.csrf, { variant: conn ? '' : 'github primary', disabled: !deps.github })}
      ${postButton(`${b}/setup/github/link`, 'Link an existing installation', ctx.csrf, { disabled: !deps.github })}
    </div>`;

    const body = html`
      ${pageHead('Step 1 · Connect GitHub', 'Tickets become issues in your GitHub repositories. Install the Ticket Relay GitHub App on the account or organization that owns them.')}
      ${!deps.github ? alert('warn', html`<p><strong>The GitHub App has not been registered for this deployment yet.</strong> Whoever runs the server needs to complete the <a href="${b}/provider-setup">deployment setup</a> first.</p>`) : ''}
      ${credentials && !credentials.ok ? alert('error', html`<p><strong>The server's GitHub App credentials don't work.</strong> ${credentials.detail}</p><p class="small">Fix <code>.env</code> or <code>secrets/sec.pem</code> on the server, then run <code>pm2 restart all --update-env</code>.</p>`) : ''}
      ${conn
        ? html`<div class="card">
            <div class="card-head"><h2>Connection</h2>${badge(conn.status === 'active' ? 'Connected' : conn.status === 'suspended' ? 'Suspended' : conn.status === 'removed' ? 'App uninstalled' : 'Problem', conn.status === 'active' ? 'ok' : 'danger')}</div>
            <div class="identity">${conn.account_avatar_url ? html`<img class="avatar square" src="${conn.account_avatar_url}" alt="">` : ''}
              <div><strong>${conn.account_login}</strong><div class="muted small">${conn.account_type} · ${conn.repository_selection === 'all' ? 'Access to all repositories' : 'Access to selected repositories'}</div></div></div>
            ${conn.status_detail ? alert(conn.status === 'active' ? 'info' : 'error', conn.status_detail) : ''}
            <hr class="divider">
            <div class="row">
              <a class="btn" href="${installationSettingsUrl(conn)}" target="_blank" rel="noopener noreferrer">Change repository access on GitHub</a>
              ${connectButtons}
              ${postButton(`${b}/setup/github/disconnect`, 'Disconnect', ctx.csrf, { variant: 'danger', confirm: 'Disconnect GitHub? New tickets cannot be filed until you connect again. Your apps and history are kept.' })}
            </div>
          </div>
          <div class="card"><div class="card-head"><h2>Repositories the app can access</h2></div>
            <p class="muted small">Only these repositories can be chosen for apps. The app can read basic repository details and labels, and create issues. It cannot read your code.</p>
            ${reposSection}
          </div>`
        : html`<div class="card">
            <h2>How it works</h2>
            <ol>
              <li>You will be sent to GitHub to install the app. Pick the account or organization that owns your repositories.</li>
              <li>Choose <strong>Only select repositories</strong> and pick the ones that should receive tickets (you can change this later).</li>
              <li>GitHub asks you to authorize the app. This only confirms that you have access to the installation; we do not keep your personal GitHub token.</li>
              <li>You come back here and see the connected account and its repositories.</li>
            </ol>
            <p class="muted small">The app asks for exactly two repository permissions: <strong>Issues: Read and write</strong> (to create issues and read labels) and <strong>Metadata: Read-only</strong> (required by GitHub to see repository names and settings). Installing on an organization may need approval from an organization owner.</p>
            ${connectButtons}
          </div>`}`;
    return web.render(reply, ctx, 'Connect GitHub', 'github', body);
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
    const state = await consumeState(deps.db, q.state, ['github_install']);
    if (!state || !deps.github) {
      return reply.type('text/html').send(simplePage('Finish connecting GitHub', html`<h1>Almost done</h1>
        <p>The app was installed on GitHub, but this link can't be matched to a workspace (it may have expired, or the installation was started from GitHub directly).</p>
        <p class="muted">Open your workspace's <strong>Connect GitHub</strong> page and choose <strong>Link an existing installation</strong>.</p><a class="btn primary" href="/">Go to the app</a>`));
    }
    const wid = state.workspace_id!;
    const back = `/w/${wid}/setup/github`;
    if (!req.auth || req.auth.session.id !== state.session_id || !(await getMembership(deps.db, req.auth.user.id, wid))) {
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
      <form method="post" action="/oauth/github/choose">${csrfField(req.auth.session.csrf_token)}
        <input type="hidden" name="state" value="${pickState}">
        <div class="stack">${installations.map((i, n) => html`<label class="checkbox"><input type="radio" name="installation_id" value="${String(i.id)}" ${n === 0 ? 'checked' : ''}> ${i.accountLogin} <span class="muted small">(${i.accountType})</span></label>`)}</div>
        <hr class="divider">${button('Connect', { variant: 'primary' })}
      </form>`;
    return reply.type('text/html').send(simplePage('Choose account', body));
  });

  app.post('/oauth/github/choose', async (req, reply) => {
    const body = req.body as { state?: string; installation_id?: string };
    const state = await consumeState(deps.db, body.state, ['github_install']);
    if (!state || state.data.mode !== 'pick' || !req.auth || req.auth.session.id !== state.session_id || !deps.github) return reply.redirect('/');
    const wid = state.workspace_id!;
    if (!(await getMembership(deps.db, req.auth.user.id, wid))) return reply.redirect('/');
    const id = Number(body.installation_id);
    if (!(state.data.allowed as number[]).includes(id)) {
      setFlash(reply, 'error', 'That installation is not available to you.');
      return reply.redirect(`/w/${wid}/setup/github`);
    }
    return connectInstallation(reply, wid, req.auth.user.id, id);
  });
}

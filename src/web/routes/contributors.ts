import type { FastifyInstance } from 'fastify';
import {
  addTier,
  checkContributorPanel,
  deleteTier,
  listTiers,
  contributorApps,
  getContributorSettings,
  inspectRoles,
  listVerifications,
  publishContributorPanel,
  revokeVerification,
  saveContributorSettings,
  setContributorApps,
  unpublishContributorPanel,
} from '../../domain/contributors.js';
import { inspectGuild } from '../../domain/discord-checks.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { alert, badge, button, csrfField, formatDate, pageHead, postButton, timeAgo } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';

type Check = { status: 'ok' | 'warning' | 'error'; title: string; detail?: string };

const RESULT_BADGES: Record<string, [string, 'ok' | 'warn' | 'danger' | '']> = {
  verified: ['Verified', 'ok'],
  not_contributor: ['Not a contributor', ''],
  conflict: ['Account conflict', 'warn'],
  error: ['Error', 'danger'],
};

export function registerContributorRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/contributors', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const [settings, tiers, apps, conn, gh, history] = await Promise.all([
      getContributorSettings(deps.db, wid),
      listTiers(deps.db, wid),
      listApps(deps.db, wid),
      getDiscordConnection(deps.db, wid),
      getGitHubConnection(deps.db, wid),
      listVerifications(deps.db, wid),
    ]);
    const enabledApps = contributorApps(apps);

    // Live Discord + GitHub checks.
    const checks: Check[] = [];
    const roles = deps.discord && conn ? await inspectRoles(deps.discord, conn.guild_id) : null;
    const guild = deps.discord && conn ? await inspectGuild(deps.discord, conn.guild_id) : null;
    if (!conn) checks.push({ status: 'error', title: 'Connect a Discord server first (Connect Discord).' });
    else if (roles && !roles.ok) checks.push({ status: 'error', title: roles.message });
    else if (roles?.ok) {
      checks.push(roles.canManageRoles
        ? { status: 'ok', title: 'The bot has the Manage Roles permission' }
        : { status: 'error', title: 'The bot is missing the Manage Roles permission', detail: 'In Discord: Server Settings → Roles → the bot’s role → turn on Manage Roles.' });
      if (!tiers.length) checks.push({ status: 'error', title: 'No contributor roles added yet', detail: 'Add at least one role and the contributions it needs below.' });
      for (const tier of tiers) {
        const role = roles.roles.find((r) => r.id === tier.role_id);
        if (!role) checks.push({ status: 'error', title: `The role for “${tier.role_name}” no longer exists`, detail: 'Remove it and add the role again.' });
        else if (!role.assignable) checks.push({ status: 'error', title: `The bot can't assign @${role.name}`, detail: `${role.reason}. In Server Settings → Roles, drag the bot's role above @${role.name}.` });
        else checks.push({ status: 'ok', title: `@${role.name} at ${tier.min_contributions}+ contribution${tier.min_contributions === 1 ? '' : 's'}` });
      }
    }
    if (conn && guild?.ok) {
      const channel = settings.channel_id ? guild.channels.find((c) => c.id === settings.channel_id) : null;
      if (!settings.channel_id) checks.push({ status: 'error', title: 'No panel channel chosen' });
      else if (!channel) checks.push({ status: 'error', title: 'The chosen channel no longer exists or is hidden from the bot' });
      else if (channel.missing.length) checks.push({ status: 'error', title: `The bot is missing permissions in #${channel.name}`, detail: `Missing: ${channel.missing.join(', ')}` });
      else checks.push({ status: 'ok', title: `The bot can post in #${channel.name}` });
    }
    checks.push(enabledApps.length
      ? { status: 'ok', title: `${enabledApps.length} app${enabledApps.length > 1 ? 's' : ''} available for verification` }
      : { status: 'error', title: 'No apps selected for verification' });
    if (!gh || gh.status !== 'active') checks.push({ status: 'error', title: 'Connect GitHub first (Connect GitHub).' });
    else if (deps.github) {
      try {
        const inst = await deps.github.getInstallation(gh.installation_id);
        const missing = [['pull_requests', 'Pull requests'], ['contents', 'Contents']].filter(([k]) => !inst.permissions[k!]).map(([, n]) => `${n}: Read`);
        checks.push(missing.length
          ? { status: 'warning', title: `The GitHub App is missing ${missing.join(' and ')}`, detail: 'Needed to check merged pull requests and commits in private repositories. Add them in the GitHub App settings → Permissions, then accept the new permissions on the installation.' }
          : { status: 'ok', title: 'The GitHub App can read pull requests and commits' });
      } catch {
        checks.push({ status: 'warning', title: 'Could not check the GitHub App permissions right now' });
      }
    }
    if (!settings.enabled) checks.push({ status: 'warning', title: 'Verification is turned off', detail: 'Turn it on in the settings below.' });
    const blocking = checks.some((c) => c.status === 'error');
    const panel = await checkContributorPanel(deps, wid, conn);

    const usedRoles = new Set(tiers.map((t) => t.role_id));
    const roleOptions: SafeHtml = roles?.ok
      ? html`${roles.roles.filter((r) => !usedRoles.has(r.id)).map((r) => html`<option value="${r.id}" ${r.assignable ? '' : raw('disabled')}>@${r.name}${r.reason ? ` (${r.reason})` : ''}</option>`)}`
      : html``;
    const channelOptions: SafeHtml = guild?.ok
      ? html`${guild.channels.map((c) => html`<option value="${c.id}" ${c.id === settings.channel_id ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.category ? ` (${c.category})` : ''}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : ''}</option>`)}`
      : html``;

    const body = html`
      ${pageHead('Contributor roles', 'A second Discord panel where members sign in with GitHub and get a role based on how many merged pull requests or commits they have in an app’s repository. Roles are only removed if an admin revokes them.')}

      <div class="card">
        <div class="card-head"><h2>Checks</h2>${blocking ? badge('Action needed', 'danger') : badge('Ready', 'ok')}</div>
        <ul class="checks">${checks.map((c) => html`<li><span class="check-icon ${c.status}">${c.status === 'ok' ? '✓' : '!'}</span><div><div>${c.title}</div>${c.detail ? html`<div class="small muted">${c.detail}</div>` : ''}</div><div></div></li>`)}</ul>
      </div>

      <div class="grid grid-2">
        <form method="post" action="${b}/contributors/settings" class="card">
          ${csrfField(ctx.csrf)}
          <div class="card-head"><h2>Settings</h2></div>
          <div class="field"><label class="checkbox"><input type="checkbox" name="enabled" value="1" ${settings.enabled ? raw('checked') : ''}> Verification turned on</label></div>
          <div class="field"><label for="channel">Panel channel</label>
            <select id="channel" name="channel_id" required><option value="">Choose a channel…</option>${channelOptions}</select>
            <div class="hint">For example #verify. Separate from the ticket panel.</div></div>
          ${button('Save settings', { variant: 'primary', loading: 'Saving…' })}
        </form>

        <form method="post" action="${b}/contributors/apps" class="card">
          ${csrfField(ctx.csrf)}
          <div class="card-head"><h2>Apps</h2></div>
          ${apps.length
            ? html`<p class="small muted">Contributions to these apps’ repositories are added up. Each repository counts once.</p>
                <div class="stack">${apps.map((a) => html`<label class="checkbox"><input type="checkbox" name="app_ids" value="${a.id}" ${a.contributor_enabled ? raw('checked') : ''}> ${a.name} <span class="muted small mono">${a.repo_owner}/${a.repo_name}</span></label>`)}</div>
                <hr class="divider">${button('Save apps', { loading: 'Saving…' })}`
            : html`<p class="muted">Add apps first on the <a href="${b}/apps">Apps</a> page.</p>`}
        </form>
      </div>

      <div class="card">
        <div class="card-head"><h2>Roles</h2></div>
        <p class="small muted">Per repository: merged pull requests or direct commits, whichever is higher, added up across the apps selected under Apps. Members get the highest role they qualify for; moving up replaces the lower role.</p>
        ${tiers.length
          ? html`<div class="table-wrap"><table><thead><tr><th>Role</th><th>Contributions needed</th><th></th></tr></thead><tbody>
              ${tiers.map((t) => html`<tr><td>@${t.role_name}</td><td>${String(t.min_contributions)}+</td>
                <td>${postButton(`${b}/contributors/tiers/${t.id}/delete`, 'Remove', ctx.csrf, { variant: 'sm danger', confirm: `Remove @${t.role_name} from the contributor roles? Members keep it until an admin removes it in Discord.` })}</td></tr>`)}
            </tbody></table></div>`
          : html`<p class="muted">No roles yet. Add the first one below, e.g. Junior Contributor at 1.</p>`}
        <form method="post" action="${b}/contributors/tiers" class="row">
          ${csrfField(ctx.csrf)}
          <select name="role_id" required aria-label="Role"><option value="">Choose a role…</option>${roleOptions}</select>
          <input type="number" name="min_contributions" min="1" max="100000" required placeholder="Contributions" aria-label="Contributions needed">
          ${button('+ Add role', { loading: 'Adding…' })}
        </form>
        <p class="hint">The bot can only give roles that sit below its own role.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>Contributor panel</h2>
          ${panel.state === 'published' ? (panel.outdated || panel.channelChanged ? badge('Out of date', 'warn') : badge('Published', 'ok')) : panel.state === 'missing' ? badge('Deleted in Discord', 'danger') : badge('Not published', 'warn')}</div>
        ${panel.state === 'published' && panel.link ? html`<p class="small"><a href="${panel.link}" target="_blank" rel="noopener noreferrer">Open in Discord</a></p>` : ''}
        ${blocking ? alert('info', 'Fix the checks above to publish the panel.') : ''}
        <div class="row">
          ${postButton(`${b}/contributors/publish`, panel.state === 'published' ? (panel.channelChanged ? 'Move panel to new channel' : 'Update panel') : panel.state === 'missing' ? 'Publish panel again' : 'Publish panel', ctx.csrf, { variant: 'primary', loading: 'Publishing…', disabled: blocking || !settings.enabled })}
          ${panel.state !== 'not_published' ? postButton(`${b}/contributors/remove`, 'Remove panel from Discord', ctx.csrf, { variant: 'danger', confirm: 'Remove the contributor panel from Discord? Existing roles are kept.' }) : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Verification history</h2></div>
        ${history.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>When</th><th>Member</th><th>GitHub</th><th>App</th><th>Result</th><th></th></tr></thead>
              <tbody>${history.map((v) => {
                const [label, tone] = RESULT_BADGES[v.result] ?? [v.result, ''];
                return html`<tr>
                  <td class="nowrap" title="${formatDate(v.created_at)}">${timeAgo(v.created_at)}</td>
                  <td>${v.discord_name}<div class="sub">${v.discord_user_id}</div></td>
                  <td>${v.github_login ? html`<a href="https://github.com/${v.github_login}" target="_blank" rel="noopener noreferrer">${v.github_login}</a>` : html`<span class="muted">—</span>`}</td>
                  <td>${v.app_name}</td>
                  <td>${v.revoked_at ? badge('Revoked', '') : badge(v.result === 'verified' && v.role_name ? v.role_name : label, tone)}${v.contributions !== null ? html`<div class="sub">${String(v.contributions)} contribution${v.contributions === 1 ? '' : 's'}</div>` : ''}${v.info ? html`<div class="sub">${v.info}</div>` : ''}</td>
                  <td>${v.result === 'verified' && !v.revoked_at ? postButton(`${b}/contributors/verifications/${v.id}/revoke`, 'Revoke', ctx.csrf, { variant: 'sm danger', confirm: `Remove the role from ${v.discord_name} and unlink ${v.github_login}?` }) : ''}</td>
                </tr>`;
              })}</tbody></table></div>`
          : html`<div class="empty"><h3>No verifications yet</h3><p>Attempts appear here once members use the contributor panel.</p></div>`}
      </div>`;
    return web.render(reply, ctx, 'Contributor roles', 'contributors', body);
  });

  app.post('/w/:wid/contributors/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const back = `${ctx.base}/contributors`;
    const body = req.body as { enabled?: string; channel_id?: string };
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    if (!conn || !deps.discord) {
      setFlash(reply, 'error', 'Connect a Discord server first.');
      return reply.redirect(back);
    }
    const guild = await inspectGuild(deps.discord, conn.guild_id);
    if (!guild.ok) {
      setFlash(reply, 'error', 'Could not read the server from Discord. Try again in a moment.');
      return reply.redirect(back);
    }
    // Server-side allowlist: the channel must belong to the connected server.
    const channel = guild.channels.find((c) => c.id === body.channel_id);
    if (!channel || channel.missing.length) {
      setFlash(reply, 'error', channel ? `The bot is missing permissions in #${channel.name}: ${channel.missing.join(', ')}.` : 'Choose one of the listed channels.');
      return reply.redirect(back);
    }
    await saveContributorSettings(deps.db, ctx.workspace.id, {
      enabled: body.enabled !== undefined,
      role_id: null,
      role_name: null,
      channel_id: channel.id,
      channel_name: channel.name,
    });
    setFlash(reply, 'success', 'Contributor settings saved. Update the panel if it is already published.');
    return reply.redirect(back);
  });

  app.post('/w/:wid/contributors/tiers', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const back = `${ctx.base}/contributors`;
    const body = req.body as { role_id?: string; min_contributions?: string };
    const min = Number(body.min_contributions);
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    if (!conn || !deps.discord) {
      setFlash(reply, 'error', 'Connect a Discord server first.');
      return reply.redirect(back);
    }
    if (!Number.isInteger(min) || min < 1 || min > 100000) {
      setFlash(reply, 'error', 'Enter the number of contributions needed (1 or more).');
      return reply.redirect(back);
    }
    const roles = await inspectRoles(deps.discord, conn.guild_id);
    // Server-side allowlist: the role must exist in the connected server and be assignable.
    const role = roles.ok ? roles.roles.find((r) => r.id === body.role_id) : undefined;
    if (!role || !role.assignable) {
      setFlash(reply, 'error', role ? `The bot can't assign @${role.name}: ${role.reason}.` : 'Choose one of the listed roles.');
      return reply.redirect(back);
    }
    try {
      await addTier(deps.db, ctx.workspace.id, role, min);
      setFlash(reply, 'success', `Added @${role.name} at ${min}+ contributions. Update the panel if it is already published.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/contributors/tiers/:tid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await deleteTier(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    setFlash(reply, 'success', 'Role removed from the contributor roles. Update the panel if it is already published.');
    return reply.redirect(`${ctx.base}/contributors`);
  });

  app.post('/w/:wid/contributors/apps', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const raw = (req.body as { app_ids?: string | string[] }).app_ids;
    const requested = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const own = new Set((await listApps(deps.db, ctx.workspace.id)).map((a) => a.id));
    await setContributorApps(deps.db, ctx.workspace.id, requested.filter((id) => own.has(id)));
    setFlash(reply, 'success', 'Apps saved. Update the panel if it is already published.');
    return reply.redirect(`${ctx.base}/contributors`);
  });

  app.post('/w/:wid/contributors/publish', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    try {
      const result = await publishContributorPanel(deps, ctx.workspace.id, ctx.user.id);
      setFlash(reply, 'success', {
        created: 'The contributor panel was posted in Discord.',
        updated: 'The contributor panel was updated.',
        recreated: 'The old panel had been deleted, so a new one was posted.',
        moved: 'The panel was posted in the new channel and removed from the old one.',
      }[result]);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/contributors`);
  });

  app.post('/w/:wid/contributors/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await unpublishContributorPanel(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'The contributor panel was removed from Discord. Existing roles were kept.');
    return reply.redirect(`${ctx.base}/contributors`);
  });

  app.post('/w/:wid/contributors/verifications/:vid/revoke', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    try {
      await revokeVerification(deps, ctx.workspace.id, (req.params as { vid: string }).vid, ctx.user.id);
      setFlash(reply, 'success', 'Role removed and GitHub account unlinked.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/contributors`);
  });
}

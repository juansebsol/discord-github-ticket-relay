import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkContributorPanel, contributorApps, getContributorSettings, listManualRoles, listTiers, verificationStats } from '../../domain/contributors.js';
import { checkDiscordCredentials, checkGitHubCredentials, type CredentialCheck } from '../../domain/credentials.js';
import { healthView, type HealthView, type ProcessRole } from '../../domain/health.js';
import { checkPanel } from '../../domain/panel.js';
import { can } from '../../domain/permissions.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../../domain/store.js';
import { countByStatus, decryptPayload, filedThisWeek, listSubmissions } from '../../domain/submissions.js';
import { enabledTicketTypes } from '../../domain/ticket-types.js';
import { updateWorkspaceGeneral, userNames } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import type { StepState } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import {
  copyField,
  csrfField,
  empty,
  icon,
  iconBtn,
  linkBtn,
  locked,
  notice,
  pageHeader,
  pill,
  plural,
  setting,
  submitBtn,
  tag,
  when,
  type IconName,
} from '../ui.js';
import { ticketList } from './tickets.js';

function stat(href: string, label: string, value: number, warn = false): SafeHtml {
  return html`<a class="stat" href="${href}"><div class="l">${label}</div><div class="v${warn && value > 0 ? ' warn' : ''}">${String(value)}${warn && value > 0 ? icon('triangle-alert', 14) : ''}</div></a>`;
}

function utilityCard(o: { icon: IconName; title: string; meta: string; problem?: SafeHtml | null; stats: SafeHtml; links: SafeHtml }): SafeHtml {
  return html`<div class="card">
    <div class="card-h"><div><div class="title">${icon(o.icon)}<h2>${o.title}</h2></div><div class="desc">${o.meta}</div></div>${o.problem ?? ''}</div>
    <div class="stats">${o.stats}</div>
    <div class="card-f plain"><div class="row gap-4">${o.links}</div></div>
  </div>`;
}

export function registerWorkspaceRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  // ---- Overview ---------------------------------------------------------------------------------

  app.get('/w/:wid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const [gh, dc, apps, counts, recent, filed, settings, tiers, manual, vstats, types] = await Promise.all([
      getGitHubConnection(deps.db, wid),
      getDiscordConnection(deps.db, wid),
      listApps(deps.db, wid),
      countByStatus(deps.db, wid),
      listSubmissions(deps.db, wid, { limit: 5, offset: 0 }),
      filedThisWeek(deps.db, wid),
      getContributorSettings(deps.db, wid),
      listTiers(deps.db, wid),
      listManualRoles(deps.db, wid),
      verificationStats(deps.db, wid),
      enabledTicketTypes(deps.db, wid),
    ]);
    const p = ctx.progress!;
    const names = await userNames(deps.db, recent.rows.map((r) => r.resolved_by));
    const enabledApps = apps.filter((a) => a.enabled);
    const contribRepos = new Set(contributorApps(apps).map((a) => a.repo_id)).size;
    const manage = can(ctx.membership, 'manage');
    const act = can(ctx.membership, 'tickets.act');
    const contribView = can(ctx.membership, 'contrib.view');
    const queued = counts.pending + counts.processing;

    const attentionNotice = p.attention
      ? notice('warn', `${plural(p.attention, 'ticket')} need${p.attention === 1 ? 's' : ''} attention`,
          act
            ? [counts.uncertain ? `${counts.uncertain} couldn’t be confirmed on GitHub` : '', counts.failed ? `${counts.failed} failed` : ''].filter(Boolean).join(' and ') + '.'
            : 'Admins can retry or close them. You can view them.',
          { action: linkBtn(`${b}/tickets?status=attention`, act ? 'Review' : 'View', { size: 'sm' }) })
      : '';

    const latest = html`<div class="card">
      <div class="card-h"><h2>Latest tickets</h2>${recent.rows.length ? linkBtn(`${b}/tickets?status=all`, 'View all', { variant: 'ghost', size: 'sm', trail: 'arrow-right' }) : ''}</div>
      <div class="card-b flush">${recent.rows.length
        ? ticketList(b, recent.rows, (s) => decryptPayload(deps.box, s)?.title ?? null, names, { compact: true })
        : empty('inbox', 'No tickets yet', 'Tickets appear here as soon as members use the panel in Discord.')}</div>
    </div>`;

    const ticketsCard = (links: SafeHtml, problem: SafeHtml | null) => utilityCard({
      icon: 'ticket',
      title: 'Tickets',
      meta: manage
        ? [dc?.tickets_channel_name ? `#${dc.tickets_channel_name}` : 'No channel yet', plural(enabledApps.length, 'app'), types.length ? plural(types.length, 'ticket type') : null].filter(Boolean).join(' · ')
        : dc?.tickets_channel_name ? `From #${dc.tickets_channel_name}` : 'From the ticket panel in Discord',
      problem,
      stats: html`${stat(`${b}/tickets?status=filed`, 'Filed this week', filed)}${stat(`${b}/tickets?status=attention`, 'Need attention', p.attention, true)}${stat(`${b}/tickets?status=open`, 'Queued', queued)}`,
      links,
    });
    const contribCard = (links: SafeHtml, problem: SafeHtml | null) => utilityCard({
      icon: 'award',
      title: 'Contributor Roles',
      meta: manage
        ? settings.channel_name || tiers.length
          ? [settings.channel_name ? `#${settings.channel_name}` : 'No channel yet', plural(tiers.length + manual.length, 'role'), plural(contribRepos, 'repository', 'repositories')].join(' · ')
          : 'Not set up yet'
        : settings.channel_name ? `From #${settings.channel_name}` : 'From the contributor panel in Discord',
      problem,
      stats: html`${stat(`${b}/contributors?result=verified`, 'Verified', vstats.verified)}${stat(`${b}/contributors?result=all`, 'This week', vstats.thisWeek)}${stat(`${b}/contributors?result=conflict`, 'Conflicts', vstats.conflicts, true)}`,
      links,
    });
    const go = (href: string, label: string, trail = true) => linkBtn(href, label, { variant: 'ghost', size: 'sm', trail: trail ? 'arrow-right' : undefined });

    if (!manage) {
      // Moderators: what needs attention, the latest tickets and what they're allowed to do.
      const accessRow = (label: string, allowed: boolean, always = false) => html`<div class="line sm"><span class="grow small">${label}</span>${allowed
        ? html`<span class="locked">${icon('circle-check', 14, 'ok')}${always ? 'Always' : 'Allowed'}</span>`
        : locked('Not allowed')}</div>`;
      const body = html`
        ${pageHeader({ title: 'Overview', description: `${ctx.workspace.name} · You're a moderator` })}
        ${attentionNotice}
        <div class="g2">
          ${ticketsCard(go(`${b}/tickets`, 'Open inbox'), null)}
          ${contribView ? contribCard(go(`${b}/contributors`, 'Verifications'), null) : ''}
        </div>
        <div class="g-2-1">
          ${latest}
          <div class="card"><div class="card-h"><div><h2>Your access</h2><div class="desc">Set by admins in Members &amp; permissions.</div></div></div>
            <div>${accessRow('View tickets', true, true)}${accessRow('Act on tickets', act)}${accessRow('Contributor verifications', contribView)}</div></div>
        </div>`;
      return web.render(reply, ctx, 'Overview', 'overview', body);
    }

    const [panelState, contribPanel] = await Promise.all([checkPanel(deps, wid, { live: false }), checkContributorPanel(deps, wid, dc, { live: false })]);
    const steps: { state: StepState; icon: IconName; name: string; detail: string; href: string; cta: string }[] = [
      {
        state: p.github, icon: 'github', name: 'GitHub', href: `${b}/setup/github`, cta: 'Connect GitHub',
        detail: gh ? `${gh.account_login} · ${gh.repository_selection === 'all' ? 'all repositories' : 'selected repositories'}${gh.status !== 'active' ? ` · ${gh.status}` : ''}` : 'Install the GitHub App on the account that owns your repositories.',
      },
      {
        state: p.discord, icon: 'message-circle', name: 'Discord', href: `${b}/setup/discord`, cta: 'Connect Discord',
        detail: dc ? `${dc.guild_name} · ${dc.status === 'active' ? 'bot ready' : 'bot removed'}` : 'Add the bot to your Discord server.',
      },
      {
        state: p.apps, icon: 'boxes', name: 'Apps & repositories', href: `${b}/apps`, cta: 'Add apps',
        detail: apps.length ? `${plural(enabledApps.length, 'app')} enabled` : 'Choose the apps members can pick and where each one files issues.',
      },
    ];
    const done = steps.filter((s) => s.state === 'done').length;
    const stepRow = (s: (typeof steps)[number]) => html`<a class="line setup-row" href="${s.href}">${icon(s.icon, 16, 'muted')}<span class="grow"><span class="name">${s.name}</span><span class="small muted"> · ${s.detail}</span></span>${s.state === 'done'
      ? icon('circle-check', 14, 'ok')
      : s.state === 'problem' ? icon('triangle-alert', 14, 'warn') : icon('circle-dashed', 14, 'faint')}</a>`;
    const setupDone = done === steps.length;
    const nextStep = steps.find((s) => s.state !== 'done');

    const ticketProblem = panelState.state === 'missing' ? pill('Panel deleted', 'warn') : panelState.state === 'not_published' ? pill('Not published', 'neutral') : null;
    const contribProblem = !settings.enabled ? pill('Off', 'neutral') : contribPanel.state === 'missing' ? pill('Panel deleted', 'warn') : contribPanel.state === 'not_published' ? pill('Not published', 'neutral') : null;

    const body = html`
      ${pageHeader({ title: 'Overview', description: `${ctx.workspace.name}${dc ? ` · ${dc.guild_name} on Discord` : ''}` })}
      ${!deps.github || !deps.discord
        ? notice('warn', 'Deployment setup incomplete', 'Some provider credentials aren’t configured on the server, so parts of setup are unavailable.', { action: linkBtn(`${b}/deployment`, 'Open Deployment', { size: 'sm' }) })
        : ''}
      ${!setupDone ? html`<div class="card">
          <div class="card-h"><div><h2>Finish setup</h2><div class="desc">${String(done)} of ${String(steps.length)} steps done. Tickets start flowing once all three are connected.</div></div>${nextStep ? linkBtn(nextStep.href, nextStep.cta, { variant: 'primary', size: 'sm' }) : ''}</div>
          <div>${steps.map(stepRow)}</div></div>` : ''}
      ${attentionNotice}
      <div class="g2">
        ${ticketsCard(html`${go(`${b}/tickets`, 'Open inbox')}${go(`${b}/tickets/panel`, 'Panel', false)}`, ticketProblem)}
        ${contribCard(html`${go(`${b}/contributors`, 'Verifications')}${go(`${b}/contributors/roles`, 'Roles', false)}`, contribProblem)}
      </div>
      ${latest}
      ${setupDone ? html`<details class="card setup-done">
          <summary>${icon('circle-check', 16, 'ok')}<span>Setup complete</span><span class="small muted truncate">GitHub · Discord · ${plural(enabledApps.length, 'app')}</span>${icon('chevron-down', 16, 'chev')}</summary>
          <div>${steps.map(stepRow)}</div></details>` : ''}`;
    return web.render(reply, ctx, 'Overview', 'overview', body);
  });

  // ---- Workspace settings -----------------------------------------------------------------------

  app.get('/w/:wid/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const ws = ctx.workspace;
    const body = html`
      ${pageHeader({ title: 'Settings', description: 'Workspace-wide settings. Each utility has its own settings tab.' })}
      <form method="post" action="${ctx.base}/settings" class="card" data-dirty>
        ${csrfField(ctx.csrf)}
        <div class="card-h"><h2>Workspace</h2></div>
        ${setting('Workspace name', 'Shown in the sidebar and on invitations.', html`<input id="name" type="text" name="name" value="${ws.name}" required maxlength="80">`, { for: 'name' })}
        ${setting('Keep ticket text', 'Encrypted copies kept for troubleshooting and retries. Unresolved tickets keep theirs for at least 90 days.',
          html`<input type="number" id="retention_days" name="retention_days" value="${String(ws.retention_days)}" min="1" max="365" required aria-label="Days to keep ticket text"><span class="connector">days</span>`)}
        <div class="card-f"><div class="end">
          <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
          ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
        </div></div>
      </form>`;
    return web.render(reply, ctx, 'Settings', 'settings', body);
  });

  const settingsSchema = z.object({
    name: z.string().trim().min(1, 'Enter a workspace name.').max(80),
    retention_days: z.coerce.number().int().min(1).max(365),
  });

  app.post('/w/:wid/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      setFlash(reply, 'error', 'Enter a workspace name and keep ticket text for 1 to 365 days.');
      return reply.redirect(`${ctx.base}/settings`);
    }
    await updateWorkspaceGeneral(deps.db, ctx.workspace.id, { name: parsed.data.name, retentionDays: parsed.data.retention_days });
    setFlash(reply, 'success', 'Settings saved');
    return reply.redirect(`${ctx.base}/settings`);
  });

  // ---- Deployment (one-time provider registration) ----------------------------------------------

  app.get('/w/:wid/provider-setup', async (req, reply) => reply.redirect(`/w/${(req.params as { wid: string }).wid}/deployment`));

  const ROLE_NAMES: Record<ProcessRole, string> = { web: 'Web (console and Discord)', worker: 'Filing worker', triage: 'Triage and issue sync' };
  const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;
  const gb = (bytes: number) => `${(bytes / 1073741824).toFixed(1)} GB`;

  /** Memory of the server and of each process, against the limit at which PM2 restarts it. */
  function healthCard(h: HealthView, base: string) {
    const hot = h.running.filter((p) => p.limit_mb && p.rss_bytes >= p.limit_mb * 1048576 * 0.8);
    const lowHost = h.host && (h.host.available < 300 * 1048576 || h.host.available / h.host.total < 0.15);
    const status = !h.running.length ? pill('No reports yet', 'neutral') : hot.length || lowHost ? pill('Check memory', 'warn') : pill('Healthy', 'ok');
    const restarts = (role: ProcessRole) => h.restarts[role];
    return html`<div class="card" id="health">
      <div class="card-h"><div><div class="title"><h2>Server health</h2>${status}</div><div class="desc">Memory each process uses right now. PM2 restarts a process that goes over its limit (max_memory_restart in ecosystem.config.cjs).</div></div>
        ${iconBtn('refresh-cw', 'Refresh', { size: 'sm', href: `${base}/deployment#health` })}</div>
      ${hot.length ? notice('warn', `${hot.map((p) => ROLE_NAMES[p.role]).join(', ')} ${hot.length === 1 ? 'is' : 'are'} above 80% of the memory limit`, 'If it reaches the limit, PM2 restarts it. Raise max_memory_restart and MEMORY_LIMIT_MB together in ecosystem.config.cjs, or run fewer filing workers.') : ''}
      ${h.host ? html`<div class="setting"><div><div class="lbl">Server memory</div><div class="desc">${gb(h.host.available)} available of ${gb(h.host.total)}. “Available” includes cache the system frees when needed.</div></div>
          <div class="control"><div class="meter-cell"><progress class="bar${lowHost ? ' warn' : ''}" value="${String(h.host.total - h.host.available)}" max="${String(h.host.total)}" aria-label="Server memory used"></progress><span class="small muted">${gb(h.host.total - h.host.available)} used</span></div></div></div>` : ''}
      ${h.running.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>Process</th><th>Memory</th><th class="num">Running since</th><th class="num">Restarts (24 h)</th></tr></thead>
            <tbody>${h.running.map((p) => {
              const limit = p.limit_mb ? p.limit_mb * 1048576 : null;
              const near = limit && p.rss_bytes >= limit * 0.8;
              return html`<tr>
                <td><div class="cell-title">${ROLE_NAMES[p.role] ?? p.role}</div><div class="sub mono">PID ${String(p.pid)}</div></td>
                <td><div class="meter-cell">${limit ? html`<progress class="bar${near ? ' warn' : ''}" value="${String(Math.min(p.rss_bytes, limit))}" max="${String(limit)}" aria-label="Memory used"></progress>` : ''}
                  <span class="small">${mb(p.rss_bytes)}${limit ? html`<span class="muted"> of ${String(p.limit_mb)} MB</span>` : html`<span class="muted"> · no limit set</span>`}</span></div></td>
                <td class="num">${when(p.started_at)}</td>
                <td class="num">${restarts(p.role) ? html`<span class="${restarts(p.role) > 3 ? 'warn-text' : ''}">${String(restarts(p.role))}</span>` : '0'}</td></tr>`;
            })}</tbody></table></div>
          <div class="card-note">Updated every 30 seconds. Restarts include deploys (pm2 reload). Reload this page to refresh.</div>`
        : html`<div class="card-b"><p class="small muted">No process has reported yet. Reports start within a minute of the processes running this version.</p></div>`}
    </div>`;
  }

  app.get('/w/:wid/deployment', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const c = deps.config;
    const [discordCheck, githubCheck, health] = await Promise.all([checkDiscordCredentials(deps), checkGitHubCredentials(deps), healthView(deps.db)]);
    const state = (missing: string[], check: CredentialCheck) =>
      missing.length ? pill('Incomplete', 'warn') : check.ok ? pill('Working', 'ok') : pill('Credentials rejected', 'danger');
    const detail = (missing: string[], check: CredentialCheck) => (missing.length ? `Missing: ${missing.join(', ')}` : check.detail);
    const allOk = !c.missing.discord.length && !c.missing.github.length && discordCheck.ok && githubCheck.ok;
    const provider = (o: { icon: IconName; name: string; missing: string[]; check: CredentialCheck; label: string }) => html`<div class="line provider">
      <span class="tile">${icon(o.icon)}</span>
      <div class="grow"><div class="name">${o.name}</div><div class="sub">${detail(o.missing, o.check)}</div></div>
      ${state(o.missing, o.check)}${iconBtn('refresh-cw', `Re-test ${o.label} credentials`, { size: 'sm', href: `${ctx.base}/deployment` })}</div>`;
    const env = (names: string[]) => html`<div class="tags">${names.map((n) => html`<code>${n}</code>`)}</div>`;
    const body = html`
      ${pageHeader({
        title: 'Deployment',
        after: allOk ? pill('All configured', 'ok') : pill('Needs attention', 'warn'),
        description: 'One-time provider registration, done by whoever runs the server. Secret values are never shown here.',
      })}
      <div class="card">
        <div class="card-h"><h2>Providers</h2></div>
        ${provider({ icon: 'bot', name: 'Discord application', missing: c.missing.discord, check: discordCheck, label: 'Discord' })}
        ${provider({ icon: 'github', name: 'GitHub App', missing: c.missing.github, check: githubCheck, label: 'GitHub' })}
        <div class="line provider"><span class="tile">${icon('bot')}</span>
          <div class="grow"><div class="name">Claude API <span class="muted">(optional)</span></div><div class="sub">${c.anthropicApiKey ? 'ANTHROPIC_API_KEY is set. Workspaces without their own key use it for triage.' : 'For AI triage. Workspaces add their own key in Tickets › Triage, or set ANTHROPIC_API_KEY as a fallback.'}</div></div>
          ${c.anthropicApiKey ? pill('Fallback key set', 'ok') : pill('Not set', 'neutral')}</div>
      </div>

      ${healthCard(health, ctx.base)}

      <div class="card">
        <div class="card-h"><div><h2>Discord Developer Portal</h2><div class="desc">Applications › your app.</div></div>${linkBtn('https://discord.com/developers/applications', 'Open portal', { variant: 'ghost', size: 'sm', trail: 'arrow-up-right', external: true })}</div>
        ${setting('Interactions endpoint URL', 'General Information. Discord sends panel clicks and forms here.', copyField('discord-interactions', web.publicUrl('/discord/interactions'), 'Interactions endpoint URL'), { top: true })}
        ${setting('OAuth2 redirect', 'OAuth2 › Redirects. Used for console sign-in and for adding the bot.', copyField('discord-redirect', web.publicUrl('/oauth/discord/callback'), 'OAuth2 redirect'), { top: true })}
        ${setting('Terms of Service URL', 'General Information. Required to verify the bot.', copyField('discord-terms', web.publicUrl('/terms'), 'Terms of Service URL'), { top: true })}
        ${setting('Privacy Policy URL', html`General Information. Required to verify the bot.${c.legal.contactEmail ? '' : html` ${tag('Set LEGAL_CONTACT_EMAIL', { icon: 'triangle-alert', title: 'The legal pages need a contact email. Set LEGAL_CONTACT_EMAIL (and LEGAL_OPERATOR_NAME) in .env.' })}`}`, copyField('discord-privacy', web.publicUrl('/privacy'), 'Privacy Policy URL'), { top: true })}
        ${setting('Bot', 'Keep Public Bot off unless other workspaces on this deployment should add it. No privileged intents are needed.', tag('No intents'))}
        ${setting('Server variables', 'Set in .env on the server.', env(['DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN']), { stacked: true })}
      </div>

      <div class="card">
        <div class="card-h"><div><h2>GitHub App</h2><div class="desc">Settings › Developer settings › GitHub Apps.</div></div>${linkBtn('https://github.com/settings/apps', 'Open settings', { variant: 'ghost', size: 'sm', trail: 'arrow-up-right', external: true })}</div>
        ${setting('Callback URL', 'Must be the first callback URL. Turn on “Request user authorization (OAuth) during installation”.', copyField('github-callback', web.publicUrl('/oauth/github/callback'), 'Callback URL'), { top: true })}
        ${setting('Webhook URL', html`Optional but recommended, so uninstalls show up right away. ${c.github?.webhookSecret ? tag('Webhook secret set', { icon: 'circle-check' }) : tag('No webhook secret')}`, copyField('github-webhook', web.publicUrl('/github/webhook'), 'Webhook URL'), { top: true })}
        ${setting('Repository permissions', 'Nothing else is needed, and no extra events.', html`<div class="tags">${tag('Issues: read and write')}${tag('Metadata: read')}${tag('Pull requests: read')}${tag('Contents: read')}</div>`, { top: true })}
        ${setting('Server variables', 'Set in .env on the server. The private key can be a path, such as secrets/sec.pem.', env(['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']), { stacked: true })}
        <div class="card-note">The full guide is in <code>docs/PROVIDER_SETUP.md</code>. After changing <code>.env</code> or <code>secrets/sec.pem</code>, run <code>pm2 restart all --update-env</code>.</div>
      </div>`;
    return web.render(reply, ctx, 'Deployment', 'deployment', body);
  });
}

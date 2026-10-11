import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDiscordConnection, getGitHubConnection, getPanel, listApps } from '../../domain/store.js';
import { countByStatus, decryptPayload, listSubmissions } from '../../domain/submissions.js';
import { UserFacingError, type SubmissionRow } from '../../domain/types.js';
import {
  createInvite,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  updateWorkspaceSettings,
} from '../../domain/workspaces.js';
import { DEFAULT_PANEL_INTRO, DEFAULT_PANEL_TITLE } from '../../discord/messages.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { alert, badge, button, csrfField, discordAvatar, formatDate, pageHead, postButton, statusBadge, timeAgo } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';

/** Submission history table. `titleOf` decrypts the stored ticket title for display. */
export function submissionsTable(base: string, rows: Awaited<ReturnType<typeof listSubmissions>>['rows'], titleOf: (s: SubmissionRow) => string | null): SafeHtml {
  if (!rows.length) {
    return html`<div class="empty"><h3>No tickets yet</h3><p>Submissions will appear here as soon as members use the ticket panel in Discord.</p></div>`;
  }
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Ticket</th><th>App</th><th>Reporter</th><th>Status</th><th>GitHub issue</th></tr></thead>
    <tbody>${rows.map(
      (s) => html`<tr>
        <td><a class="title" href="${base}/submissions/${s.id}">${titleOf(s) ?? s.ref}</a><div class="sub"><span class="mono">${s.ref}</span> · ${timeAgo(s.created_at)}</div></td>
        <td>${s.app_name}${s.source === 'admin_test' ? html` ${badge('Test', 'info')}` : ''}</td>
        <td>${s.reporter_display_name}<div class="sub">${s.reporter_username ? `@${s.reporter_username}` : s.reporter_discord_id}</div></td>
        <td>${statusBadge(s.status)}</td>
        <td>${s.issue_url ? html`<a href="${s.issue_url}" target="_blank" rel="noopener noreferrer">${s.repo_name}#${s.issue_number}</a>` : html`<span class="muted">—</span>`}</td>
      </tr>`,
    )}</tbody></table></div>`;
}

export function registerWorkspaceRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const [gh, dc, apps, panel, counts, recent] = await Promise.all([
      getGitHubConnection(deps.db, wid),
      getDiscordConnection(deps.db, wid),
      listApps(deps.db, wid),
      getPanel(deps.db, wid),
      countByStatus(deps.db, wid),
      listSubmissions(deps.db, wid, { limit: 8, offset: 0 }),
    ]);
    const p = ctx.progress!;
    const setupDone = p.github === 'done' && p.discord === 'done' && p.apps === 'done' && p.panel === 'done';
    const enabledApps = apps.filter((a) => a.enabled).length;
    const b = ctx.base;

    const step = (n: number, state: 'done' | 'todo' | 'problem', title: string, text: string, href: string, cta: string) => html`
      <div class="step">
        <span class="step-dot ${state === 'done' ? 'done' : state === 'problem' ? 'problem' : ''}">${state === 'done' ? '✓' : state === 'problem' ? '!' : String(n)}</span>
        <div><h3>${title}</h3><p>${text}</p></div>
        <a class="btn ${state === 'done' ? '' : 'primary'}" href="${href}">${state === 'done' ? 'Review' : cta}</a>
      </div>`;

    const body = html`
      ${pageHead(ctx.workspace.name, setupDone ? 'Tickets submitted in Discord are being filed as GitHub issues.' : 'Finish these steps to start receiving tickets from Discord.')}
      ${(!deps.github || !deps.discord) ? alert('warn', html`<p><strong>Deployment setup incomplete.</strong> Some provider credentials are not configured on the server yet, so parts of the setup are unavailable. <a href="${b}/provider-setup">See what is missing</a>.</p>`) : ''}
      ${p.attention ? alert('warn', html`<p><strong>${p.attention} submission${p.attention > 1 ? 's need' : ' needs'} attention.</strong> Some tickets failed or could not be confirmed. <a href="${b}/submissions?status=attention">Review them</a>.</p>`) : ''}

      ${!setupDone ? html`<div class="card"><div class="card-head"><h2>Setup</h2></div><div class="steps">
        ${step(1, p.github, 'Connect GitHub', gh ? `Connected to ${gh.account_login}${gh.status !== 'active' ? ` — ${gh.status}` : ''}` : 'Install the GitHub App on the account that owns your repositories.', `${b}/setup/github`, 'Connect GitHub')}
        ${step(2, p.discord, 'Connect Discord', dc ? (dc.tickets_channel_id ? `${dc.guild_name} · #${dc.tickets_channel_name}` : `${dc.guild_name} · choose a tickets channel`) : 'Add the bot to your server and choose the tickets channel.', `${b}/setup/discord`, 'Connect Discord')}
        ${step(3, p.apps, 'Add your apps', apps.length ? `${enabledApps} of ${apps.length} apps enabled` : 'Tell the bot which apps people can file tickets for, and where each one goes.', `${b}/apps`, 'Add apps')}
        ${step(4, p.panel, 'Validate and publish', panel ? (panel.status === 'missing' ? 'The panel was deleted from Discord.' : `Published ${timeAgo(panel.published_at)}`) : 'Check everything and post the ticket panel in Discord.', `${b}/panel`, 'Validate & publish')}
      </div></div>` : ''}

      <div class="grid grid-4">
        <div class="card stat"><div class="num">${counts.created}</div><div class="label">Tickets filed</div></div>
        <div class="card stat"><div class="num">${counts.pending + counts.processing}</div><div class="label">In progress</div></div>
        <div class="card stat"><div class="num">${counts.uncertain}</div><div class="label">Need checking</div></div>
        <div class="card stat"><div class="num">${counts.failed}</div><div class="label">Failed</div></div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>GitHub</h2>${gh ? badge(gh.status === 'active' ? 'Connected' : gh.status === 'suspended' ? 'Suspended' : 'Disconnected', gh.status === 'active' ? 'ok' : 'danger') : badge('Not connected', 'warn')}</div>
          ${gh ? html`<div class="identity">${gh.account_avatar_url ? html`<img class="avatar square" src="${gh.account_avatar_url}" alt="">` : ''}<div><strong>${gh.account_login}</strong><div class="muted small">${gh.account_type} · ${gh.repository_selection === 'all' ? 'all repositories' : 'selected repositories'}</div></div></div>
            ${gh.status_detail ? html`<p class="small muted">${gh.status_detail}</p>` : ''}` : html`<p class="muted">Not connected yet.</p>`}
          <a class="btn sm" href="${b}/setup/github">${gh && gh.status !== 'active' ? 'Reconnect' : 'Manage'}</a>
        </div>
        <div class="card">
          <div class="card-head"><h2>Discord</h2>${dc ? badge(dc.status === 'active' ? (dc.tickets_channel_id ? 'Connected' : 'Choose a channel') : 'Disconnected', dc.status === 'active' ? (dc.tickets_channel_id ? 'ok' : 'warn') : 'danger') : badge('Not connected', 'warn')}</div>
          ${dc ? html`<p><strong>${dc.guild_name}</strong><br><span class="muted small">${dc.tickets_channel_id ? `Tickets channel: #${dc.tickets_channel_name}` : 'No tickets channel selected'}</span></p>
            <p class="small muted">Panel: ${panel ? (panel.status === 'missing' ? 'deleted from Discord' : `published ${timeAgo(panel.published_at)}`) : 'not published'}</p>` : html`<p class="muted">Not connected yet.</p>`}
          <a class="btn sm" href="${b}/setup/discord">${dc && dc.status !== 'active' ? 'Reconnect' : 'Manage'}</a>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Recent submissions</h2><a class="btn sm" href="${b}/submissions">View all</a></div>
        ${submissionsTable(b, recent.rows, (s) => decryptPayload(deps.box, s)?.title ?? null)}
      </div>`;
    return web.render(reply, ctx, 'Overview', 'overview', body);
  });

  // ---- Settings & admins ----------------------------------------------------------------------

  async function renderSettings(ctx: WorkspaceRequestContext, reply: Parameters<typeof web.render>[0], extra: { inviteUrl?: string; errors?: string[] } = {}) {
    const ws = ctx.workspace;
    const [members, invites] = await Promise.all([listMembers(deps.db, ws.id), listInvites(deps.db, ws.id)]);
    const isOwner = ctx.role === 'owner';
    const num = (name: string, label: string, value: number, min: number, max: number, hint: string) => html`
      <div class="field"><label for="${name}">${label}</label><input id="${name}" type="number" name="${name}" value="${String(value)}" min="${String(min)}" max="${String(max)}" required><div class="hint">${hint}</div></div>`;
    const body = html`
      ${pageHead('Settings & admins', 'Workspace preferences, member limits and who can manage this workspace.')}
      ${extra.errors?.length ? alert('error', html`<p>${extra.errors.join(' ')}</p>`) : ''}
      <form method="post" action="${ctx.base}/settings" class="card">
        ${csrfField(ctx.csrf)}
        <div class="card-head"><h2>General</h2></div>
        <div class="field"><label for="name">Workspace name</label><input id="name" type="text" name="name" value="${ws.name}" required maxlength="80"></div>
        <div class="field"><label for="panel_title">Panel heading</label><input id="panel_title" type="text" name="panel_title" value="${ws.panel_title ?? ''}" maxlength="200" placeholder="${DEFAULT_PANEL_TITLE}"><div class="hint">Shown at the top of the ticket panel in Discord. Leave empty for the default.</div></div>
        <div class="field"><label for="panel_intro">Panel introduction</label><textarea id="panel_intro" name="panel_intro" maxlength="1500" placeholder="${DEFAULT_PANEL_INTRO}">${ws.panel_intro ?? ''}</textarea><div class="hint">After changing the panel text, update the panel from “Validate &amp; publish”.</div></div>
        <hr class="divider">
        <h2>Spam and duplicate protection</h2>
        <div class="grid grid-2">
          ${num('rate_limit_count', 'Tickets per person', ws.rate_limit_count, 1, 100, 'How many tickets one member can submit within the time window.')}
          ${num('rate_limit_window_minutes', 'Time window (minutes)', ws.rate_limit_window_minutes, 1, 1440, 'For example 5 tickets per 10 minutes.')}
          ${num('duplicate_window_minutes', 'Duplicate detection (minutes)', ws.duplicate_window_minutes, 0, 1440, 'Identical tickets from the same person within this time are not filed twice. 0 turns this off.')}
          ${num('retention_days', 'Keep ticket text for (days)', ws.retention_days, 1, 365, 'Copies of ticket text kept here for troubleshooting are deleted after this many days. Unresolved tickets are kept for at least 90 days.')}
        </div>
        ${button('Save settings', { variant: 'primary', loading: 'Saving…' })}
      </form>

      <div class="card">
        <div class="card-head"><h2>Admins</h2></div>
        <p class="muted small">Admins can manage the integration and see every submission. Owners can also invite and remove admins.</p>
        <div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>
          ${members.map((m) => {
            const avatar = discordAvatar(m);
            return html`<tr><td><div class="identity">${avatar ? html`<img class="avatar sm" src="${avatar}" alt="">` : ''}<div>${m.display_name ?? m.username}<div class="sub">@${m.username}</div></div></div></td>
              <td>${m.role === 'owner' ? badge('Owner', 'info') : badge('Admin', '')}</td><td class="nowrap">${formatDate(m.joined_at)}</td>
              <td>${isOwner && m.id !== ctx.user.id ? postButton(`${ctx.base}/settings/members/${m.id}/remove`, 'Remove', ctx.csrf, { variant: 'sm danger', confirm: `Remove ${m.display_name ?? m.username} from this workspace?` }) : ''}</td></tr>`;
          })}
        </tbody></table></div>
        ${isOwner ? html`<hr class="divider">
          <h3>Invite an admin</h3>
          <p class="muted small">Create a one-time link and send it to the person privately. It expires after 7 days. They sign in with Discord to accept it.</p>
          ${extra.inviteUrl ? html`<div class="alert success"><p><strong>Invitation link created.</strong> Copy it now; it will not be shown again.</p><div class="copy-field"><input id="invite-url" type="text" readonly value="${extra.inviteUrl}"><button type="button" class="btn" data-copy="invite-url">Copy</button></div></div>` : ''}
          ${postButton(`${ctx.base}/settings/invites`, 'Create invitation link', ctx.csrf)}
          ${invites.length ? html`<p class="small muted">Open invitations: ${invites.map((i) => html`<span class="nowrap">created ${timeAgo(i.created_at)} ${postButton(`${ctx.base}/settings/invites/${i.id}/revoke`, 'Revoke', ctx.csrf, { variant: 'sm' })}</span> `)}</p>` : ''}` : ''}
      </div>`;
    return web.render(reply, ctx, 'Settings', 'settings', body);
  }

  app.get('/w/:wid/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    return renderSettings(ctx, reply);
  });

  const settingsSchema = z.object({
    name: z.string().trim().min(1, 'Enter a workspace name.').max(80),
    panel_title: z.string().trim().max(200).optional().default(''),
    panel_intro: z.string().trim().max(1500).optional().default(''),
    rate_limit_count: z.coerce.number().int().min(1).max(100),
    rate_limit_window_minutes: z.coerce.number().int().min(1).max(1440),
    duplicate_window_minutes: z.coerce.number().int().min(0).max(1440),
    retention_days: z.coerce.number().int().min(1).max(365),
  });

  app.post('/w/:wid/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return renderSettings(ctx, reply.code(400), { errors: ['Please check the values: all numbers must be within the allowed ranges.'] });
    }
    const s = parsed.data;
    await updateWorkspaceSettings(deps.db, ctx.workspace.id, {
      name: s.name,
      panelTitle: s.panel_title || null,
      panelIntro: s.panel_intro || null,
      rateLimitCount: s.rate_limit_count,
      rateLimitWindowMinutes: s.rate_limit_window_minutes,
      duplicateWindowMinutes: s.duplicate_window_minutes,
      retentionDays: s.retention_days,
    });
    setFlash(reply, 'success', 'Settings saved.');
    return reply.redirect(`${ctx.base}/settings`);
  });

  app.post('/w/:wid/settings/invites', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { owner: true });
    if (!ctx) return reply;
    const token = await createInvite(deps.db, ctx.workspace.id, ctx.user.id);
    return renderSettings(ctx, reply, { inviteUrl: web.publicUrl(`/invite/${token}`) });
  });

  app.post('/w/:wid/settings/invites/:inviteId/revoke', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { owner: true });
    if (!ctx) return reply;
    await revokeInvite(deps.db, ctx.workspace.id, (req.params as { inviteId: string }).inviteId);
    setFlash(reply, 'success', 'Invitation revoked.');
    return reply.redirect(`${ctx.base}/settings`);
  });

  app.post('/w/:wid/settings/members/:userId/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { owner: true });
    if (!ctx) return reply;
    try {
      await removeMember(deps.db, ctx.workspace.id, (req.params as { userId: string }).userId);
      setFlash(reply, 'success', 'Admin removed.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/settings`);
  });

  // ---- Deployment / provider setup reference ---------------------------------------------------

  app.get('/w/:wid/provider-setup', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const c = deps.config;
    const url = (id: string, value: string) => html`<div class="copy-field"><input id="${id}" type="text" readonly value="${value}"><button type="button" class="btn" data-copy="${id}">Copy</button></div>`;
    const status = (missing: string[]) => (missing.length ? html`${badge('Incomplete', 'danger')} <span class="small muted">Missing: ${missing.join(', ')}</span>` : badge('Configured', 'ok'));
    const body = html`
      ${pageHead('Deployment setup', 'One-time provider registration that has to happen on GitHub and Discord themselves. Whoever operates this deployment does this once; day-to-day setup happens in the other pages.')}
      <div class="card">
        <div class="card-head"><h2>Discord application</h2>${status(c.missing.discord)}</div>
        <p class="muted small">In the Discord Developer Portal (Applications → your app):</p>
        <ol class="small">
          <li>General Information → <strong>Interactions Endpoint URL</strong>:</li>
        </ol>
        ${url('discord-interactions', web.publicUrl('/discord/interactions'))}
        <ol class="small" start="2"><li>OAuth2 → <strong>Redirects</strong>: add this URL (used for admin sign-in and for adding the bot):</li></ol>
        ${url('discord-redirect', web.publicUrl('/oauth/discord/callback'))}
        <ol class="small" start="3"><li>Bot → keep <strong>Public Bot</strong> off unless other workspaces on this deployment should add it. No privileged intents are needed.</li>
        <li>Server variables: <code>DISCORD_APPLICATION_ID</code>, <code>DISCORD_PUBLIC_KEY</code>, <code>DISCORD_CLIENT_SECRET</code>, <code>DISCORD_BOT_TOKEN</code>.</li></ol>
      </div>
      <div class="card">
        <div class="card-head"><h2>GitHub App</h2>${status(c.missing.github)}</div>
        <p class="muted small">In GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:</p>
        <ol class="small"><li><strong>Callback URL</strong> (must be the first callback URL), with “Request user authorization (OAuth) during installation” turned on:</li></ol>
        ${url('github-callback', web.publicUrl('/oauth/github/callback'))}
        <ol class="small" start="2"><li><strong>Webhook URL</strong> (optional but recommended, so uninstalls show up here immediately) with a webhook secret:</li></ol>
        ${url('github-webhook', web.publicUrl('/github/webhook'))}
        <ol class="small" start="3"><li>Repository permissions: <strong>Issues: Read and write</strong> and <strong>Metadata: Read-only</strong>. Nothing else. Subscribe to no extra events.</li>
        <li>Server variables: <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_SLUG</code>, <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, and optionally <code>GITHUB_WEBHOOK_SECRET</code> ${c.github?.webhookSecret ? badge('webhook on', 'ok') : badge('webhook off', '')}.</li></ol>
      </div>
      <p class="muted small">The full guide is in <code>docs/PROVIDER_SETUP.md</code> in the project repository. Secret values are never shown in this interface.</p>`;
    return web.render(reply, ctx, 'Deployment setup', 'provider', body);
  });
}

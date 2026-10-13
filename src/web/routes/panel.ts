import type { FastifyInstance } from 'fastify';
import { buildTicketModal, MORE_APPS_VALUE } from '../../discord/messages.js';
import { checkPanel, panelPayloadFor, publishPanel, unpublishPanel } from '../../domain/panel.js';
import { getApp, getDiscordConnection, getGitHubConnection, getPanel, listApps } from '../../domain/store.js';
import { acceptSubmission } from '../../domain/submissions.js';
import { UserFacingError } from '../../domain/types.js';
import { validateWorkspace } from '../../domain/validation.js';
import { escapeHtml, html, raw, type SafeHtml } from '../../lib/html.js';
import { alert, badge, button, csrfField, pageHead, postButton, timeAgo } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { enabledTicketTypes, getTicketType } from '../../domain/ticket-types.js';
import { ticketTypesCard } from './ticket-types.js';

/** Tiny Discord-markdown preview: escapes everything, then renders **bold** and line breaks. */
function discordMarkdown(text: string): SafeHtml {
  return raw(escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
}

export function registerPanelRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const [report, apps, panel, conn] = await Promise.all([
      validateWorkspace(deps, wid, b),
      listApps(deps.db, wid),
      getPanel(deps.db, wid),
      getDiscordConnection(deps.db, wid),
    ]);
    const state = await checkPanel(deps, wid, { live: false });
    const types = await enabledTicketTypes(deps.db, wid);
    const typesCard = await ticketTypesCard(deps, ctx);
    const { payload } = panelPayloadFor(ctx.workspace, apps, types.length > 0);
    const embed = payload.embeds[0]!;
    const options = payload.components[0]!.components[0]!.options;
    const enabledApps = apps.filter((a) => a.enabled);
    const sample = enabledApps[0];
    const firstType = types[0];
    const modal = sample
      ? buildTicketModal(
          { publicId: sample.public_id, name: sample.name, repoId: sample.repo_id, repoPrivate: sample.repo_private },
          firstType ? { publicId: firstType.public_id, name: firstType.name, guidance: firstType.guidance, placeholder: firstType.placeholder } : undefined,
        )
      : null;
    const errors = report.checks.filter((c) => c.status === 'error').length;
    const warnings = report.checks.filter((c) => c.status === 'warning').length;
    const messageLink = panel && conn ? `https://discord.com/channels/${conn.guild_id}/${panel.channel_id}/${panel.message_id}` : null;
    const publishLabel = state.state === 'published' ? (state.channelChanged ? 'Move panel to new channel' : 'Update panel') : state.state === 'missing' ? 'Publish panel again' : 'Publish panel';

    const body = html`
      ${pageHead('Step 4 · Validate & publish', 'Check that everything is connected, preview what members will see, then post the ticket panel in your Discord channel.')}

      <div class="card">
        <div class="card-head"><h2>Checks</h2>
          <div class="row">${errors ? badge(`${errors} problem${errors > 1 ? 's' : ''}`, 'danger') : badge('No problems', 'ok')}${warnings ? badge(`${warnings} note${warnings > 1 ? 's' : ''}`, 'warn') : ''}<a class="btn sm" href="${b}/panel">Check again</a></div></div>
        <ul class="checks">${report.checks.map((c) => html`<li>
          <span class="check-icon ${c.status}" aria-label="${c.status}">${c.status === 'ok' ? '✓' : '!'}</span>
          <div><div>${c.title}</div>${c.detail ? html`<div class="small muted">${c.detail}</div>` : ''}</div>
          <div>${c.fix && c.status !== 'ok' ? html`<a class="btn sm" href="${c.fix.href}">${c.fix.label}</a>` : ''}</div></li>`)}</ul>
      </div>

      <div class="card">
        <div class="card-head"><h2>Ticket panel</h2>
          ${state.state === 'published' ? (state.outdated || state.channelChanged ? badge('Out of date', 'warn') : badge('Published', 'ok')) : state.state === 'missing' ? badge('Deleted in Discord', 'danger') : badge('Not published', 'warn')}</div>
        ${panel ? html`<p class="small muted">Last published ${timeAgo(panel.published_at)}${conn?.tickets_channel_name && !(state.state === 'published' && state.channelChanged) ? ` in #${conn.tickets_channel_name}` : ''}. ${messageLink ? html`<a href="${messageLink}" target="_blank" rel="noopener noreferrer">Open in Discord</a>` : ''}</p>` : ''}
        ${!report.canPublish ? alert('info', 'Fix the problems above to publish the panel.') : ''}
        <div class="row">
          ${postButton(`${b}/panel/publish`, publishLabel, ctx.csrf, { variant: 'primary', loading: 'Publishing…', disabled: !report.canPublish, confirm: state.state === 'not_published' ? `Post the ticket panel in #${conn?.tickets_channel_name ?? 'the tickets channel'}? Everyone who can see that channel will see it.` : undefined })}
          ${panel ? postButton(`${b}/panel/remove`, 'Remove panel from Discord', ctx.csrf, { variant: 'danger', confirm: 'Remove the ticket panel message from Discord? Members will not be able to submit tickets until you publish it again.' }) : ''}
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h2>Preview: the panel</h2></div>
          <div class="discord-preview" aria-label="Preview of the Discord panel message">
            <div class="dp-msg"><div class="dp-avatar" aria-hidden="true">TR</div><div>
              <div><span class="dp-name">Ticket Relay</span><span class="dp-tag">APP</span></div>
              <div class="dp-embed"><h4>${embed.title}</h4><p>${discordMarkdown(embed.description)}</p></div>
              <div class="dp-select"><span>Choose an app…</span><span aria-hidden="true">▾</span></div>
              ${options.length ? html`<div class="dp-options">${options.map((o) => html`<div class="dp-option"><strong>${o.label}</strong>${'description' in o && o.description ? html`<span>${o.description}</span>` : ''}${o.value === MORE_APPS_VALUE ? html`<span>Opens a private, page-by-page list</span>` : ''}</div>`)}</div>` : html`<p class="small">No enabled apps yet.</p>`}
            </div></div>
          </div>
        </div>
        <div class="card"><div class="card-head"><h2>Preview: the form</h2></div>
          ${modal && types.length ? html`<div class="discord-preview">
              <p><strong>What kind of ticket is this?</strong></p>
              <div class="dp-options">${types.map((t) => html`<div class="dp-option"><strong>${t.name}</strong>${t.description ? html`<span>${t.description}</span>` : ''}</div>`)}</div>
            </div><p class="small muted">Then the form for the chosen type. Example for <strong>${firstType!.name}</strong>:</p>` : ''}
          ${modal ? html`<div class="discord-preview">
              <p><strong>${modal.title}</strong></p>
              <p>${discordMarkdown((modal.components[0] as { content: string }).content)}</p>
              <p><strong>Title</strong> <span class="muted">*</span><br><span class="small">A short summary of the problem.</span></p>
              <p><strong>Description</strong> <span class="muted">*</span><br><span class="small">Steps to reproduce, expected behavior and actual behavior.</span></p>
            </div>
            <p class="small muted">After submitting, the member gets a private confirmation with the app, ticket number and a link to the issue.</p>`
            : html`<p class="muted">Add an app to preview the form.</p>`}
        </div>
      </div>

      ${typesCard}

      <div class="card">
        <div class="card-head"><h2>Send a test ticket</h2></div>
        <p class="muted small">Creates a <strong>real GitHub issue</strong> through the full pipeline, marked as a test and attributed to you. Nothing is created unless you click the button.</p>
        ${enabledApps.length
          ? html`<form method="post" action="${b}/panel/test" class="row" data-confirm="Create a real test issue on GitHub now?">
              ${csrfField(ctx.csrf)}
              <label for="test-app" class="muted small">App</label>
              <select id="test-app" name="app_id" class="nowrap">${enabledApps.map((a) => html`<option value="${a.id}">${a.name} → ${a.repo_owner}/${a.repo_name}</option>`)}</select>
              ${types.length ? html`<select name="type_id" aria-label="Ticket type">${types.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select>` : ''}
              ${button('Send test ticket', { loading: 'Creating issue…' })}
            </form>`
          : html`<p class="muted">Add an app first.</p>`}
      </div>`;
    return web.render(reply, ctx, 'Validate & publish', 'panel', body);
  });

  app.post('/w/:wid/panel/publish', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    try {
      const result = await publishPanel(deps, ctx.workspace.id, ctx.user.id);
      const messages = {
        created: 'The ticket panel was posted in Discord.',
        updated: 'The ticket panel in Discord was updated.',
        recreated: 'The old panel had been deleted, so a new one was posted.',
        moved: 'The panel was posted in the new channel and removed from the old one.',
      };
      setFlash(reply, 'success', messages[result]);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/panel`);
  });

  app.post('/w/:wid/panel/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await unpublishPanel(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'The panel was removed from Discord.');
    return reply.redirect(`${ctx.base}/panel`);
  });

  app.post('/w/:wid/panel/test', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const target = await getApp(deps.db, ctx.workspace.id, String((req.body as { app_id?: string }).app_id ?? ''));
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!target || !gh || gh.status !== 'active' || !deps.github) {
      setFlash(reply, 'error', !target ? 'Choose an app.' : 'Connect GitHub first.');
      return reply.redirect(`${ctx.base}/panel`);
    }
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    const typeId = String((req.body as { type_id?: string }).type_id ?? '');
    const testType = typeId ? await getTicketType(deps.db, ctx.workspace.id, typeId) : null;
    const result = await acceptSubmission(deps, {
      workspace: ctx.workspace,
      app: target,
      installationId: gh.installation_id,
      source: 'admin_test',
      interactionId: null,
      interactionToken: null,
      guildId: conn?.guild_id ?? null,
      guildName: conn?.guild_name ?? null,
      channelId: null,
      reporter: { id: ctx.user.discord_user_id, displayName: ctx.user.display_name ?? ctx.user.username, username: ctx.user.username },
      ticketType: testType ? { name: testType.name, label: testType.label, titlePrefix: testType.title_prefix || testType.name } : null,
      title: 'Ticket Relay connection test',
      description: `This test ticket was sent by ${ctx.user.display_name ?? ctx.user.username} from the Ticket Relay admin interface to confirm that tickets for “${target.name}” reach this repository. You can close it.`,
    });
    if (result.kind !== 'accepted') throw new Error('unexpected test submission result');
    await web.processor.processNow(result.submission.id);
    setFlash(reply, 'info', 'Test ticket sent. The result is shown below.');
    return reply.redirect(`${ctx.base}/submissions/${result.submission.id}`);
  });
}

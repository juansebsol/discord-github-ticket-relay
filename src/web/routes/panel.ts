import type { FastifyInstance } from 'fastify';
import { buildTicketModal, DEFAULT_PANEL_INTRO, DEFAULT_PANEL_TITLE, MORE_APPS_VALUE } from '../../discord/messages.js';
import { inspectGuild } from '../../domain/discord-checks.js';
import { checkPanel, panelPayloadFor, publishPanel, unpublishPanel } from '../../domain/panel.js';
import { getApp, getDiscordConnection, getGitHubConnection, getPanel, listApps, setTicketsChannel } from '../../domain/store.js';
import { acceptSubmission } from '../../domain/submissions.js';
import { enabledTicketTypes, getTicketType } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { validateWorkspace, type Check } from '../../domain/validation.js';
import { updatePanelText } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { botIdentity, botMessage, discordMd, previewCaption, selectPreview } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { csrfField, icon, linkBtn, pill, selectWrap, setting, submitBtn, timeAgo, type IconName } from '../ui.js';
import { ticketsHeader } from './tickets.js';

const LIMITS = { panel_title: 200, panel_intro: 1500 } as const;

const CHECK_ICONS: Record<Check['status'], [IconName, string]> = { ok: ['circle-check', 'ok'], warning: ['triangle-alert', 'warn'], error: ['circle-x', 'danger'] };

/** Health checklist rows (Tickets › Panel, Contributor Roles › Panel). */
export function checklist(checks: { status: Check['status']; title: string; detail?: string; fix?: { label: string; href: string } }[]): SafeHtml {
  return html`<ul class="checklist">${checks.map((c) => {
    const [name, tone] = CHECK_ICONS[c.status];
    return html`<li class="check-row">${icon(name, 16, tone)}<span>${c.title}${c.detail ? html`<span class="detail"> · ${c.detail}</span>` : ''}</span>${c.fix && c.status !== 'ok' ? linkBtn(c.fix.href, c.fix.label, { variant: 'ghost', size: 'sm', trail: 'arrow-right' }) : html`<span></span>`}</li>`;
  })}</ul>`;
}

/** A labelled text field with a live character counter. */
export function textField(o: { id: string; name?: string; label: string; value: string; max: number; rows?: number; placeholder?: string; preview?: string; md?: boolean; hint?: string }): SafeHtml {
  const attrs = html`id="${o.id}" name="${o.name ?? o.id}" maxlength="${String(o.max)}" ${o.placeholder ? html`placeholder="${o.placeholder}"` : ''} ${o.preview ? html`data-preview="${o.preview}"` : ''} ${o.md ? raw('data-preview-md') : ''}`;
  return html`<div class="field"><div class="field-head"><label for="${o.id}">${o.label}</label><span class="counter" data-counter-for="${o.id}">${String(o.value.length)} / ${String(o.max)}</span></div>
    ${o.rows ? html`<textarea ${attrs} rows="${String(o.rows)}">${o.value}</textarea>` : html`<input type="text" class="full" ${attrs} value="${o.value}">`}
    ${o.hint ? html`<div class="hint">${o.hint}</div>` : ''}</div>`;
}

/** Saved panel text, or null when it matches the built-in default. */
function cleanText(value: unknown, max: number, fallback: string): string | null {
  const v = String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  return v && v !== fallback ? v : null;
}

export function registerPanelRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/panel', async (req, reply) => reply.redirect(`/w/${(req.params as { wid: string }).wid}/tickets/panel`));

  app.get('/w/:wid/tickets/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const ws = ctx.workspace;
    const [report, apps, panel, conn, types, bot] = await Promise.all([
      validateWorkspace(deps, wid, b),
      listApps(deps.db, wid),
      getPanel(deps.db, wid),
      getDiscordConnection(deps.db, wid),
      enabledTicketTypes(deps.db, wid),
      botIdentity(deps),
    ]);
    const state = await checkPanel(deps, wid, { live: false });
    const guild = deps.discord && conn && conn.status === 'active' ? await inspectGuild(deps.discord, conn.guild_id) : null;
    const { payload } = panelPayloadFor(ws, apps, types.length > 0);
    const options = payload.components[0]!.components[0]!.options;
    const enabledApps = apps.filter((a) => a.enabled);
    const title = ws.panel_title?.trim() || DEFAULT_PANEL_TITLE;
    const intro = ws.panel_intro?.trim() || DEFAULT_PANEL_INTRO;
    const rest = payload.embeds[0]!.description.slice(intro.length).replace(/^\n+/, '');
    const messageLink = panel && conn && state.state === 'published' ? `https://discord.com/channels/${conn.guild_id}/${panel.channel_id}/${panel.message_id}` : null;
    const channelName = conn?.tickets_channel_name ?? null;

    const strip =
      state.state === 'published'
        ? state.channelChanged
          ? html`${pill('Channel changed', 'warn')}<span class="small muted">Still posted in the old channel. Update the panel to move it to #${channelName ?? ''}.</span>`
          : state.outdated
            ? html`${pill('Out of date', 'warn')}<span class="small muted">The apps or text changed since it was posted ${timeAgo(panel!.published_at)}.</span>`
            : html`${pill('Published', 'ok')}<span class="small muted">in #${channelName ?? ''} · updated ${timeAgo(panel!.published_at)}</span>`
        : state.state === 'missing'
          ? html`${pill('Deleted in Discord', 'warn')}<span class="small muted">Someone deleted the panel message. Publish it again.</span>`
          : html`${pill('Not published', 'neutral')}<span class="small muted">${report.canPublish ? 'Ready to post.' : 'Fix the health checks below to publish.'}</span>`;
    const publishLabel = state.state === 'published' ? (state.channelChanged ? 'Move panel' : 'Update panel') : state.state === 'missing' ? 'Publish again' : 'Publish panel';

    const channelControl = !conn
      ? html`<span class="small muted">Connect Discord first.</span> ${linkBtn(`${b}/setup/discord`, 'Connect', { size: 'sm', trail: 'arrow-right', variant: 'ghost' })}`
      : guild?.ok
        ? selectWrap(html`<select id="channel" name="channel_id" aria-label="Tickets channel">
            ${conn.tickets_channel_id && !guild.channels.some((c) => c.id === conn.tickets_channel_id) ? html`<option value="" selected disabled>#${conn.tickets_channel_name ?? 'deleted channel'} (no longer available)</option>` : ''}
            ${conn.tickets_channel_id ? '' : html`<option value="" selected disabled>Choose a channel…</option>`}
            ${guild.channels.map((c) => html`<option value="${c.id}" ${c.id === conn.tickets_channel_id ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : c.category ? ` · ${c.category}` : ''}</option>`)}
          </select>`)
        : html`<span class="small muted">${guild && !guild.ok ? guild.message : 'Discord can’t be reached right now.'}</span>`;

    const firstType = types[0];
    const sample = enabledApps[0];
    const modal = sample
      ? buildTicketModal(
          { publicId: sample.public_id, name: sample.name, repoId: sample.repo_id, repoPrivate: sample.repo_private },
          firstType ? { publicId: firstType.public_id, name: firstType.name, guidance: firstType.guidance, placeholder: firstType.placeholder } : undefined,
        )
      : null;

    const body = html`
      ${await ticketsHeader(web, ctx, 'panel')}
      <div class="panel-grid">
        <form method="post" action="${b}/tickets/panel" class="card" data-dirty>
          ${csrfField(ctx.csrf)}
          <div class="card-h strip"><div class="row">${strip}</div></div>
          <div class="section" id="channel">
            ${setting('Channel', 'Where members open tickets. The bot needs to post there.', channelControl, { for: guild?.ok ? 'channel' : undefined, flat: true })}
          </div>
          <div class="section">
            <div class="section-h"><div><h3>Content</h3><div class="desc">The heading and introduction members see above the menu.</div></div>
              <button type="button" class="btn ghost sm" data-reset-fields="panel_title panel_intro"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button></div>
            <div class="fields">
              ${textField({ id: 'panel_title', label: 'Heading', value: title, max: LIMITS.panel_title, placeholder: DEFAULT_PANEL_TITLE, preview: 'pv-title' })}
              ${textField({ id: 'panel_intro', label: 'Introduction', value: intro, max: LIMITS.panel_intro, rows: 3, placeholder: DEFAULT_PANEL_INTRO, preview: 'pv-intro', md: true, hint: 'Discord formatting works, for example **bold**.' })}
            </div>
          </div>
          <div class="section">
            <div class="section-h"><div><h3>Health</h3><div class="desc">Checked live against GitHub and Discord when this page loads.</div></div>${linkBtn(`${b}/tickets/panel`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
            ${checklist(report.checks.filter((c) => c.area !== 'panel'))}
          </div>
          <div class="section">
            <div class="section-h"><div><h3>Test ticket</h3><div class="desc">Files a real GitHub issue through the whole pipeline, marked as a test and attributed to you.</div></div></div>
            ${enabledApps.length
              ? html`<div class="row">
                  ${selectWrap(html`<select name="app_id" form="test-form" aria-label="App for the test ticket">${enabledApps.map((a) => html`<option value="${a.id}">${a.name} · ${a.repo_owner}/${a.repo_name}</option>`)}</select>`)}
                  ${types.length ? selectWrap(html`<select name="type_id" form="test-form" aria-label="Ticket type">${types.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select>`) : ''}
                  ${submitBtn('Send test', { icon: 'send', loading: 'Creating issue…', form: 'test-form' })}</div>`
              : html`<p class="small muted">Add an app first.</p>`}
          </div>
          <div class="card-f">
            ${panel ? html`<button type="submit" class="btn ghost danger" form="remove-form"><span class="lead">${icon('trash-2')}</span><span class="lbl">Remove panel</span></button>` : html`<span></span>`}
            <div class="end">
              ${report.canPublish ? '' : html`<span class="small muted" data-clean-show>Fix the problems under Health to publish.</span>`}
              <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
              <button type="button" class="btn ghost" data-discard data-dirty-show hidden>Discard</button>
              ${report.canPublish
                ? submitBtn(publishLabel, { variant: 'primary', icon: 'send', loading: 'Publishing…', name: 'intent', value: 'publish' })
                : html`${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', name: 'intent', value: 'save', attrs: raw('data-dirty-enable') })}`}
            </div>
          </div>
        </form>

        <div class="panel-preview">
          ${previewCaption(channelName, messageLink)}
          ${botMessage(bot, html`
            <div class="dp-embed"><h4 id="pv-title">${title}</h4><p><span id="pv-intro">${discordMd(intro)}</span><br><br>${discordMd(rest)}</p></div>
            ${selectPreview('Choose an app…')}
            ${options.length ? html`<div class="dp-options">${options.map((o) => html`<div class="dp-option"><strong>${o.label}</strong>${'description' in o && o.description ? html`<span>${o.description}</span>` : ''}${o.value === MORE_APPS_VALUE ? html`<span>Opens a private, page-by-page list</span>` : ''}</div>`)}</div>` : ''}`, 'Preview of the ticket panel in Discord')}
          <p class="dp-note">${enabledApps.length ? `The menu lists your ${enabledApps.length} enabled app${enabledApps.length === 1 ? '' : 's'}.${types.length ? ' Members pick a ticket type next.' : ''}` : 'No enabled apps yet, so the menu is empty.'}</p>
          ${modal ? html`
            ${previewCaption(null, null, types.length ? 'Next steps · ' : 'Form · ')}
            <div class="dp">
              ${types.length ? html`<p class="dp-modal-title">What kind of ticket is this?</p>
                <div class="dp-options">${types.map((t) => html`<div class="dp-option"><strong>${t.name}</strong>${t.description ? html`<span>${t.description}</span>` : ''}</div>`)}</div><br>` : ''}
              <p class="dp-modal-title">${modal.title}</p>
              <p>${discordMd((modal.components[0] as { content: string }).content)}</p>
              <div class="dp-field"><div class="dp-l">Title *</div><div class="dp-input"></div></div>
              <div class="dp-field"><div class="dp-l">Description *</div><div class="dp-input tall"></div></div>
            </div>
            <p class="dp-note">${firstType ? `Form for “${firstType.name}”. ` : ''}After submitting, the member gets a private confirmation with the ticket number and a link to the issue.</p>` : ''}
        </div>
      </div>
      <form method="post" action="${b}/tickets/panel/test" id="test-form" hidden data-confirm-title="Send a test ticket?" data-confirm-body="This creates a real issue on GitHub, labelled as a test. You can close it afterwards." data-confirm-label="Send test">${csrfField(ctx.csrf)}</form>
      ${panel ? html`<form method="post" action="${b}/tickets/panel/remove" id="remove-form" hidden data-confirm-title="Remove the panel from #${channelName ?? 'the channel'}?" data-confirm-body="Members can’t open new tickets until you post it again. Existing tickets are kept." data-confirm-label="Remove panel" data-confirm-danger>${csrfField(ctx.csrf)}</form>` : ''}`;
    return web.render(reply, ctx, 'Ticket panel', 'tickets', body);
  });

  /** Saves the channel and text (fields left out stay unchanged), then publishes when asked to. */
  app.post('/w/:wid/tickets/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const back = `${ctx.base}/tickets/panel`;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const wid = ctx.workspace.id;
    try {
      if (body.panel_title !== undefined || body.panel_intro !== undefined) {
        await updatePanelText(deps.db, wid, {
          panelTitle: body.panel_title !== undefined ? cleanText(body.panel_title, LIMITS.panel_title, DEFAULT_PANEL_TITLE) : ctx.workspace.panel_title,
          panelIntro: body.panel_intro !== undefined ? cleanText(body.panel_intro, LIMITS.panel_intro, DEFAULT_PANEL_INTRO) : ctx.workspace.panel_intro,
        });
      }
      if (body.channel_id) {
        const conn = await getDiscordConnection(deps.db, wid);
        if (!deps.discord || !conn) throw new UserFacingError('Connect Discord first.');
        if (body.channel_id !== conn.tickets_channel_id) {
          const access = await inspectGuild(deps.discord, conn.guild_id);
          if (!access.ok) throw new UserFacingError(access.message);
          // Allowlist: the channel must belong to the connected server and be usable by the bot.
          const channel = access.channels.find((c) => c.id === body.channel_id);
          if (!channel) throw new UserFacingError('Choose one of the listed channels.');
          if (channel.missing.length) throw new UserFacingError(`The bot is missing permissions in #${channel.name}: ${channel.missing.join(', ')}.`);
          await setTicketsChannel(deps.db, wid, channel);
        }
      }
      if (body.intent === 'publish') {
        const result = await publishPanel(deps, wid, ctx.user.id);
        const conn = await getDiscordConnection(deps.db, wid);
        const where = conn?.tickets_channel_name ? ` in #${conn.tickets_channel_name}` : '';
        setFlash(reply, 'success', {
          created: `Panel posted${where}`,
          updated: `Panel updated${where}`,
          recreated: `The old panel was deleted, so a new one was posted${where}`,
          moved: `Panel moved${where}`,
        }[result]);
      } else {
        setFlash(reply, 'success', 'Changes saved. Publish the panel to show them in Discord.');
      }
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/tickets/panel/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await unpublishPanel(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'Panel removed from Discord');
    return reply.redirect(`${ctx.base}/tickets/panel`);
  });

  app.post('/w/:wid/tickets/panel/test', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const target = await getApp(deps.db, ctx.workspace.id, String((req.body as { app_id?: string }).app_id ?? ''));
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!target || !gh || gh.status !== 'active' || !deps.github) {
      setFlash(reply, 'error', !target ? 'Choose an app.' : 'Connect GitHub first.');
      return reply.redirect(`${ctx.base}/tickets/panel`);
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
    setFlash(reply, 'info', 'Test ticket sent. Here’s how it went.');
    return reply.redirect(`${ctx.base}/tickets/${result.submission.id}`);
  });
}

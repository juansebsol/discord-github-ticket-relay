import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DiscordGuildSummary } from '../../discord/client.js';
import { canManageGuild, REQUIRED_CHANNEL_PERMISSIONS } from '../../discord/permissions.js';
import { inspectGuild } from '../../domain/discord-checks.js';
import { unpublishPanel } from '../../domain/panel.js';
import { deleteDiscordConnection, getDiscordConnection, saveDiscordGuild, setTicketsChannel } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { alert, badge, button, csrfField, pageHead, postButton } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';

function guildIcon(g: { id: string; icon: string | null }): string | null {
  return g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null;
}

export function registerDiscordRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  /** Servers the signed-in admin can manage, using the token from their Discord sign-in. */
  async function manageableGuilds(req: FastifyRequest): Promise<DiscordGuildSummary[] | null> {
    const s = req.auth!.session;
    if (!deps.discord || !s.discord_access_token_enc || !s.discord_token_expires_at || s.discord_token_expires_at < new Date()) return null;
    try {
      const guilds = await deps.discord.listUserGuilds(deps.box.decrypt(s.discord_access_token_enc));
      return guilds.filter(canManageGuild);
    } catch {
      return null;
    }
  }

  app.get('/w/:wid/setup/discord', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const b = ctx.base;
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    const changing = (req.query as { change?: string }).change === '1';

    // ---- Server picker
    let serverSection = html``;
    if (deps.discord && (!conn || changing)) {
      const [mine, botGuilds] = await Promise.all([manageableGuilds(req), deps.discord.listBotGuilds().catch(() => null)]);
      const botIn = new Set((botGuilds ?? []).map((g) => g.id));
      let claimed = new Set<string>();
      if (mine?.length) {
        const { rows } = await deps.db.query<{ guild_id: string }>(
          'SELECT guild_id FROM discord_connections WHERE guild_id IN (SELECT value FROM json_each($1)) AND workspace_id <> $2',
          [mine.map((g) => g.id), ctx.workspace.id],
        );
        claimed = new Set(rows.map((r) => r.guild_id));
      }
      serverSection = html`<div class="card">
        <div class="card-head"><h2>Choose your Discord server</h2>${changing && conn ? html`<a class="btn sm" href="${b}/setup/discord">Cancel</a>` : ''}</div>
        <p class="muted small">You need the <strong>Manage Server</strong> permission on the server. Adding the bot opens Discord, where you confirm the server and the bot’s permissions (${REQUIRED_CHANNEL_PERMISSIONS.map((p) => p.name).join(', ')}).</p>
        ${mine === null
          ? html`<p class="muted small">Your server list is not available right now (sign out and in again to refresh it). You can still add the bot and pick the server in Discord.</p>`
          : mine.length === 0
            ? html`<div class="empty"><h3>No servers found</h3><p>You don’t manage any Discord servers with this account. Ask a server admin to sign in here, or add the bot directly.</p></div>`
            : html`<div class="table-wrap"><table><tbody>${mine.map((g) => {
                const icon = guildIcon(g);
                const action = claimed.has(g.id)
                  ? badge('Used by another workspace', '')
                  : botIn.has(g.id)
                    ? postButton(`${b}/setup/discord/server`, 'Use this server', ctx.csrf, { variant: 'primary sm', fields: { guild_id: g.id } })
                    : postButton(`${b}/setup/discord/install`, 'Add bot', ctx.csrf, { variant: 'discord sm', fields: { guild_id: g.id } });
                return html`<tr><td><div class="identity">${icon ? html`<img class="avatar square" src="${icon}" alt="">` : html`<span class="avatar square"></span>`}<div><strong>${g.name}</strong><div class="sub">${botIn.has(g.id) ? 'Bot already added' : 'Bot not added yet'}</div></div></div></td><td class="nowrap">${action}</td></tr>`;
              })}</tbody></table></div>`}
        <hr class="divider">
        ${postButton(`${b}/setup/discord/install`, 'Add the bot to a server…', ctx.csrf, { variant: 'discord' })}
      </div>`;
    }

    // ---- Channel picker for the connected server
    let channelSection = html``;
    if (deps.discord && conn && !changing) {
      const access = await inspectGuild(deps.discord, conn.guild_id);
      if (!access.ok) {
        channelSection = html`<div class="card">${alert('error', html`<p><strong>${access.message}</strong></p>`)}
          ${access.reason === 'bot_not_in_guild' ? postButton(`${b}/setup/discord/install`, 'Add the bot again', ctx.csrf, { variant: 'discord', fields: { guild_id: conn.guild_id } }) : html`<a class="btn" href="${b}/setup/discord">Try again</a>`}</div>`;
      } else {
        const current = access.channels.find((c) => c.id === conn.tickets_channel_id);
        channelSection = html`<form method="post" action="${b}/setup/discord/channel" class="card">
          ${csrfField(ctx.csrf)}
          <div class="card-head"><h2>Tickets channel</h2>${current ? (current.missing.length ? badge('Missing permissions', 'danger') : badge(`#${current.name}`, 'ok')) : badge('Not chosen', 'warn')}</div>
          <p class="muted small">The ticket panel is posted in this channel. Members need to be able to see it; the bot needs ${REQUIRED_CHANNEL_PERMISSIONS.map((p) => p.name).join(', ')} there.</p>
          ${conn.tickets_channel_id && !current ? alert('error', `The previously selected channel #${conn.tickets_channel_name ?? ''} no longer exists or the bot can’t see it. Choose another channel.`) : ''}
          ${access.channels.length === 0
            ? html`<div class="empty"><h3>No text channels visible</h3><p>Create a text channel (for example #tickets) and make sure the bot’s role can view it, then reload.</p></div>`
            : html`<div class="table-wrap"><table><thead><tr><th></th><th>Channel</th><th>Bot permissions</th></tr></thead><tbody>
                ${access.channels.map((c) => html`<tr>
                  <td><input type="radio" name="channel_id" value="${c.id}" id="ch-${c.id}" ${c.id === conn.tickets_channel_id ? raw('checked') : ''} ${c.missing.length ? raw('disabled') : ''} aria-label="#${c.name}"></td>
                  <td><label for="ch-${c.id}" class="checkbox">#${c.name}</label>${c.category ? html`<div class="sub">${c.category}</div>` : ''}</td>
                  <td>${c.missing.length ? html`${badge('Missing', 'danger')} <span class="small muted">${c.missing.join(', ')}</span>` : badge('Ready', 'ok')}</td></tr>`)}
              </tbody></table></div>
              <p class="small muted">Channels where the bot is missing permissions can’t be selected. Fix them in Discord (channel settings → Permissions → the bot’s role), then reload this page.</p>
              ${button('Save channel', { variant: 'primary', loading: 'Checking…' })}`}
        </form>`;
      }
    }

    const body = html`
      ${pageHead('Step 2 · Connect Discord', 'Add the Ticket Relay bot to your Discord server and choose the channel where members will find the ticket panel.')}
      ${!deps.discord ? alert('warn', html`<p><strong>The Discord application has not been registered for this deployment yet.</strong> Whoever runs the server needs to complete the <a href="${b}/provider-setup">deployment setup</a> first.</p>`) : ''}
      <p class="muted small">Each workspace connects one Discord server, and a server can only be connected to one workspace.</p>
      ${conn && !changing
        ? html`<div class="card"><div class="card-head"><h2>Server</h2>${badge(conn.status === 'active' ? 'Connected' : 'Disconnected', conn.status === 'active' ? 'ok' : 'danger')}</div>
            <div class="identity">${guildIcon({ id: conn.guild_id, icon: conn.guild_icon }) ? html`<img class="avatar square" src="${guildIcon({ id: conn.guild_id, icon: conn.guild_icon })!}" alt="">` : ''}<div><strong>${conn.guild_name}</strong></div></div>
            ${conn.status_detail ? alert('error', conn.status_detail) : ''}
            <hr class="divider"><div class="row">
              <a class="btn" href="${b}/setup/discord?change=1">Change server</a>
              ${postButton(`${b}/setup/discord/disconnect`, 'Disconnect', ctx.csrf, { variant: 'danger', confirm: 'Disconnect this Discord server? The ticket panel will be removed from the channel and members won’t be able to submit tickets. History is kept.' })}
            </div></div>`
        : ''}
      ${serverSection}
      ${channelSection}`;
    return web.render(reply, ctx, 'Connect Discord', 'discord', body);
  });

  app.post('/w/:wid/setup/discord/server', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    if (!deps.discord) return reply.redirect(`${ctx.base}/setup/discord`);
    const guildId = String((req.body as { guild_id?: string }).guild_id ?? '');
    const back = `${ctx.base}/setup/discord`;
    try {
      const mine = await manageableGuilds(req);
      // Server-side checks: the admin manages this server and the bot is in it.
      if (!mine?.some((g) => g.id === guildId)) throw new UserFacingError('You need the Manage Server permission on that server (sign out and in again if you just got it).');
      const access = await inspectGuild(deps.discord, guildId);
      if (!access.ok) throw new UserFacingError(access.message);
      await saveDiscordGuild(deps.db, ctx.workspace.id, access.guild, ctx.user.id);
      setFlash(reply, 'success', `Connected to “${access.guild.name}”. Now choose the tickets channel.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/setup/discord/channel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    if (!deps.discord) return reply.redirect(`${ctx.base}/setup/discord`);
    const back = `${ctx.base}/setup/discord`;
    const channelId = String((req.body as { channel_id?: string }).channel_id ?? '');
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    if (!conn) return reply.redirect(back);
    const access = await inspectGuild(deps.discord, conn.guild_id);
    if (!access.ok) {
      setFlash(reply, 'error', access.message);
      return reply.redirect(back);
    }
    // Allowlist: the channel must belong to the connected server.
    const channel = access.channels.find((c) => c.id === channelId);
    if (!channel) {
      setFlash(reply, 'error', 'Choose one of the listed channels.');
      return reply.redirect(back);
    }
    if (channel.missing.length) {
      setFlash(reply, 'error', `The bot is missing permissions in #${channel.name}: ${channel.missing.join(', ')}.`);
      return reply.redirect(back);
    }
    await setTicketsChannel(deps.db, ctx.workspace.id, channel);
    setFlash(reply, 'success', `Tickets channel set to #${channel.name}.`);
    return reply.redirect(back);
  });

  app.post('/w/:wid/setup/discord/disconnect', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await unpublishPanel(deps, ctx.workspace.id);
    await deleteDiscordConnection(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'Discord was disconnected and the panel removed. You can also kick the bot from the server in Discord.');
    return reply.redirect(`${ctx.base}/setup/discord`);
  });
}

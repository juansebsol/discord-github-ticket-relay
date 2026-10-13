import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DiscordApiError } from '../../discord/client.js';
import { BOT_INSTALL_PERMISSIONS } from '../../discord/permissions.js';
import { can } from '../../domain/permissions.js';
import { consumeState, createState } from '../../domain/oauth-state.js';
import { saveDiscordGuild } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import {
  acceptInvite,
  canCreateWorkspace,
  createWorkspace,
  findInvite,
  getMembership,
  listMemberships,
  upsertUser,
} from '../../domain/workspaces.js';
import { randomToken, safeEqual, sha256 } from '../../lib/crypto.js';
import { html } from '../../lib/html.js';
import { ROLE_LABELS } from '../../domain/permissions.js';
import { simplePage } from '../layout.js';
import { csrfField, icon, initials, linkBtn, notice, submitBtn } from '../ui.js';
import { createSession, destroySession, setFlash, setSessionCookie } from '../session.js';
import type { Web } from '../server.js';

const NONCE_COOKIE = 'tr_oauth_nonce';

function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
}

export function registerAuthRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const discordRedirect = web.publicUrl('/oauth/discord/callback');

  app.get('/', async (req, reply) => {
    if (!req.auth) return reply.redirect('/login');
    const memberships = await listMemberships(deps.db, req.auth.user.id);
    return reply.redirect(memberships.length === 1 ? `/w/${memberships[0]!.workspace.id}` : '/workspaces');
  });

  app.get('/login', async (req, reply) => {
    const next = safeNext((req.query as { next?: string }).next);
    if (req.auth) return reply.redirect(next);
    const error = (req.query as { error?: string }).error;
    const body = html`
      <div><h1>Sign in</h1><p class="muted small">Owners, admins and moderators sign in with Discord. Members who open tickets never need to sign in here.</p></div>
      ${error ? notice('danger', null, error) : ''}
      ${deps.discord
        ? linkBtn(`/auth/discord?next=${encodeURIComponent(next)}`, 'Sign in with Discord', { variant: 'primary', size: 'lg', block: true, icon: 'message-circle' })
        : notice('warn', 'Sign-in isn’t available yet', html`The Discord application credentials aren’t configured on this deployment (${deps.config.missing.discord.join(', ')}). See <code>docs/PROVIDER_SETUP.md</code>.`)}
      ${deps.config.devLogin
        ? html`<hr><form method="post" action="/dev-login" class="fields"><p class="xs muted">Local development sign-in (disabled in production).</p>
            <div class="field"><label for="dev-name">Name</label><input id="dev-name" type="text" class="full" name="name" value="Local Admin" required maxlength="40"></div>
            ${submitBtn('Continue as local admin', { block: true })}</form>`
        : ''}`;
    return reply.type('text/html').send(simplePage('Sign in', body));
  });

  app.get('/auth/discord', async (req, reply) => {
    if (!deps.discord) return reply.redirect('/login');
    const nonce = randomToken(16);
    const state = await createState(deps.db, 'discord_login', null, null, {
      next: safeNext((req.query as { next?: string }).next),
      nonce: sha256(nonce),
    });
    reply.setCookie(NONCE_COOKIE, nonce, { path: '/oauth', httpOnly: true, sameSite: 'lax', secure: web.secureCookies, maxAge: 900 });
    return reply.redirect(deps.discord.loginUrl(state, discordRedirect));
  });

  /** Single Discord redirect URI for both admin sign-in and bot installation. */
  app.get('/oauth/discord/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const state = await consumeState(deps.db, q.state, ['discord_login', 'discord_bot']);
    if (!state || !deps.discord) {
      return reply.redirect(`/login?error=${encodeURIComponent('That sign-in link expired or was already used. Please try again.')}`);
    }

    if (state.purpose === 'discord_login') {
      const nonce = req.cookies[NONCE_COOKIE];
      reply.clearCookie(NONCE_COOKIE, { path: '/oauth' });
      if (!nonce || !safeEqual(sha256(nonce), String(state.data.nonce))) {
        return reply.redirect(`/login?error=${encodeURIComponent('Sign-in could not be verified. Please try again from this browser.')}`);
      }
      if (q.error || !q.code) return reply.redirect(`/login?error=${encodeURIComponent('Sign-in was cancelled.')}`);
      try {
        const token = await deps.discord.exchangeCode(q.code, discordRedirect);
        const me = await deps.discord.getCurrentUser(token.accessToken);
        const user = await upsertUser(deps.db, {
          discordUserId: me.id,
          username: me.username,
          displayName: me.global_name ?? null,
          avatar: me.avatar ?? null,
        });
        const { token: sessionToken } = await createSession(deps.db, user.id, {
          enc: deps.box.encrypt(token.accessToken),
          expiresAt: new Date(Date.now() + Math.max(60, token.expiresIn - 60) * 1000),
        });
        setSessionCookie(reply, sessionToken, web.secureCookies);
        deps.log.info({ user: user.id }, 'admin signed in');
        return reply.redirect(safeNext(state.data.next));
      } catch (err) {
        deps.log.warn({ err: err instanceof DiscordApiError ? err.status : (err as Error).message }, 'discord sign-in failed');
        return reply.redirect(`/login?error=${encodeURIComponent('Discord sign-in failed. Please try again.')}`);
      }
    }

    // Bot installation: bind the server to the workspace that started the flow.
    const wid = state.workspace_id!;
    const back = `/w/${wid}/setup/discord`;
    const botMember = req.auth ? await getMembership(deps.db, req.auth.user.id, wid) : null;
    if (!req.auth || req.auth.session.id !== state.session_id || !botMember || !can(botMember, 'manage')) {
      return reply.redirect('/login');
    }
    if (q.error || !q.code) {
      setFlash(reply, 'error', 'The bot was not added. You can try again whenever you are ready.');
      return reply.redirect(back);
    }
    try {
      // The guild comes from Discord's token response, not the (spoofable) redirect parameters.
      const token = await deps.discord.exchangeCode(q.code, discordRedirect);
      if (!token.guild) throw new UserFacingError('Discord did not report which server the bot was added to. Please try again.');
      await saveDiscordGuild(deps.db, wid, token.guild, req.auth.user.id);
      setFlash(reply, 'success', `The bot was added to “${token.guild.name}”. Choose the tickets channel on the Tickets › Panel tab.`);
    } catch (err) {
      setFlash(reply, 'error', err instanceof UserFacingError ? err.message : 'Could not complete the bot installation. Please try again.');
      deps.log.warn({ err: (err as Error).message }, 'bot installation callback failed');
    }
    return reply.redirect(back);
  });

  app.post('/logout', async (req, reply) => {
    if (req.auth) await destroySession(deps.db, req.auth.session.id);
    reply.clearCookie('tr_session', { path: '/' });
    return reply.redirect('/login');
  });

  if (deps.config.devLogin) {
    app.post('/dev-login', async (req, reply) => {
      const name = z.string().trim().min(1).max(40).parse((req.body as { name?: string }).name);
      const user = await upsertUser(deps.db, { discordUserId: `dev-${sha256(name).slice(0, 12)}`, username: name.toLowerCase().replace(/\s+/g, '_'), displayName: name, avatar: null });
      const { token } = await createSession(deps.db, user.id, null);
      setSessionCookie(reply, token, web.secureCookies);
      return reply.redirect('/');
    });
  }

  // ---- Workspaces ---------------------------------------------------------------------------

  app.get('/workspaces', async (req, reply) => {
    const auth = web.requireUser(req, reply);
    if (!auth) return reply;
    const ctx = web.pageContext(req, reply);
    const memberships = await listMemberships(deps.db, auth.user.id);
    const mayCreate = await canCreateWorkspace(deps.db, deps.config, auth.user);
    const body = html`
      <h1>Your workspaces</h1>
      ${ctx.flash?.type === 'error' ? notice('danger', null, ctx.flash.message) : ''}
      ${memberships.length
        ? html`<div class="ws-list">${memberships.map((m) => html`<a href="/w/${m.workspace.id}"><span class="ws-tile" aria-hidden="true">${initials(m.workspace.name, 2)}</span><span class="grow"><span class="name">${m.workspace.name}</span><span class="sub">${ROLE_LABELS[m.role]}</span></span>${icon('chevron-right')}</a>`)}</div>`
        : html`<p class="muted small">You’re not a member of any workspace yet.</p>`}
      ${mayCreate
        ? html`<form method="post" action="/workspaces" class="fields">${csrfField(ctx.csrf)}
            <div class="field"><label for="ws-name">Create a workspace</label>
            <input id="ws-name" type="text" class="full" name="name" placeholder="Acme Support" required maxlength="80">
            <div class="hint">A workspace holds one GitHub connection, one Discord server and its apps.</div></div>
            ${submitBtn('Create workspace', { variant: 'primary', block: true, icon: 'plus' })}</form>`
        : html`<p class="muted small">To get access, ask the owner of an existing workspace for an invitation link.</p>`}
      <hr><form method="post" action="/logout" class="spread">${csrfField(ctx.csrf)}<span class="small muted">Signed in as ${auth.user.display_name ?? auth.user.username}</span>${submitBtn('Sign out', { variant: 'ghost muted', size: 'sm', icon: 'log-out' })}</form>`;
    return reply.type('text/html').send(simplePage('Workspaces', body, { flash: ctx.flash }));
  });

  app.post('/workspaces', async (req, reply) => {
    const auth = web.requireUser(req, reply);
    if (!auth) return reply;
    const parsed = z.string().trim().min(1).max(80).safeParse((req.body as { name?: string }).name);
    if (!parsed.success) {
      setFlash(reply, 'error', 'Enter a workspace name (up to 80 characters).');
      return reply.redirect('/workspaces');
    }
    const ws = await createWorkspace(deps.db, deps.config, auth.user, parsed.data);
    return reply.redirect(`/w/${ws.id}`);
  });

  app.get('/invite/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    if (!req.auth) return reply.redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
    const invite = await findInvite(deps.db, token);
    const ctx = web.pageContext(req, reply);
    const body = invite
      ? html`<div><h1>Join ${invite.workspace_name}</h1>
          <p class="muted small">You were invited as ${invite.role === 'moderator' ? 'a moderator. You’ll see the tickets inbox; an admin decides what else you can do.' : 'an admin. You’ll be able to manage the whole integration.'}</p></div>
          <form method="post" action="/invite/${token}">${csrfField(ctx.csrf)}${submitBtn('Accept invitation', { variant: 'primary', block: true })}</form>`
      : html`<div><h1>Invitation unavailable</h1><p class="muted small">This invitation link is invalid, expired or has already been used. Ask the workspace owner for a new one.</p></div>${linkBtn('/', 'Back to the console', { block: true })}`;
    return reply.type('text/html').send(simplePage('Invitation', body));
  });

  app.post('/invite/:token', async (req, reply) => {
    const auth = web.requireUser(req, reply);
    if (!auth) return reply;
    const wid = await acceptInvite(deps.db, (req.params as { token: string }).token, auth.user.id);
    setFlash(reply, 'success', 'Welcome. You now have access to this workspace.');
    return reply.redirect(`/w/${wid}`);
  });

  // Bot installation start (lives here because it shares the Discord redirect URI).
  app.post('/w/:wid/setup/discord/install', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    if (!deps.discord) return reply.redirect(`${ctx.base}/setup/discord`);
    const guildId = (req.body as { guild_id?: string }).guild_id;
    const state = await createState(deps.db, 'discord_bot', req.auth!.session.id, ctx.workspace.id);
    return reply.redirect(deps.discord.botInstallUrl(state, discordRedirect, BOT_INSTALL_PERMISSIONS, guildId && /^\d{5,25}$/.test(guildId) ? guildId : undefined));
  });
}

import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createState } from '../src/domain/oauth-state.js';
import { getDiscordConnection, getGitHubConnection, getPanel, listApps } from '../src/domain/store.js';
import { createInvite, createWorkspace } from '../src/domain/workspaces.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testConfig, testDb, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  await resetDb();
  env = await makeApp();
});
afterAll(async () => {
  await testDb().end();
});

describe('admin authorization and workspace isolation', () => {
  it('requires sign-in for every admin page', async () => {
    const ws = await makeWorkspace(env);
    for (const url of ['/workspaces', `/w/${ws.workspace.id}`, `/w/${ws.workspace.id}/apps`, `/w/${ws.workspace.id}/submissions`]) {
      const res = await env.server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
  });

  it('hides other workspaces entirely (404, not 403)', async () => {
    const a = await makeWorkspace(env);
    const b = await makeWorkspace(env);
    const pages = ['', '/apps', '/settings', '/submissions', '/panel', '/setup/github', '/setup/discord', `/apps/${b.apps[0]!.id}/edit`];
    for (const p of pages) {
      const res = await env.server.inject({ method: 'GET', url: `/w/${b.workspace.id}${p}`, ...get(a.owner) });
      expect(res.statusCode, p).toBe(404);
    }
    // Cross-workspace object access via the attacker's own workspace URL also fails.
    const edit = await env.server.inject({ method: 'GET', url: `/w/${a.workspace.id}/apps/${b.apps[0]!.id}/edit`, ...get(a.owner) });
    expect(edit.statusCode).toBe(404);
    const del = await env.server.inject({ method: 'POST', url: `/w/${a.workspace.id}/apps/${b.apps[0]!.id}/delete`, ...form(a.owner) });
    expect(del.statusCode).toBe(404);
    expect(await listApps(env.db, b.workspace.id)).toHaveLength(1);
    const publish = await env.server.inject({ method: 'POST', url: `/w/${b.workspace.id}/panel/publish`, ...form(a.owner) });
    expect(publish.statusCode).toBe(404);
  });

  it('rejects state-changing requests without a valid CSRF token', async () => {
    const ws = await makeWorkspace(env);
    const res = await env.server.inject({
      method: 'POST',
      url: `/w/${ws.workspace.id}/apps/${ws.apps[0]!.id}/delete`,
      headers: { cookie: ws.owner.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '_csrf=wrong',
    });
    expect(res.statusCode).toBe(403);
    expect(await listApps(env.db, ws.workspace.id)).toHaveLength(1);
  });

  it('lets only owners manage admins; invitations grant admin access once', async () => {
    const ws = await makeWorkspace(env);
    const invitee = await makeAdmin(env, 'invitee');
    const token = await createInvite(env.db, ws.workspace.id, ws.owner.user.id);
    expect((await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}`, ...get(invitee) })).statusCode).toBe(404);
    const accept = await env.server.inject({ method: 'POST', url: `/invite/${token}`, ...form(invitee) });
    expect(accept.statusCode).toBe(302);
    expect((await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}`, ...get(invitee) })).statusCode).toBe(200);
    // Reusing the link fails.
    const intruder = await makeAdmin(env, 'intruder');
    expect((await env.server.inject({ method: 'POST', url: `/invite/${token}`, ...form(intruder) })).statusCode).toBe(404);
    // Admins (non-owners) can't invite or remove people.
    expect((await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/settings/invites`, ...form(invitee) })).statusCode).toBe(404);
    expect((await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/settings/members/${ws.owner.user.id}/remove`, ...form(invitee) })).statusCode).toBe(404);
  });

  it('restricts workspace creation to the first user or configured platform admins', async () => {
    const first = await makeAdmin(env);
    const second = await makeAdmin(env);
    expect((await env.server.inject({ method: 'POST', url: '/workspaces', ...form(first, { name: 'Acme' }) })).statusCode).toBe(302);
    const denied = await env.server.inject({ method: 'POST', url: '/workspaces', ...form(second, { name: 'Other' }) });
    expect(denied.statusCode).toBe(403);
    const cfg = testConfig({ PLATFORM_ADMIN_DISCORD_IDS: second.user.discord_user_id });
    await expect(createWorkspace(env.db, cfg, second.user, 'Allowed')).resolves.toMatchObject({ name: 'Allowed' });
    await expect(createWorkspace(env.db, cfg, first.user, 'Denied')).rejects.toThrow(/invitation/);
  });

  it('never renders credentials in pages', async () => {
    const ws = await makeWorkspace(env);
    for (const p of ['', '/provider-setup', '/setup/github', '/setup/discord', '/panel']) {
      const res = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}${p}`, ...get(ws.owner) });
      expect(res.statusCode, p).toBe(200);
      for (const secret of ['bot-token', 'discord-secret', 'gh-secret', 'webhook-secret', 'PRIVATE KEY']) expect(res.body, `${p} leaks ${secret}`).not.toContain(secret);
    }
  });
});

describe('integration configuration and validation', () => {
  it('only allows repositories the GitHub App can access, with Issues enabled and existing labels', async () => {
    const ws = await makeWorkspace(env, { apps: [] });
    env.github.addInstallation(9999, 'someone-else', [{ id: 4242, name: 'secret-repo' }]);
    const url = `/w/${ws.workspace.id}/apps`;
    const outside = await env.server.inject({ method: 'POST', url, ...form(ws.owner, { name: 'Sneaky', repo_id: '4242', enabled: '1' }) });
    expect(outside.statusCode).toBe(400);
    expect(outside.body).toContain('Choose a repository the GitHub App can access');

    env.github.repos.get(ws.repoIds[1]!)!.has_issues = false;
    const disabled = await env.server.inject({ method: 'POST', url, ...form(ws.owner, { name: 'Web', repo_id: String(ws.repoIds[1]), enabled: '1' }) });
    expect(disabled.body).toContain('Issues are disabled');

    const badLabel = await env.server.inject({ method: 'POST', url, ...form(ws.owner, { name: 'Mobile', repo_id: String(ws.repoIds[0]), labels: ['bug', 'nope'], enabled: '1' }) });
    expect(badLabel.body).toContain('don’t exist');

    const ok = await env.server.inject({ method: 'POST', url, ...form(ws.owner, { name: 'Mobile', description: 'Phones', repo_id: String(ws.repoIds[0]), labels: ['bug'], enabled: '1' }) });
    expect(ok.statusCode).toBe(302);
    const second = await env.server.inject({ method: 'POST', url, ...form(ws.owner, { name: 'Tablet', repo_id: String(ws.repoIds[0]), enabled: '1' }) });
    expect(second.statusCode).toBe(302); // two apps, one repository
    const dup = await env.server.inject({ method: 'POST', url, ...form(ws.owner, { name: 'mobile', repo_id: String(ws.repoIds[0]), enabled: '1' }) });
    expect(dup.body).toContain('already exists');
    const apps = await listApps(env.db, ws.workspace.id);
    expect(apps.map((a) => [a.name, a.labels])).toEqual([['Mobile', ['bug']], ['Tablet', []]]);

    const labels = await env.server.inject({ method: 'GET', url: `${url}/labels?repo=4242`, ...get(ws.owner) });
    expect(labels.statusCode).toBe(404);
  });

  it('validates channel choice against the connected server and the bot’s permissions', async () => {
    const ws = await makeWorkspace(env);
    const guild = env.discord.guilds.get(ws.guildId)!;
    guild.channels.push({ id: '777', type: 0, name: 'locked', position: 1, permission_overwrites: [{ id: `${ws.guildId}9`, type: 0, allow: '0', deny: String(1n << 11n) }] });
    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/setup/discord`, ...get(ws.owner) });
    expect(page.body).toContain('#locked');
    expect(page.body).toContain('Send Messages');

    const locked = await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/setup/discord/channel`, ...form(ws.owner, { channel_id: '777' }) });
    expect(locked.statusCode).toBe(302);
    expect((await getDiscordConnection(env.db, ws.workspace.id))!.tickets_channel_id).toBe(ws.channelId);
    const foreign = await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/setup/discord/channel`, ...form(ws.owner, { channel_id: '123456' }) });
    expect(foreign.statusCode).toBe(302);
    expect((await getDiscordConnection(env.db, ws.workspace.id))!.tickets_channel_id).toBe(ws.channelId);
  });

  it('reports actionable validation problems', async () => {
    const ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App', labels: ['bug'] }, { name: 'Website', repoIndex: 1 }] });
    env.github.repos.get(ws.repoIds[1]!)!.has_issues = false;
    env.github.repos.get(ws.repoIds[0]!)!.labels = [];
    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/panel`, ...get(ws.owner) });
    expect(page.body).toContain('Website: Issues are disabled');
    expect(page.body).toContain('label bug no longer exists');
    expect(page.body).toContain('The ticket panel has not been published yet');
    expect(page.body).toMatch(/<button type="submit" class="btn primary"[^>]*disabled/);

    env.discord.botGuildIds.delete(ws.guildId);
    const removed = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/panel`, ...get(ws.owner) });
    expect(removed.body).toContain('The bot is not in this Discord server');
    expect((await getDiscordConnection(env.db, ws.workspace.id))!.status).toBe('removed');
  });

  it('binds the bot to the server reported by Discord’s token response and validates state', async () => {
    const owner = await makeAdmin(env);
    const ws = await createWorkspace(env.db, { ...env.deps.config, openWorkspaceCreation: true }, owner.user, 'WS');
    env.discord.addGuild('600000000000000001', 'Real Guild', [{ id: '600000000000000002', type: 0, name: 'tickets', position: 0 }]);
    env.discord.codes.set('bot-code', { access_token: 'x', expires_in: 600, scope: 'bot identify', guild: { id: '600000000000000001', name: 'Real Guild', icon: null } });
    const sid = (await env.db.query('SELECT id FROM sessions WHERE user_id = $1', [owner.user.id])).rows[0].id;

    // Wrong/missing state is rejected.
    const bad = await env.server.inject({ method: 'GET', url: '/oauth/discord/callback?code=bot-code&state=forged&guild_id=1', ...get(owner) });
    expect(bad.headers.location).toMatch(/^\/login\?error=/);

    // A state created for another session can't be used.
    const other = await makeAdmin(env);
    const stolen = await createState(env.db, 'discord_bot', sid, ws.id);
    const res1 = await env.server.inject({ method: 'GET', url: `/oauth/discord/callback?code=bot-code&state=${stolen}`, ...get(other) });
    expect(res1.headers.location).toBe('/login');
    expect(await getDiscordConnection(env.db, ws.id)).toBeNull();

    const state = await createState(env.db, 'discord_bot', sid, ws.id);
    const ok = await env.server.inject({ method: 'GET', url: `/oauth/discord/callback?code=bot-code&state=${state}&guild_id=999`, ...get(owner) });
    expect(ok.headers.location).toBe(`/w/${ws.id}/setup/discord`);
    expect((await getDiscordConnection(env.db, ws.id))!.guild_id).toBe('600000000000000001'); // not the spoofed 999

    // States are single-use.
    const replay = await env.server.inject({ method: 'GET', url: `/oauth/discord/callback?code=bot-code&state=${state}`, ...get(owner) });
    expect(replay.headers.location).toMatch(/^\/login\?error=/);
  });

  it('refuses to connect a Discord server that belongs to another workspace', async () => {
    const a = await makeWorkspace(env);
    const owner = await makeAdmin(env);
    const ws = await createWorkspace(env.db, { ...env.deps.config, openWorkspaceCreation: true }, owner.user, 'WS2');
    env.discord.codes.set('steal', { access_token: 'x', expires_in: 600, scope: 'bot identify', guild: { id: a.guildId, name: 'Guild', icon: null } });
    const sid = (await env.db.query('SELECT id FROM sessions WHERE user_id = $1', [owner.user.id])).rows[0].id;
    const state = await createState(env.db, 'discord_bot', sid, ws.id);
    await env.server.inject({ method: 'GET', url: `/oauth/discord/callback?code=steal&state=${state}`, ...get(owner) });
    expect(await getDiscordConnection(env.db, ws.id)).toBeNull();
    expect((await getDiscordConnection(env.db, a.workspace.id))!.guild_id).toBe(a.guildId);
  });

  it('accepts only GitHub installations the authorizing user can access', async () => {
    const owner = await makeAdmin(env);
    const ws = await createWorkspace(env.db, { ...env.deps.config, openWorkspaceCreation: true }, owner.user, 'WS');
    env.github.addInstallation(111, 'mine', [{ id: 1, name: 'a' }]);
    env.github.addInstallation(222, 'victim', [{ id: 2, name: 'b' }]);
    env.github.userInstallationIds = [111];
    const sid = (await env.db.query('SELECT id FROM sessions WHERE user_id = $1', [owner.user.id])).rows[0].id;

    const spoof = await createState(env.db, 'github_install', sid, ws.id, { mode: 'install' });
    await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&installation_id=222&setup_action=install&state=${spoof}`, ...get(owner) });
    expect(await getGitHubConnection(env.db, ws.id)).toBeNull();

    const real = await createState(env.db, 'github_install', sid, ws.id, { mode: 'install' });
    const res = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&installation_id=111&setup_action=install&state=${real}`, ...get(owner) });
    expect(res.headers.location).toBe(`/w/${ws.id}/setup/github`);
    expect(await getGitHubConnection(env.db, ws.id)).toMatchObject({ installation_id: 111, account_login: 'mine', status: 'active' });

    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.id}/setup/github`, ...get(owner) });
    expect(page.body).toContain('mine/a');
    expect(page.body).not.toContain('victim/b');
  });

  it('updates connection status from signed GitHub webhooks only', async () => {
    const ws = await makeWorkspace(env);
    const payload = JSON.stringify({ action: 'deleted', installation: { id: ws.installationId, account: { login: 'org' } } });
    const unsigned = await env.server.inject({ method: 'POST', url: '/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'installation', 'x-hub-signature-256': 'sha256=00' }, payload });
    expect(unsigned.statusCode).toBe(401);
    expect((await getGitHubConnection(env.db, ws.workspace.id))!.status).toBe('active');
    const sig = `sha256=${createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;
    const signed = await env.server.inject({ method: 'POST', url: '/github/webhook', headers: { 'content-type': 'application/json', 'x-github-event': 'installation', 'x-hub-signature-256': sig }, payload });
    expect(signed.statusCode).toBe(204);
    expect((await getGitHubConnection(env.db, ws.workspace.id))!.status).toBe('removed');
  });
});

describe('panel publishing', () => {
  it('publishes once, then edits the same message in place', async () => {
    const ws = await makeWorkspace(env);
    const url = `/w/${ws.workspace.id}/panel/publish`;
    await env.server.inject({ method: 'POST', url, ...form(ws.owner) });
    const panel = (await getPanel(env.db, ws.workspace.id))!;
    expect(env.discord.messages.get(panel.message_id)!.channelId).toBe(ws.channelId);
    expect(env.discord.messages.get(panel.message_id)!.payload.allowed_mentions).toEqual({ parse: [] });

    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/apps`, ...form(ws.owner, { name: 'Website', repo_id: String(ws.repoIds[1]), enabled: '1' }) });
    const apps = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/apps`, ...get(ws.owner) });
    expect(apps.body).toContain('doesn’t show your latest changes');

    await env.server.inject({ method: 'POST', url, ...form(ws.owner) });
    const after = (await getPanel(env.db, ws.workspace.id))!;
    expect(after.message_id).toBe(panel.message_id);
    expect(env.discord.messages.size).toBe(1);
    const options = env.discord.messages.get(panel.message_id)!.payload.components[0].components[0].options;
    expect(options.map((o: { label: string }) => o.label)).toEqual(['Mobile App', 'Website']);
  });

  it('re-posts a deleted panel and moves it when the channel changes', async () => {
    const ws = await makeWorkspace(env);
    const url = `/w/${ws.workspace.id}/panel/publish`;
    await env.server.inject({ method: 'POST', url, ...form(ws.owner) });
    const first = (await getPanel(env.db, ws.workspace.id))!;
    env.discord.messages.delete(first.message_id);

    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/panel`, ...get(ws.owner) });
    expect(page.body).toContain('The ticket panel was deleted from Discord');
    expect((await getPanel(env.db, ws.workspace.id))!.status).toBe('missing');

    await env.server.inject({ method: 'POST', url, ...form(ws.owner) });
    const second = (await getPanel(env.db, ws.workspace.id))!;
    expect(second.message_id).not.toBe(first.message_id);
    expect(second.status).toBe('published');

    const guild = env.discord.guilds.get(ws.guildId)!;
    guild.channels.push({ id: '880', type: 0, name: 'help', position: 2 });
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/setup/discord/channel`, ...form(ws.owner, { channel_id: '880' }) });
    await env.server.inject({ method: 'POST', url, ...form(ws.owner) });
    const moved = (await getPanel(env.db, ws.workspace.id))!;
    expect(moved.channel_id).toBe('880');
    expect(env.discord.messages.has(second.message_id)).toBe(false);
    expect(env.discord.messages.size).toBe(1);
  });

  it('explains Discord permission errors when publishing', async () => {
    const ws = await makeWorkspace(env);
    env.discord.failNextCreate = { status: 403, code: 50013 };
    const res = await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/panel/publish`, ...form(ws.owner) });
    expect(res.statusCode).toBe(302);
    expect(await getPanel(env.db, ws.workspace.id)).toBeNull();
    const flash = res.cookies.find((c) => c.name === 'tr_flash')!.value;
    expect(Buffer.from(flash, 'base64url').toString()).toMatch(/missing permissions/);
  });

  it('creates a test issue only when the admin explicitly sends one', async () => {
    const ws = await makeWorkspace(env);
    await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/panel`, ...get(ws.owner) });
    expect(env.github.createCalls).toBe(0);
    const res = await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/panel/test`, ...form(ws.owner, { app_id: ws.apps[0]!.id }) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`/w/${ws.workspace.id}/submissions/`));
    const issue = env.github.allIssues()[0]!;
    expect(issue.title).toBe('[Test] [Mobile App] Ticket Relay connection test');
    expect(issue.body).toContain('This is a test ticket');
    const detail = await env.server.inject({ method: 'GET', url: res.headers.location as string, ...get(ws.owner) });
    expect(detail.body).toContain('Created');
  });
});


describe('missing deployment configuration', () => {
  it('keeps the admin UI usable and explains what is missing', async () => {
    const bare = await makeApp({ config: testConfig({ DISCORD_BOT_TOKEN: '', GITHUB_APP_PRIVATE_KEY: '' }) });
    const owner = await makeAdmin(bare);
    const ws = await createWorkspace(bare.db, { ...bare.deps.config, openWorkspaceCreation: true }, owner.user, 'Bare');
    const overview = await bare.server.inject({ method: 'GET', url: `/w/${ws.id}`, ...get(owner) });
    expect(overview.body).toContain('Deployment setup incomplete');
    const setup = await bare.server.inject({ method: 'GET', url: `/w/${ws.id}/provider-setup`, ...get(owner) });
    expect(setup.body).toContain('DISCORD_BOT_TOKEN');
    expect(setup.body).toContain('https://relay.example.test/discord/interactions');
    for (const url of ['/setup/github/install', '/setup/github/link', '/setup/discord/install', '/setup/discord/server', '/setup/discord/channel']) {
      const res = await bare.server.inject({ method: 'POST', url: `/w/${ws.id}${url}`, ...form(owner) });
      expect(res.statusCode, url).toBe(302);
    }
    const interactions = await bare.server.inject({ method: 'POST', url: '/discord/interactions', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(interactions.statusCode).toBe(503);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getContributorPanel, saveContributorSettings, setContributorApps } from '../src/domain/contributors.js';
import { getPanel } from '../src/domain/store.js';
import { EPHEMERAL } from '../src/discord/messages.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, member, modalSubmit, nextInteractionId, resetDb, sendInteraction, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const ROLE_ID = '700000000000000777';
const HIGH_ROLE_ID = '700000000000000888';
const MANAGE_ROLES = 1n << 28n;

let env: TestEnv;
let ws: ConfiguredWorkspace;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App' }, { name: 'Website', repoIndex: 1 }] });
  // Bot role (position 5) with Manage Roles; a Contributor role below it and an Admin role above it.
  const guild = env.discord.guilds.get(ws.guildId)!;
  const botRole = guild.roles.find((r) => r.id === guild.botRoles[0])!;
  botRole.position = 5;
  botRole.permissions = String(BigInt(botRole.permissions) | MANAGE_ROLES);
  guild.roles.push({ id: ROLE_ID, name: 'Contributor', permissions: '0', position: 2 }, { id: HIGH_ROLE_ID, name: 'Admins', permissions: '0', position: 9 });
});
afterAll(async () => {
  await testDb().end();
});

async function enable() {
  await saveContributorSettings(env.db, ws.workspace.id, { enabled: true, role_id: ROLE_ID, role_name: 'Contributor', channel_id: ws.channelId, channel_name: 'tickets' });
  await setContributorApps(env.db, ws.workspace.id, [ws.apps[0]!.id]);
}

async function pick(who = member('555000000000000001', 'Casey'), appPublicId = ws.apps[0]!.public_id) {
  return sendInteraction(env, {
    id: nextInteractionId(), type: 3, token: `vtok-${who.user.id}`, guild_id: ws.guildId, channel_id: ws.channelId, member: who,
    data: { custom_id: 'cv:pick', values: [appPublicId] },
  });
}

async function verify(who = member('555000000000000001', 'Casey')) {
  const res = await pick(who);
  const button = res.json().data.components[0].components[0];
  const state = new URL(button.url).searchParams.get('state')!;
  const page = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&state=${state}` });
  return { res, button, state, page };
}

async function verifications() {
  return (await env.db.query('SELECT * FROM contributor_verifications ORDER BY created_at')).rows;
}

describe('member verification flow', () => {
  it('sends a private, single-use GitHub sign-in link for the chosen app', async () => {
    await enable();
    const res = await pick();
    const body = res.json();
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(EPHEMERAL);
    const button = body.data.components[0].components[0];
    expect(button.style).toBe(5);
    const url = new URL(button.url);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://relay.example.test/oauth/github/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('grants the role for a merged pull request and updates the Discord message', async () => {
    await enable();
    env.github.mergedPrs.set(ws.repoIds[0]!, new Set(['octo-dev']));
    const { page } = await verify();
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('You are verified');
    expect(env.discord.roleChanges).toEqual([{ method: 'PUT', guildId: ws.guildId, userId: '555000000000000001', roleId: ROLE_ID }]);
    const [v] = await verifications();
    expect(v).toMatchObject({ result: 'verified', method: 'merged_pr', github_login: 'octo-dev', discord_user_id: '555000000000000001' });
    const edit = env.discord.interactionEdits.find((e) => e.token === 'vtok-555000000000000001')!;
    expect(edit.payload.embeds[0].title).toBe('Verified: role added');
    expect(edit.payload.components).toEqual([]);
  });

  it('falls back to direct commits', async () => {
    await enable();
    env.github.commits.set(ws.repoIds[0]!, new Set(['octo-dev']));
    await verify();
    expect((await verifications())[0]).toMatchObject({ result: 'verified', method: 'commit' });
  });

  it('does not grant the role without contributions', async () => {
    await enable();
    const { page } = await verify();
    expect(page.body).toContain('No contributions found');
    expect(env.discord.roleChanges).toEqual([]);
    expect((await verifications())[0]).toMatchObject({ result: 'not_contributor' });
  });

  it('links one GitHub account to only one Discord member', async () => {
    await enable();
    env.github.mergedPrs.set(ws.repoIds[0]!, new Set(['octo-dev']));
    await verify(member('555000000000000001', 'Casey'));
    const { page } = await verify(member('555000000000000002', 'Alt'));
    expect(page.body).toContain('Account already linked');
    expect(env.discord.roleChanges).toHaveLength(1);
    // The same member can verify again (e.g. for another app) without a conflict.
    const again = await verify(member('555000000000000001', 'Casey'));
    expect(again.page.body).toContain('You are verified');
  });

  it('rejects reused links and keeps the ticket panel working', async () => {
    await enable();
    env.github.mergedPrs.set(ws.repoIds[0]!, new Set(['octo-dev']));
    const { state } = await verify();
    const replay = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&state=${state}` });
    expect(replay.body).not.toContain('You are verified');
    expect(env.discord.roleChanges).toHaveLength(1);

    const ticketPick = await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: 'tr:pick', values: [ws.apps[0]!.public_id] } });
    expect(ticketPick.json().type).toBe(9);
    const submit = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, { title: 'Still works', description: 'Tickets are unaffected by contributor roles.' }));
    expect(submit.json().type).toBe(5);
  });

  it('reports when Discord refuses the role and allows a retry later', async () => {
    await enable();
    env.github.mergedPrs.set(ws.repoIds[0]!, new Set(['octo-dev']));
    env.discord.failRoleChange = { status: 403, code: 50013 };
    const { page } = await verify();
    expect(page.body).toContain('Verification failed');
    expect((await verifications())[0].info).toMatch(/Manage Roles/);
    env.discord.failRoleChange = null;
    const retry = await verify();
    expect(retry.page.body).toContain('You are verified');
  });

  it('is unavailable when turned off or for apps not enabled', async () => {
    const off = await pick();
    expect(off.json().data.embeds[0].title).toBe('Not available');
    await enable();
    const other = await pick(member(), ws.apps[1]!.public_id);
    expect(other.json().data.embeds[0].title).toBe('App unavailable');
  });

  it('rate-limits repeated attempts', async () => {
    await enable();
    for (let n = 0; n < 5; n++) await verify();
    const res = await pick();
    expect(res.json().data.embeds[0].title).toBe('Please wait a moment');
  });
});

describe('admin page', () => {
  it('only accepts roles the bot can assign and channels in the connected server', async () => {
    const url = `/w/${ws.workspace.id}/contributors/settings`;
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { enabled: '1', role_id: HIGH_ROLE_ID, channel_id: ws.channelId }) });
    expect((await env.db.query('SELECT * FROM contributor_settings')).rows).toHaveLength(0);
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { enabled: '1', role_id: ROLE_ID, channel_id: '123' }) });
    expect((await env.db.query('SELECT * FROM contributor_settings')).rows).toHaveLength(0);
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { enabled: '1', role_id: ROLE_ID, channel_id: ws.channelId }) });
    expect((await env.db.query('SELECT role_id, enabled FROM contributor_settings')).rows[0]).toEqual({ role_id: ROLE_ID, enabled: true });

    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/contributors`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Members will get the @Contributor role');
    expect(page.body).toContain('Above the bot&#39;s role');
  });

  it('publishes a separate panel and revokes roles', async () => {
    await enable();
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/panel/publish`, ...form(ws.owner) });
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/contributors/publish`, ...form(ws.owner) });
    const ticketPanel = (await getPanel(env.db, ws.workspace.id))!;
    const contributorPanel = (await getContributorPanel(env.db, ws.workspace.id))!;
    expect(contributorPanel.message_id).not.toBe(ticketPanel.message_id);
    expect(env.discord.messages.get(contributorPanel.message_id)!.payload.components[0].components[0].custom_id).toBe('cv:pick');
    expect(env.discord.messages.get(ticketPanel.message_id)!.payload.components[0].components[0].custom_id).toBe('tr:pick');

    env.github.mergedPrs.set(ws.repoIds[0]!, new Set(['octo-dev']));
    await verify();
    const [v] = await verifications();
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/contributors/verifications/${v.id}/revoke`, ...form(ws.owner) });
    expect(env.discord.roleChanges.at(-1)).toMatchObject({ method: 'DELETE', roleId: ROLE_ID });
    expect((await env.db.query('SELECT count(*) AS n FROM contributor_links')).rows[0].n).toBe(0);
  });

  it('is isolated per workspace', async () => {
    const outsider = await makeAdmin(env);
    const other = await makeWorkspace(env, { owner: outsider });
    const res = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/contributors`, ...get(other.owner) });
    expect(res.statusCode).toBe(404);
  });
});

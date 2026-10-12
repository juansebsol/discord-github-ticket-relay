import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addTier, getContributorPanel, saveContributorSettings, setContributorApps } from '../src/domain/contributors.js';
import { getPanel } from '../src/domain/store.js';
import { EPHEMERAL } from '../src/discord/messages.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, member, modalSubmit, nextInteractionId, resetDb, sendInteraction, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const JUNIOR_ID = '1559142599141494824';
const CONTRIB_ID = '700000000000000999';
const HIGH_ROLE_ID = '700000000000000888';
const MANAGE_ROLES = 1n << 28n;

let env: TestEnv;
let ws: ConfiguredWorkspace;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App' }, { name: 'Website', repoIndex: 1 }] });
  // Bot role (position 5) with Manage Roles; two tier roles below it and an Admins role above it.
  const guild = env.discord.guilds.get(ws.guildId)!;
  const botRole = guild.roles.find((r) => r.id === guild.botRoles[0])!;
  botRole.position = 5;
  botRole.permissions = String(BigInt(botRole.permissions) | MANAGE_ROLES);
  guild.roles.push(
    { id: JUNIOR_ID, name: 'Junior Contributor', permissions: '0', position: 2 },
    { id: CONTRIB_ID, name: 'Contributor', permissions: '0', position: 3 },
    { id: HIGH_ROLE_ID, name: 'Admins', permissions: '0', position: 9 },
  );
});
afterAll(async () => {
  await testDb().end();
});

const LOGIN = 'octo-dev';

async function enable() {
  await saveContributorSettings(env.db, ws.workspace.id, { enabled: true, role_id: null, role_name: null, channel_id: ws.channelId, channel_name: 'tickets' });
  await addTier(env.db, ws.workspace.id, { id: JUNIOR_ID, name: 'Junior Contributor' }, 1);
  await addTier(env.db, ws.workspace.id, { id: CONTRIB_ID, name: 'Contributor' }, 10);
  await setContributorApps(env.db, ws.workspace.id, [ws.apps[0]!.id]);
}

function contributed(prs: number, commits = 0) {
  env.github.mergedPrs.set(ws.repoIds[0]!, new Map([[LOGIN, prs]]));
  env.github.commits.set(ws.repoIds[0]!, new Map([[LOGIN, commits]]));
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

const added = () => env.discord.roleChanges.filter((c) => c.method === 'PUT').map((c) => c.roleId);
const removed = () => env.discord.roleChanges.filter((c) => c.method === 'DELETE').map((c) => c.roleId);

describe('member verification flow', () => {
  it('sends a private, single-use GitHub sign-in link listing the roles', async () => {
    await enable();
    const body = (await pick()).json();
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.embeds[0].description).toContain('Junior Contributor at 1+, Contributor at 10+');
    const url = new URL(body.data.components[0].components[0].url);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://relay.example.test/oauth/github/callback');
  });

  it('gives Junior Contributor for 1 merged PR', async () => {
    await enable();
    contributed(1);
    const { page } = await verify();
    expect(page.body).toContain('You are verified: Junior Contributor');
    expect(page.body).toContain('Reach 10 for <strong>Contributor</strong>');
    expect(added()).toEqual([JUNIOR_ID]);
    expect((await verifications())[0]).toMatchObject({ result: 'verified', method: 'merged_pr', contributions: 1, role_name: 'Junior Contributor' });
    const edit = env.discord.interactionEdits.find((e) => e.token === 'vtok-555000000000000001')!;
    expect(edit.payload.embeds[0].title).toBe('Verified: Junior Contributor');
    expect(edit.payload.components).toEqual([]);
  });

  it('gives Contributor for 10 merged PRs and swaps out the lower tier', async () => {
    await enable();
    contributed(12, 3);
    const { page } = await verify();
    expect(page.body).toContain('You are verified: Contributor');
    expect(added()).toEqual([CONTRIB_ID]);
    expect(removed()).toEqual([JUNIOR_ID]);
  });

  it('moves a member up when they verify again later', async () => {
    await enable();
    contributed(1);
    await verify();
    contributed(10);
    await verify();
    expect(added()).toEqual([JUNIOR_ID, CONTRIB_ID]);
    expect(removed()).toEqual([JUNIOR_ID]);
  });

  it('counts direct commits when they outnumber merged PRs', async () => {
    await enable();
    contributed(0, 11);
    await verify();
    expect((await verifications())[0]).toMatchObject({ method: 'commit', contributions: 11, role_name: 'Contributor' });
  });

  it('gives no role without contributions or below the lowest tier', async () => {
    await enable();
    contributed(0);
    expect((await verify()).page.body).toContain('Not enough contributions yet');
    await env.db.query('UPDATE contributor_tiers SET min_contributions = 3 WHERE role_id = $1', [JUNIOR_ID]);
    contributed(2);
    expect((await verify()).page.body).toContain('<strong>Junior Contributor</strong> needs 3');
    expect(env.discord.roleChanges).toEqual([]);
  });

  it('links one GitHub account to only one Discord member', async () => {
    await enable();
    contributed(1);
    await verify(member('555000000000000001', 'Casey'));
    const { page } = await verify(member('555000000000000002', 'Alt'));
    expect(page.body).toContain('Account already linked');
    expect(added()).toHaveLength(1);
  });

  it('rejects reused links and keeps the ticket panel working', async () => {
    await enable();
    contributed(1);
    const { state } = await verify();
    const replay = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&state=${state}` });
    expect(replay.body).not.toContain('You are verified');
    expect(added()).toHaveLength(1);

    const ticketPick = await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: 'tr:pick', values: [ws.apps[0]!.public_id] } });
    expect(ticketPick.json().type).toBe(9);
    const submit = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, { title: 'Still works', description: 'Tickets are unaffected by contributor roles.' }));
    expect(submit.json().type).toBe(5);
  });

  it('reports when Discord refuses the role and allows a retry later', async () => {
    await enable();
    contributed(1);
    env.discord.failRoleChange = { status: 403, code: 50013 };
    expect((await verify()).page.body).toContain('Verification failed');
    expect((await verifications())[0].info).toMatch(/Manage Roles/);
    env.discord.failRoleChange = null;
    expect((await verify()).page.body).toContain('You are verified');
  });

  it('is unavailable when turned off, without roles, or for apps not enabled', async () => {
    expect((await pick()).json().data.embeds[0].title).toBe('Not available');
    await enable();
    expect((await pick(member(), ws.apps[1]!.public_id)).json().data.embeds[0].title).toBe('App unavailable');
  });

  it('rate-limits repeated attempts', async () => {
    await enable();
    for (let n = 0; n < 5; n++) await verify();
    expect((await pick()).json().data.embeds[0].title).toBe('Please wait a moment');
  });
});

describe('admin page', () => {
  it('adds role tiers only for assignable roles and unique thresholds', async () => {
    const url = `/w/${ws.workspace.id}/contributors/tiers`;
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { role_id: HIGH_ROLE_ID, min_contributions: '1' }) });
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { role_id: JUNIOR_ID, min_contributions: '0' }) });
    expect((await env.db.query('SELECT * FROM contributor_tiers')).rows).toHaveLength(0);

    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { role_id: JUNIOR_ID, min_contributions: '1' }) });
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { role_id: CONTRIB_ID, min_contributions: '1' }) }); // duplicate threshold
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { role_id: CONTRIB_ID, min_contributions: '10' }) });
    const tiers = (await env.db.query('SELECT role_name, min_contributions FROM contributor_tiers ORDER BY min_contributions')).rows;
    expect(tiers).toEqual([{ role_name: 'Junior Contributor', min_contributions: 1 }, { role_name: 'Contributor', min_contributions: 10 }]);

    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/contributors`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('@Junior Contributor at 1+ contribution');
    expect(page.body).toContain('@Contributor at 10+ contributions');

    const id = (await env.db.query('SELECT id FROM contributor_tiers WHERE role_id = $1', [CONTRIB_ID])).rows[0].id;
    await env.server.inject({ method: 'POST', url: `${url}/${id}/delete`, ...form(ws.owner) });
    expect((await env.db.query('SELECT * FROM contributor_tiers')).rows).toHaveLength(1);
  });

  it('saves the panel channel only from the connected server', async () => {
    const url = `/w/${ws.workspace.id}/contributors/settings`;
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { enabled: '1', channel_id: '123' }) });
    expect((await env.db.query('SELECT * FROM contributor_settings')).rows).toHaveLength(0);
    await env.server.inject({ method: 'POST', url, ...form(ws.owner, { enabled: '1', channel_id: ws.channelId }) });
    expect((await env.db.query('SELECT channel_id, enabled FROM contributor_settings')).rows[0]).toEqual({ channel_id: ws.channelId, enabled: true });
  });

  it('publishes a separate panel listing the tiers, and revoke removes every tier role', async () => {
    await enable();
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/panel/publish`, ...form(ws.owner) });
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/contributors/publish`, ...form(ws.owner) });
    const ticketPanel = (await getPanel(env.db, ws.workspace.id))!;
    const contributorPanel = (await getContributorPanel(env.db, ws.workspace.id))!;
    expect(contributorPanel.message_id).not.toBe(ticketPanel.message_id);
    const payload = env.discord.messages.get(contributorPanel.message_id)!.payload;
    expect(payload.components[0].components[0].custom_id).toBe('cv:pick');
    expect(payload.embeds[0].description).toContain('**Contributor**: 10+');
    expect(env.discord.messages.get(ticketPanel.message_id)!.payload.components[0].components[0].custom_id).toBe('tr:pick');

    contributed(1);
    await verify();
    const [v] = await verifications();
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/contributors/verifications/${v.id}/revoke`, ...form(ws.owner) });
    expect(removed()).toEqual([JUNIOR_ID, CONTRIB_ID]);
    expect((await env.db.query('SELECT count(*) AS n FROM contributor_links')).rows[0].n).toBe(0);
  });

  it('is isolated per workspace', async () => {
    const outsider = await makeAdmin(env);
    const other = await makeWorkspace(env, { owner: outsider });
    const res = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/contributors`, ...get(other.owner) });
    expect(res.statusCode).toBe(404);
  });
});

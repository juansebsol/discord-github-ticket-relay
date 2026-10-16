import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addTier, getContributorPanel, publishContributorPanel, saveContributorSettings, setContributorApps } from '../src/domain/contributors.js';
import { getDevMode, setDevMode } from '../src/domain/dev-mode.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const JUNIOR_ID = '1559142599141494824';
const CONTRIB_ID = '700000000000000999';
const CORE_ID = '1559142504920653834';
const MANAGE_ROLES = 1n << 28n;

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = mod) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string | string[]> = {}, who: Admin = mod) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
/** Where a page's forms post to under `prefix`, once each (the layout's own Sign out form isn't one; tables repeat their menus for phones). */
const postForms = (body: string, prefix: string) => [...new Set([...body.matchAll(/<form\b[^>]*\bmethod="post"[^>]*\baction="([^"]+)"/g)].map((m) => m[1]!).filter((a) => a.startsWith(`${w()}${prefix}`)))];

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App' }, { name: 'Website', repoIndex: 1 }] });
  // The bot's role sits above the contributor roles and can manage roles.
  const guild = env.discord.guilds.get(ws.guildId)!;
  const botRole = guild.roles.find((r) => r.id === guild.botRoles[0])!;
  botRole.position = 5;
  botRole.permissions = String(BigInt(botRole.permissions) | MANAGE_ROLES);
  guild.roles.push(
    { id: JUNIOR_ID, name: 'Junior Contributor', permissions: '0', position: 2 },
    { id: CONTRIB_ID, name: 'Contributor', permissions: '0', position: 3 },
    { id: CORE_ID, name: 'Core Contributor', permissions: '0', position: 8 },
  );
  mod = await makeAdmin(env, 'mia');
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(mod) });
});
afterAll(async () => {
  await testDb().end();
});

/** Verification on, posting in #tickets, with one automatic role and the first app counted. */
async function setUp() {
  await saveContributorSettings(env.db, wid(), { enabled: true, role_id: null, role_name: null, channel_id: ws.channelId, channel_name: 'tickets' });
  await addTier(env.db, wid(), { id: JUNIOR_ID, name: 'Junior Contributor' }, 1, null);
  await setContributorApps(env.db, wid(), [ws.apps[0]!.id]);
  return (await env.db.query<{ id: string }>('SELECT id FROM contributor_tiers WHERE role_id = $1', [JUNIOR_ID])).rows[0]!.id;
}
const tiers = async () => (await env.db.query('SELECT role_name, min_contributions, note FROM contributor_tiers ORDER BY min_contributions')).rows;
const manualRoles = async () => (await env.db.query('SELECT role_name, note FROM contributor_manual_roles')).rows;
const counted = async () => (await env.db.query('SELECT name FROM apps WHERE workspace_id = $1 AND contributor_enabled ORDER BY name', [wid()])).rows.map((r) => r.name);

describe('Contributor roles › Verifications', () => {
  it('No access refuses the page; View shows the list without revoke; Edit adds revoke', async () => {
    await env.db.query(
      `INSERT INTO contributor_verifications (id, workspace_id, app_name, repo_owner, repo_name, discord_user_id, discord_name, github_user_id, github_login, result)
       VALUES ('v1', $1, 'Mobile App', 'org', 'mobile', '555', 'Casey', 42, 'casey', 'verified')`,
      [wid()],
    );
    await grant(env, wid(), mod.user.id, {});
    expect((await page('/contributors')).statusCode).toBe(403);
    expect((await post('/contributors/verifications/v1/revoke')).statusCode).toBe(403);

    await grant(env, wid(), mod.user.id, { verifications: 'view' });
    const view = await page('/contributors');
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('Casey');
    expect(view.body).toContain('View only');
    expect(postForms(view.body, '/contributors')).toEqual([]);
    expect(view.body).not.toContain('Revoke role');
    expect((await post('/contributors/verifications/v1/revoke')).statusCode).toBe(403);

    await grant(env, wid(), mod.user.id, { verifications: 'edit' });
    const edit = await page('/contributors');
    expect(postForms(edit.body, '/contributors')).toEqual([`${w()}/contributors/verifications/v1/revoke`]);
    expect(edit.body).toContain('Revoke role…');
  });
});

describe('Contributor roles › Roles', () => {
  it('No access: every page and change is refused', async () => {
    const tid = await setUp();
    for (const url of ['/contributors/roles', '/contributors/roles/new?kind=auto', `/contributors/roles/${tid}/edit?kind=auto`]) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).toContain('You don’t have access to Contributor roles › Roles. Ask an admin if you need it.');
    }
    const changes: [string, Record<string, string>][] = [
      ['/contributors/tiers', { role_id: CONTRIB_ID, min_contributions: '10' }],
      [`/contributors/tiers/${tid}`, { min_contributions: '5' }],
      [`/contributors/tiers/${tid}/delete`, {}],
      ['/contributors/manual-roles', { role_id: CORE_ID }],
      ['/contributors/apps', { app_ids: ws.apps[1]!.id }],
    ];
    for (const [url, fields] of changes) expect((await post(url, fields)).statusCode, url).toBe(403);
    expect(await tiers()).toEqual([{ role_name: 'Junior Contributor', min_contributions: 1, note: null }]);
    expect(await manualRoles()).toEqual([]);
    expect(await counted()).toEqual(['Mobile App']);
  });

  it('View shows the roles and what counts, with nothing to change', async () => {
    const tid = await setUp();
    await env.db.query(`INSERT INTO contributor_manual_roles (id, workspace_id, role_id, role_name, note) VALUES ('m1', $1, $2, 'Core Contributor', 'given by hand')`, [wid(), CORE_ID]);
    await grant(env, wid(), mod.user.id, { 'contributor-roles': 'view' });

    const list = await page('/contributors/roles');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('@Junior Contributor');
    expect(list.body).toContain('@Core Contributor');
    expect(list.body).toContain('View only');
    expect(postForms(list.body, '/contributors')).toEqual([]);
    expect(list.body).not.toContain('New role');
    expect(list.body).not.toContain('/contributors/roles/new');
    expect(list.body).not.toContain('/edit?kind=');
    expect(list.body).not.toContain('Delete role');
    expect(list.body).not.toContain('data-dirty');
    // The repository switches show what counts, turned off.
    expect(list.body).toContain('<fieldset class="plain view-only" disabled>');
    expect(list.body).toContain(`value="${ws.apps[0]!.id}" aria-label="Count `);
    expect(list.body).toContain('View only. Ask an admin if you need to change which repositories count.');

    // A role opened directly: the same fields, read-only.
    const role = await page(`/contributors/roles/${tid}/edit?kind=auto`);
    expect(role.statusCode).toBe(200);
    expect(role.body).toContain('<h1>@Junior Contributor</h1>');
    expect(role.body).toContain('View only');
    expect(postForms(role.body, '/contributors')).toEqual([]);
    expect(role.body).toContain('<fieldset class="plain view-only" disabled>');
    expect(role.body).toContain('name="min_contributions" min="1" max="100000" required value="1"');
    expect(role.body).toContain('View only. Ask an admin if you need to change this role.');
    expect(role.body).not.toContain('To use another role');
    expect(role.body).not.toContain('Save changes');
    expect((await page('/contributors/roles/m1/edit?kind=manual')).body).toContain('<h1>@Core Contributor</h1>');

    // Adding a role needs Edit.
    const add = await page('/contributors/roles/new?kind=auto');
    expect(add.statusCode).toBe(403);
    expect(add.body).toContain('You can see Contributor roles › Roles, but not change it. Ask an admin if you need Edit.');
    for (const [url, fields] of [
      ['/contributors/tiers', { role_id: CONTRIB_ID, min_contributions: '10' }],
      [`/contributors/tiers/${tid}`, { min_contributions: '5' }],
      [`/contributors/tiers/${tid}/delete`, {}],
      ['/contributors/manual-roles', { role_id: CONTRIB_ID }],
      ['/contributors/manual-roles/m1', { note: 'changed' }],
      ['/contributors/manual-roles/m1/delete', {}],
      ['/contributors/apps', { app_ids: ws.apps[1]!.id }],
    ] as const) expect((await post(url, fields)).statusCode, url).toBe(403);
    expect(await tiers()).toEqual([{ role_name: 'Junior Contributor', min_contributions: 1, note: null }]);
    expect(await manualRoles()).toEqual([{ role_name: 'Core Contributor', note: 'given by hand' }]);
    expect(await counted()).toEqual(['Mobile App']);
  });

  it('View with no roles yet says who can add them', async () => {
    await grant(env, wid(), mod.user.id, { 'contributor-roles': 'view' });
    const list = await page('/contributors/roles');
    expect(list.body).toContain('No roles yet');
    expect(list.body).toContain('An admin can add roles here.');
    expect(list.body).not.toContain('New automatic role');
  });

  it('Edit lets moderators add, change and delete roles, and choose what counts', async () => {
    const tid = await setUp();
    await grant(env, wid(), mod.user.id, { 'contributor-roles': 'edit' });

    const list = await page('/contributors/roles');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('View only');
    expect(list.body).toContain('New role');
    expect(list.body).toContain(`${w()}/contributors/roles/${tid}/edit?kind=auto`);
    expect(postForms(list.body, '/contributors')).toEqual([`${w()}/contributors/tiers/${tid}/delete`, `${w()}/contributors/apps`]);

    const add = await page('/contributors/roles/new?kind=auto');
    expect(add.statusCode).toBe(200);
    expect(postForms(add.body, '/contributors')).toEqual([`${w()}/contributors/tiers`]);
    expect(add.body).toContain('@Contributor');

    expect((await post('/contributors/tiers', { role_id: CONTRIB_ID, min_contributions: '10' })).statusCode).toBe(302);
    expect((await post(`/contributors/tiers/${tid}`, { min_contributions: '2', note: 'two merged pull requests' })).statusCode).toBe(302);
    expect(await tiers()).toEqual([
      { role_name: 'Junior Contributor', min_contributions: 2, note: 'two merged pull requests' },
      { role_name: 'Contributor', min_contributions: 10, note: null },
    ]);
    const edit = await page(`/contributors/roles/${tid}/edit?kind=auto`);
    expect(edit.body).toContain('<h1>Edit @Junior Contributor</h1>');
    expect(postForms(edit.body, '/contributors')).toEqual([`${w()}/contributors/tiers/${tid}`]);

    expect((await post('/contributors/manual-roles', { role_id: CORE_ID, note: 'given by hand' })).statusCode).toBe(302);
    expect(await manualRoles()).toEqual([{ role_name: 'Core Contributor', note: 'given by hand' }]);
    expect((await post('/contributors/apps', { app_ids: [ws.apps[0]!.id, ws.apps[1]!.id] })).statusCode).toBe(302);
    expect(await counted()).toEqual(['Mobile App', 'Website']);
    expect((await post(`/contributors/tiers/${tid}/delete`)).statusCode).toBe(302);
    expect((await tiers()).map((t) => t.role_name)).toEqual(['Contributor']);
  });
});

describe('Contributor roles › Panel', () => {
  it('No access: the page, saving, publishing and removing are refused', async () => {
    await setUp();
    await publishContributorPanel(env.deps, wid(), ws.owner.user.id);
    const res = await page('/contributors/panel');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('You don’t have access to Contributor roles › Panel. Ask an admin if you need it.');
    expect((await post('/contributors/panel', { panel_title: 'Hijacked', intent: 'publish' })).statusCode).toBe(403);
    expect((await post('/contributors/publish')).statusCode).toBe(403);
    expect((await post('/contributors/remove')).statusCode).toBe(403);
    expect((await env.db.query('SELECT panel_title FROM contributor_settings')).rows[0].panel_title).toBeNull();
    expect(await getContributorPanel(env.db, wid())).not.toBeNull();
  });

  it('View shows the settings, health and preview with nothing to change', async () => {
    await setUp();
    await env.db.query('DELETE FROM contributor_tiers');
    await grant(env, wid(), mod.user.id, { 'contributor-panel': 'view' });

    const res = await page('/contributors/panel');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('View only');
    // The Discord preview still renders.
    expect(res.body).toContain('aria-label="Preview of the contributor panel in Discord"');
    expect(res.body).toContain('<h4 id="pv-title">');
    expect(res.body).toContain('<span class="dp-button" id="pv-button">Verify with GitHub</span>');
    // Every setting is shown, turned off; nothing can be saved, published or removed.
    expect(res.body).toContain('<fieldset class="plain view-only" disabled>');
    expect(res.body).toContain('id="panel_title" name="panel_title"');
    expect(postForms(res.body, '/contributors')).toEqual([]);
    for (const text of ['Publish panel', 'Update panel', 'Remove panel', 'Reset to default', 'data-dirty', 'Unsaved changes']) expect(res.body, text).not.toContain(text);
    expect(res.body).toContain('View only. Ask an admin if you need to change the panel.');
    // Health still says what's wrong, without fixes they can't make.
    expect(res.body).toContain('No automatic roles yet');
    expect(res.body).not.toContain('/contributors/roles/new');
    expect(res.body).not.toContain('Fix the health checks below to publish.');

    expect((await post('/contributors/panel', { panel_title: 'Hijacked', settings: '1' })).statusCode).toBe(403);
    expect((await post('/contributors/publish')).statusCode).toBe(403);
    expect((await post('/contributors/remove')).statusCode).toBe(403);
    expect((await env.db.query('SELECT panel_title, enabled FROM contributor_settings')).rows[0]).toEqual({ panel_title: null, enabled: true });
  });

  it('View of a published panel has no Remove button or form', async () => {
    await setUp();
    await publishContributorPanel(env.deps, wid(), ws.owner.user.id);
    await grant(env, wid(), mod.user.id, { 'contributor-panel': 'view' });
    const res = await page('/contributors/panel');
    expect(res.body).toContain('Published');
    expect(res.body).not.toContain('remove-form');
    expect(res.body).not.toContain('Remove panel');
  });

  it('Edit lets moderators change, publish and remove the panel', async () => {
    await setUp();
    await grant(env, wid(), mod.user.id, { 'contributor-panel': 'edit' });

    const res = await page('/contributors/panel');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('View only');
    expect(postForms(res.body, '/contributors')).toEqual([`${w()}/contributors/panel`]);
    expect(res.body).toContain('Reset to default');
    expect(res.body).toContain('Publish panel');

    expect((await post('/contributors/panel', { panel_title: 'Get your role', intent: 'publish' })).statusCode).toBe(302);
    expect((await env.db.query('SELECT panel_title FROM contributor_settings')).rows[0].panel_title).toBe('Get your role');
    const posted = (await getContributorPanel(env.db, wid()))!;
    expect(env.discord.messages.get(posted.message_id)!.payload.embeds[0].title).toBe('Get your role');

    const published = await page('/contributors/panel');
    expect(postForms(published.body, '/contributors')).toEqual([`${w()}/contributors/panel`, `${w()}/contributors/remove`]);
    expect((await post('/contributors/publish')).statusCode).toBe(302);
    expect((await post('/contributors/remove')).statusCode).toBe(302);
    expect(env.discord.messages.has(posted.message_id)).toBe(false);
  });
});

describe('Server health › Dev mode', () => {
  const toggle = (on: boolean, who: Admin = mod) => env.server.inject({
    method: 'POST', url: `${w()}/health/dev-mode`,
    headers: { ...form(who).headers, accept: 'application/json' },
    payload: new URLSearchParams({ _csrf: who.csrf, set: '1', ...(on ? { on: '1' } : {}) }).toString(),
  });

  it('No access: the page and the switch are refused', async () => {
    expect((await page('/health')).statusCode).toBe(403);
    expect((await toggle(true)).statusCode).toBe(403);
    expect((await getDevMode(env.db)).on).toBe(false);
  });

  it('View shows the page and when Dev mode is on, but not the switch', async () => {
    await grant(env, wid(), mod.user.id, { health: 'view' });
    const off = await page('/health');
    expect(off.statusCode).toBe(200);
    expect(off.body).toContain('View only');
    expect(postForms(off.body, '/health')).toEqual([]);
    expect(off.body).not.toContain('Dev mode on');
    expect(off.body).not.toContain('Turn on Dev mode while you deploy');

    expect((await toggle(true)).statusCode).toBe(403);
    expect((await getDevMode(env.db)).on).toBe(false);

    await setDevMode(env.db, true, ws.owner.user.id);
    const on = await page('/health');
    expect(on.body).toContain('Dev mode on');
    expect(on.body).toContain(`Restarts aren’t counted while someone deploys. Turned on just now by ${ws.owner.user.display_name}.`);
    expect(postForms(on.body, '/health')).toEqual([]);
    const live = await page('/health?partial=1');
    expect(live.body).toContain('Restarts aren’t counted while someone deploys');
    expect(live.body).not.toContain('Turn it off when you’re done');
  });

  it('Edit lets a moderator switch Dev mode on and off', async () => {
    await grant(env, wid(), mod.user.id, { health: 'edit' });
    const res = await page('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('View only');
    expect(postForms(res.body, '/health')).toEqual([`${w()}/health/dev-mode`]);
    expect(res.body).toContain('Turn on Dev mode while you deploy');

    expect((await toggle(true)).json()).toEqual({ ok: true, message: 'Dev mode is on: restarts aren’t counted until you turn it off.', on: true });
    expect(await getDevMode(env.db)).toMatchObject({ on: true, by: mod.user.id });
    expect((await page('/health?partial=1')).body).toContain('Turn it off when you’re done');
    expect((await toggle(false)).json()).toMatchObject({ ok: true, on: false });
    expect((await getDevMode(env.db)).on).toBe(false);
  });
});

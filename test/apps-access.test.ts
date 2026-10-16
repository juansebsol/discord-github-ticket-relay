import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listApps } from '../src/domain/store.js';
import { createInvite, setModeratorAccess } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = mod) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string> = {}, who: Admin = mod) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const access = async () => (await env.db.query('SELECT access FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0].access;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
  mod = await makeAdmin(env, 'mia');
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(mod) });
});
afterAll(async () => {
  await testDb().end();
});

describe('Apps & repositories access for moderators', () => {
  it('starts with no access: locked in the sidebar, and the page says why', async () => {
    const overview = await page('');
    expect(overview.body).toContain('title="You don’t have access to Apps &amp; repositories. Ask an admin if you need it."');
    expect(overview.body).not.toContain(`href="${w()}/apps"`);
    const res = await page('/apps');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('You don’t have access to Apps &amp; repositories. Ask an admin if you need it.');
    expect((await post('/apps', { name: 'Sneaky', repo_id: String(ws.repoIds[0]), enabled: '1' })).statusCode).toBe(403);
  });

  it('is set on the Members page with the other pages, without touching them', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.actions': 'view' });
    const members = await page('/members', ws.owner);
    expect(members.body).toContain('id="moderator-access"');
    expect(members.body).toContain(`name="apps" form="acc-${mod.user.id}"`);
    expect(members.body).toContain('AI triage');

    const res = await env.server.inject({
      method: 'POST', url: `${w()}/members/${mod.user.id}/access`,
      headers: { ...form(ws.owner).headers, accept: 'application/json' },
      payload: new URLSearchParams({ _csrf: ws.owner.csrf, apps: 'view' }).toString(),
    });
    expect(res.json()).toEqual({ ok: true, message: 'mia: Apps & repositories → View' });
    expect(await access()).toEqual({ 'triage.actions': 'view', apps: 'view' });
    expect((await page('/members', ws.owner)).body).toContain('Apps: view');
    // Only admins set it.
    expect((await post(`/members/${mod.user.id}/access`, { apps: 'edit' })).statusCode).toBe(403);
    await expect(setModeratorAccess(env.db, wid(), ws.owner.user.id, { apps: 'view' })).rejects.toThrow();
  });

  it('View shows the apps without any way to change them', async () => {
    await grant(env, wid(), mod.user.id, { apps: 'view' });
    const app = ws.apps[0]!;
    const list = await page('/apps');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(app.name);
    expect(list.body).toContain('View only');
    expect(list.body).toContain(`href="${w()}/apps" class="nav-item" aria-current="page"`);
    expect(list.body).not.toContain('Add app');
    expect(list.body).not.toContain(`/apps/${app.id}/edit`);
    expect(list.body).not.toContain('Remove app');

    const edit = await page(`/apps/${app.id}/edit`);
    expect(edit.statusCode).toBe(403);
    expect(edit.body).toContain('You can see Apps &amp; repositories, but not change it. Ask an admin if you need Edit.');
    for (const url of ['/apps/new', `/apps/labels?repo=${ws.repoIds[0]}`]) expect((await page(url)).statusCode, url).toBe(403);
    for (const url of [`/apps/${app.id}/toggle`, `/apps/${app.id}/delete`, `/apps/${app.id}/move`]) expect((await post(url)).statusCode, url).toBe(403);
    expect((await listApps(env.db, wid())).map((a) => [a.name, a.enabled])).toEqual(ws.apps.map((a) => [a.name, true]));
  });

  it('Edit lets them add, change, hide and remove apps; GitHub, Discord and the panel stay with admins', async () => {
    await grant(env, wid(), mod.user.id, { apps: 'edit' });
    const list = await page('/apps');
    expect(list.body).toContain('Add app');
    expect(list.body).not.toContain('View only');
    expect(list.body).toContain('<div class="who-role">Moderator</div>');

    expect((await page('/apps/new')).statusCode).toBe(200);
    const added = await post('/apps', { name: 'Tablet', repo_id: String(ws.repoIds[0]), enabled: '1' });
    expect(added.statusCode).toBe(302);
    const tablet = (await listApps(env.db, wid())).find((a) => a.name === 'Tablet')!;
    expect(tablet).toBeTruthy();
    // A repository outside the GitHub App is still refused.
    env.github.addInstallation(9999, 'someone-else', [{ id: 4242, name: 'secret-repo' }]);
    expect((await post('/apps', { name: 'Sneaky', repo_id: '4242', enabled: '1' })).statusCode).toBe(400);

    await post(`/apps/${tablet.id}/toggle`);
    expect((await listApps(env.db, wid())).find((a) => a.id === tablet.id)!.enabled).toBe(false);
    await post(`/apps/${tablet.id}/delete`);
    expect((await listApps(env.db, wid())).some((a) => a.id === tablet.id)).toBe(false);

    for (const url of ['/setup/github', '/setup/discord', '/tickets/panel', '/settings']) expect((await page(url)).statusCode, url).toBe(403);
    const overview = await page('');
    expect(overview.body).toMatch(/Apps &amp; repositories<\/span><span class="locked">.*?Edit<\/span>/);
  });
});

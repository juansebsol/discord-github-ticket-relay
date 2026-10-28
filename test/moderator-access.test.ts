import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { AREA_KEYS, can, canSeeTool, firstArea, levelOf, type MemberAccess } from '../src/domain/permissions.js';
import { createInvite, setMemberRole, setModeratorAccess } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = mod) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string> = {}, who: Admin = mod) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const saveJson = (userId: string, fields: Record<string, string>, who: Admin = ws.owner) => env.server.inject({
  method: 'POST', url: `${w()}/members/${userId}/access`,
  headers: { ...form(who).headers, accept: 'application/json' },
  payload: new URLSearchParams({ _csrf: who.csrf, ...fields }).toString(),
});
const accessOf = async (userId: string) => (await env.db.query('SELECT access FROM workspace_members WHERE user_id = $1', [userId])).rows[0].access;

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

describe('migration 024', () => {
  it('turns the old switches and page lists into one access map, keeping what everyone could do', async () => {
    const db = openDatabase(':memory:');
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files.filter((x) => x < '024')) db.exec(await readFile(path.join(MIGRATIONS, f), 'utf8'));
    db.exec(`INSERT INTO users (id, discord_user_id, username) VALUES ('u1', '1', 'all'), ('u2', '2', 'triage'), ('u3', '3', 'plain'), ('u4', '4', 'owner'), ('u5', '5', 'admin');
      INSERT INTO workspaces (id, name) VALUES ('w', 'W');
      INSERT INTO workspace_members (workspace_id, user_id, role, can_act_tickets, can_view_contributors, can_search_issues, can_manage_files, can_view_health, triage_access, page_access) VALUES
        ('w', 'u1', 'moderator', 1, 1, 1, 1, 1, '{"actions":"edit","activity":"edit","labels":"none","bogus":"edit"}', '{"apps":"view"}'),
        ('w', 'u2', 'moderator', 0, 0, 0, 0, 0, '{"prompt":"view"}', '{}'),
        ('w', 'u3', 'moderator', 0, 1, 0, 0, 0, '{}', '{}'),
        ('w', 'u4', 'owner', 1, 1, 1, 1, 1, '{}', '{}'),
        ('w', 'u5', 'admin', 0, 1, 0, 0, 0, '{}', '{}');`);
    db.exec(await readFile(path.join(MIGRATIONS, '024_moderator_access.sql'), 'utf8'));
    const rows = Object.fromEntries((await db.query<{ user_id: string; access: unknown }>('SELECT user_id, access FROM workspace_members')).rows.map((r) => [r.user_id, r.access]));
    expect(rows.u1).toEqual({
      inbox: 'edit', 'triage.review': 'edit', verifications: 'view', issues: 'view', 'issues-github': 'view', 'issues-sync': 'view',
      files: 'edit', health: 'view', 'triage.actions': 'edit', 'triage.activity': 'view', apps: 'view',
    });
    // Some Triage page but not Act on tickets: Review is View.
    expect(rows.u2).toEqual({ 'triage.review': 'view', 'triage.prompt': 'view' });
    expect(rows.u3).toEqual({ verifications: 'view' });
    expect(rows.u4).toEqual({});
    // Admins keep it for if they're made a moderator again.
    expect(rows.u5).toEqual({ verifications: 'view' });
    await db.end();
  });
});

describe('access map', () => {
  it('reads levels within what each page offers; the Inbox is always at least View', () => {
    // As stored: Edit on pages without anything to change, and a page that doesn't exist.
    const m = { role: 'moderator', access: { 'triage.activity': 'edit', issues: 'edit', panel: 'view', bogus: 'edit' } } as unknown as MemberAccess;
    expect(levelOf(m.access, 'inbox')).toBe('view');
    expect(levelOf(m.access, 'triage.activity')).toBe('view');
    expect(levelOf(m.access, 'issues')).toBe('view');
    expect(can(m, 'inbox.view')).toBe(true);
    expect(can(m, 'inbox.edit')).toBe(false);
    expect(can(m, 'triage.activity.edit')).toBe(false);
    expect(can(m, 'panel.view')).toBe(true);
    expect(can(m, 'manage')).toBe(false);
    expect(firstArea(m, 'tickets')).toBe('inbox');
    expect(firstArea(m, 'triage')).toBe('triage.activity');
    expect(canSeeTool(m, 'contributors')).toBe(false);
    expect(can({ role: 'admin', access: {} }, 'health.edit')).toBe(true);
    expect(can({ role: 'admin', access: {} }, 'members')).toBe(false);
  });

  it('changes only the pages given, drops No access, and only applies to moderators', async () => {
    expect(await accessOf(mod.user.id)).toEqual({ verifications: 'view' });
    const next = await setModeratorAccess(env.db, wid(), mod.user.id, { inbox: 'edit', 'triage.activity': 'edit', verifications: 'none', nonsense: 'edit', apps: 'admin' });
    expect(next).toEqual({ inbox: 'edit', 'triage.activity': 'view' });
    expect(await accessOf(mod.user.id)).toEqual(next);
    await expect(setModeratorAccess(env.db, wid(), ws.owner.user.id, { inbox: 'edit' })).rejects.toThrow('Only moderators have adjustable permissions.');
  });

  it('a moderator made admin and back keeps their access; an admin made moderator starts like a new one', async () => {
    await grant(env, wid(), mod.user.id, { files: 'edit' });
    await setMemberRole(env.db, wid(), mod.user.id, 'admin');
    await setMemberRole(env.db, wid(), mod.user.id, 'moderator');
    expect(await accessOf(mod.user.id)).toEqual({ files: 'edit' });

    const admin = await makeAdmin(env, 'jo');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'admin')}`, ...form(admin) });
    expect(await accessOf(admin.user.id)).toEqual({});
    await setMemberRole(env.db, wid(), admin.user.id, 'moderator');
    expect(await accessOf(admin.user.id)).toEqual({ verifications: 'view' });
  });
});

describe('Members › Moderator access', () => {
  it('edits one moderator at a time, tool by tool, with one click per page', async () => {
    await grant(env, wid(), mod.user.id, { inbox: 'edit', 'triage.prompt': 'view' });
    const res = await page('/members', ws.owner);
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain('style="');
    expect(body).toContain('id="moderator-access"');
    expect(body).not.toContain('id="page-access"');
    // One form per moderator, saved on every change; their editor says whose access it is.
    expect(body).toContain(`<form id="acc-${mod.user.id}" method="post" action="${w()}/members/${mod.user.id}/access" data-async hidden>`);
    expect(body).toContain(`<section class="acc-editor" id="mod-${mod.user.id}" data-mod="${mod.user.id}"`);
    expect(body).toContain(`<span class="nm" id="acc-name-${mod.user.id}">mia</span>`);
    expect(body).toContain('2 of 31 pages open · 1 editable');
    // No Access / View / Edit per page: the Inbox can't be turned off, Activity has nothing to edit.
    const radios = (name: string) => [...body.matchAll(new RegExp(`<input type="radio" name="${name.replace('.', '\\.')}" value="(\\w+)" form="acc-${mod.user.id}"[^>]*?( checked)?>`, 'g'))].map((m) => `${m[1]}${m[2] ? '*' : ''}`);
    for (const a of AREA_KEYS) expect(radios(a).length, a).toBeGreaterThan(1);
    expect(radios('inbox')).toEqual(['view', 'edit*']);
    expect(radios('triage.activity')).toEqual(['none*', 'view']);
    expect(radios('triage.prompt')).toEqual(['none', 'view*', 'edit']);
    // Each tool: a switch that opens or closes all of it, and a summary.
    expect(body).toMatch(/aria-label="mia: open AI triage"\s+checked\s+data-tool-switch/);
    expect(body).toMatch(/aria-label="mia: open GitHub issues"\s+data-tool-switch/);
    expect(body).toContain('1 of 8 pages · view only');
    expect(body).toContain('1 of 5 pages · 1 editable');
    expect(body).toContain('<section class="acc-tool" data-tool="issues">');
    // Quick sets; with one moderator there's nobody to pick, so no picker.
    expect(body).toContain('data-preset="edit"');
    expect(body).not.toContain('id="acc-picker"');
    expect(body).not.toContain('data-acc-open');
    const other = await makeAdmin(env, 'noah');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(other) });
    const two = (await page(`/members?mod=${other.user.id}`, ws.owner)).body;
    // The name opens the picker: search, filters with counts, everyone, the chosen one marked.
    expect(two).toContain('<div class="acc-picker" id="acc-picker" role="dialog" aria-label="Choose a moderator" hidden>');
    expect(two).toContain('data-acc-open aria-haspopup="dialog" aria-expanded="false" aria-controls="acc-picker"');
    expect(two).toMatch(/data-mod-filter="all" aria-pressed="true">All <span data-kind-count="all">2<\/span>/);
    expect(two).toMatch(/data-mod-filter="edit" aria-pressed="false">Can edit <span data-kind-count="edit">1<\/span>/);
    expect(two).toMatch(new RegExp(`data-mod-pick="${other.user.id}" data-kind="view"[^>]*aria-selected="true"`));
    expect(two).toMatch(new RegExp(`data-mod-pick="${mod.user.id}" data-kind="edit"[^>]*aria-selected="false"`));
    expect(two).toContain('2 pages · 1 edit');
    // ‹ 2 of 2 › steps through everyone, as links that work without JavaScript too.
    expect(two).toContain('<span>2 of 2</span>');
    expect(two).toContain(`href="${w()}/members?mod=${mod.user.id}#moderator-access" data-mod-step="${mod.user.id}"`);
    expect(two).toContain(`<section class="acc-editor" id="mod-${mod.user.id}" data-mod="${mod.user.id}" aria-labelledby="acc-name-${mod.user.id}" hidden>`);
    expect(two).toContain(`<option value="${mod.user.id}">mia</option>`);
    // The members table sums it up per tool.
    expect(body).toContain('Inbox: edit');
    expect(body).toContain('Prompt: view');
    expect(body).toContain('If allowed');
  });

  it('saves from the selects with a short message, and refuses moderators and non-moderators', async () => {
    const one = await saveJson(mod.user.id, { inbox: 'edit', 'triage.review': 'view' });
    expect(one.json()).toEqual({ ok: true, message: 'mia: Inbox → Edit, Review → View' });
    // A tool's select sends all of that moderator's pages: the message names the tool.
    const triage = await saveJson(mod.user.id, { inbox: 'edit', 'triage.overview': 'view', 'triage.review': 'edit', 'triage.actions': 'edit', 'triage.labels': 'edit', 'triage.prompt': 'edit', 'triage.knowledge': 'edit', 'triage.runs': 'edit', 'triage.activity': 'edit' });
    expect(triage.json()).toEqual({ ok: true, message: 'mia: AI triage → Edit all' });
    const all = await saveJson(mod.user.id, Object.fromEntries(AREA_KEYS.map((a) => [a, 'none'])));
    expect(all.json()).toEqual({ ok: true, message: 'mia: All pages → No access' });
    expect(await accessOf(mod.user.id)).toEqual({});
    expect((await saveJson(mod.user.id, {})).json()).toEqual({ ok: true, message: 'mia: access saved' });

    const denied = await saveJson(mod.user.id, { inbox: 'edit' }, mod);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ ok: false });
    const owner = await saveJson(ws.owner.user.id, { inbox: 'edit' });
    expect(owner.statusCode).toBe(404);
    expect(owner.json()).toEqual({ ok: false, error: 'Only moderators have adjustable permissions.' });
    // Without the CSRF token nothing changes.
    const forged = await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/access`, headers: { cookie: ws.owner.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'inbox=edit' });
    expect(forged.statusCode).toBe(403);
    expect(await accessOf(mod.user.id)).toEqual({});
    // A plain form (no JavaScript) comes back to the card.
    const plain = await post(`/members/${mod.user.id}/access`, { 'triage.prompt': 'view' }, ws.owner);
    expect(plain.statusCode).toBe(302);
    expect(plain.headers.location).toBe(`${w()}/members?mod=${mod.user.id}#moderator-access`);
  });

  it('no longer has the old routes', async () => {
    for (const url of ['permissions', 'page-access', 'triage-access']) {
      expect((await post(`/members/${mod.user.id}/${url}`, { can_act_tickets: '1' }, ws.owner)).statusCode, url).toBe(404);
    }
  });
});

describe('what each level allows', () => {
  it('applying suggestions anywhere needs Edit on Review, not on the Inbox', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await grant(env, wid(), mod.user.id, { inbox: 'edit' });
    expect((await post(`/tickets/${id}/triage/apply`, { kind: 'priority' })).statusCode).toBe(403);
    expect((await post('/triage/bulk', { op: 'dismiss', ticket: `sub:${id}` })).statusCode).toBe(403);
    expect((await post(`/issues/${ws.repoIds[0]}/1/triage/dismiss`, { kind: 'priority' })).statusCode).toBe(403);
    await grant(env, wid(), mod.user.id, { 'triage.review': 'edit' });
    // Allowed now: the suggestion just isn't there.
    expect((await post(`/tickets/${id}/triage/apply`, { kind: 'priority' })).statusCode).toBe(302);
    expect((await post(`/tickets/${id}/retry`)).statusCode).toBe(403);
  });

  it('Files: View shows the list only; Edit can scan and delete', async () => {
    const refused = await page('/tickets/files');
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('You don’t have access to Discord tickets › Files. Ask an admin if you need it.');

    await grant(env, wid(), mod.user.id, { files: 'view' });
    const viewOnly = await page('/tickets/files');
    expect(viewOnly.statusCode).toBe(200);
    expect(viewOnly.body).toContain('View only');
    expect(viewOnly.body).not.toContain(`action="${w()}/tickets/files/scan"`);
    expect(viewOnly.body).not.toContain('id="bulk-files"');
    const scan = await post('/tickets/files/scan');
    expect(scan.statusCode).toBe(403);
    expect(scan.body).toContain('You can see Discord tickets › Files, but not change it. Ask an admin if you need Edit.');
    expect(viewOnly.body).toContain('<div class="who-role">Moderator · View only</div>');

    await grant(env, wid(), mod.user.id, { files: 'edit' });
    const edit = await page('/tickets/files');
    expect(edit.body).toContain(`action="${w()}/tickets/files/scan"`);
    expect(edit.body).toContain('<div class="who-role">Moderator</div>');
    expect((await post('/tickets/files/scan')).statusCode).toBe(302);
    // Cleanup rules stay with admins.
    expect((await post('/tickets/files/settings', { closed_days: '1', age_days: '1', storage_limit_gb: '1' })).statusCode).toBe(403);
  });

  it('Edit on every page still leaves setup, settings, deployment and members with admins', async () => {
    await grant(env, wid(), mod.user.id, Object.fromEntries(AREA_KEYS.map((a) => [a, 'edit'])));
    const id = '00000000-0000-4000-8000-000000000000';
    for (const url of ['/setup/github', '/setup/discord', '/settings', '/deployment', '/members']) expect((await page(url)).statusCode, url).toBe(403);
    for (const url of [
      '/setup/github/install', '/setup/github/link', '/setup/github/disconnect', '/setup/discord/server', '/setup/discord/disconnect', '/setup/discord/install',
      '/settings', '/settings/claude/key', '/settings/claude/remove', '/settings/claude/test', '/tickets/files/settings',
      '/members/invites', `/members/invites/${id}/revoke`, `/members/${mod.user.id}/role`, `/members/${mod.user.id}/access`, `/members/${mod.user.id}/remove`,
    ]) expect((await post(url)).statusCode, url).toBe(403);
  });

  it('no pages means only the inbox and the overview', async () => {
    await grant(env, wid(), mod.user.id, {});
    for (const url of ['', '/tickets']) expect((await page(url)).statusCode, url).toBe(200);
    for (const url of ['/tickets/files', '/issues', '/issues/github', '/issues/sync', '/triage', '/triage/actions', '/triage/labels', '/triage/prompt', '/triage/runs', '/triage/activity', '/contributors', '/apps', '/health']) {
      expect((await page(url)).statusCode, url).toBe(403);
    }
  });

  it('the overview lists their access per tool', async () => {
    await grant(env, wid(), mod.user.id, { inbox: 'edit', 'triage.prompt': 'view', apps: 'edit' });
    const body = (await page('')).body;
    expect(body).toContain('Your access');
    expect(body).toMatch(/Discord tickets<\/span><span class="locked">.*?1 of 5 pages · 1 editable<\/span>/);
    expect(body).toMatch(/AI triage<\/span><span class="locked">.*?1 of 8 pages<\/span>/);
    expect(body).toMatch(/Contributor roles<\/span><span class="locked">.*?No access<\/span>/);
  });
});

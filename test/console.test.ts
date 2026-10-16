import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTicketType, listTicketTypes } from '../src/domain/ticket-types.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
const w = () => `/w/${ws.workspace.id}`;
const json = { accept: 'application/json' };

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

describe('console pages', () => {
  it('renders every page with Lucide icons and no emoji or glyph icons', async () => {
    const pages = ['', '/tickets', '/tickets/panel', '/tickets/types', '/tickets/types/new', '/tickets/files', '/tickets/settings', '/issues', '/issues/github', '/issues/sync',
      '/triage', '/triage/actions', '/triage/labels', '/triage/prompt', '/triage/prompt/full', '/triage/runs', '/triage/activity', '/contributors', '/contributors/roles',
      '/contributors/roles/new?kind=auto', '/contributors/panel', '/members', '/members?invite=1', '/settings', '/deployment', '/setup/github', '/setup/discord', '/apps', '/apps/new', '/health'];
    for (const p of pages) {
      const res = await env.server.inject({ method: 'GET', url: w() + p, ...get(ws.owner) });
      expect(res.statusCode, p).toBe(200);
      expect(res.body, p).toContain('<svg');
      expect(res.body, p).not.toMatch(/[✓✗☰⚙◎★▾🐙💬🎫🏅👥✅⚠️ℹ️]/u);
      expect(res.body, p).not.toMatch(/style="/); // CSP forbids inline styles
    }
  });

  it('redirects old URLs to their new places', async () => {
    const cases: [string, string][] = [['/submissions?status=failed', '/tickets?status=failed'], ['/panel', '/tickets/panel'], ['/provider-setup', '/deployment']];
    for (const [from, to] of cases) {
      const res = await env.server.inject({ method: 'GET', url: w() + from, ...get(ws.owner) });
      expect(res.statusCode, from).toBe(302);
      expect(res.headers.location).toBe(w() + to);
    }
  });

  it('saves ticket limits and workspace settings separately', async () => {
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/settings`, ...form(ws.owner, { rate_limit_count: '3', rate_limit_window_minutes: '15', duplicate_window_minutes: '0' }) });
    await env.server.inject({ method: 'POST', url: `${w()}/settings`, ...form(ws.owner, { name: 'Renamed', retention_days: '45' }) });
    const row = (await env.db.query('SELECT name, rate_limit_count, rate_limit_window_minutes, duplicate_window_minutes, retention_days FROM workspaces WHERE id = $1', [ws.workspace.id])).rows[0];
    expect(row).toEqual({ name: 'Renamed', rate_limit_count: 3, rate_limit_window_minutes: 15, duplicate_window_minutes: 0, retention_days: 45 });
  });

  it('saves panel text from the Panel tab and treats the default text as "use the default"', async () => {
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/panel`, ...form(ws.owner, { panel_title: 'Need help? Open a ticket', panel_intro: 'Pick your **app** below.', intent: 'save' }) });
    const row = (await env.db.query('SELECT panel_title, panel_intro FROM workspaces WHERE id = $1', [ws.workspace.id])).rows[0];
    expect(row).toEqual({ panel_title: null, panel_intro: 'Pick your **app** below.' });
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/panel`, ...get(ws.owner) });
    expect(page.body).toContain('<span id="pv-intro">Pick your <strong>app</strong> below.</span>');
  });

  it('toggles ticket types and moderator access from switches with JSON replies', async () => {
    await createTicketType(env.db, ws.workspace.id, { name: 'Question', description: null, label: null, title_prefix: null, guidance: null, placeholder: null, enabled: true });
    const [type] = await listTicketTypes(env.db, ws.workspace.id);
    const off = await env.server.inject({ method: 'POST', url: `${w()}/tickets/types/${type!.id}/toggle`, ...form(ws.owner, { set: '1' }), headers: { ...form(ws.owner).headers, ...json } });
    expect(off.json()).toMatchObject({ ok: true });
    expect((await listTicketTypes(env.db, ws.workspace.id))[0]!.enabled).toBe(false);

    const mod = await makeAdmin(env, 'mia');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator')}`, ...form(mod) });
    const on = await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/access`, ...form(ws.owner, { inbox: 'edit', verifications: 'view' }), headers: { ...form(ws.owner).headers, ...json } });
    expect(on.json()).toEqual({ ok: true, message: 'mia: Inbox → Edit' });
    // A moderator gets a JSON 403, not an HTML page, from the same select.
    const denied = await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/access`, ...form(mod, {}), headers: { ...form(mod).headers, ...json } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ ok: false });
  });

  it('shows the invite link once, on the Members page', async () => {
    const res = await env.server.inject({ method: 'POST', url: `${w()}/members/invites`, ...form(ws.owner, { role: 'moderator' }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/https:\/\/relay\.example\.test\/invite\/[A-Za-z0-9_-]+/);
    const again = await env.server.inject({ method: 'GET', url: `${w()}/members`, ...get(ws.owner) });
    expect(again.body).not.toMatch(/\/invite\/[A-Za-z0-9_-]{20,}/);
    expect(again.body).toContain('Moderator invite');
  });

  it('uses the whole window for tables and lists, and a readable width for settings and forms', async () => {
    const full = ['/tickets', '/issues', '/issues/github', '/issues/sync', '/tickets/types', '/tickets/files', '/triage', '/triage/activity', '/apps', '/members', '/contributors'];
    const readable = ['', '/triage/actions', '/triage/prompt', '/triage/runs', '/tickets/panel', '/tickets/settings', '/apps/new', '/settings', '/setup/github'];
    for (const p of full) expect((await env.server.inject({ method: 'GET', url: w() + p, ...get(ws.owner) })).body, p).toContain('<div class="page full">');
    for (const p of readable) expect((await env.server.inject({ method: 'GET', url: w() + p, ...get(ws.owner) })).body, p).toContain('<div class="page">');
    // The main column of a table takes the extra room.
    expect((await env.server.inject({ method: 'GET', url: `${w()}/apps`, ...get(ws.owner) })).body).toContain('<th class="col-main">App</th>');
  });
});

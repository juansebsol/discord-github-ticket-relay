import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
  mod = await makeAdmin(env, 'mia');
  const token = await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator');
  await env.server.inject({ method: 'POST', url: `/invite/${token}`, ...form(mod) });
});
afterAll(async () => {
  await testDb().end();
});

async function failedSubmission() {
  env.github.createQueue.push({ status: 410, body: { message: 'Issues are disabled' } });
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: 'int-x', interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: 'r1', displayName: 'Casey', username: 'casey' },
    title: 'Export fails', description: 'Click export, nothing happens at all.',
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return r.submission;
}

const w = () => `/w/${ws.workspace.id}`;

describe('moderators', () => {
  it('join through a moderator invite and start view-only', async () => {
    const row = (await env.db.query('SELECT role, can_act_tickets, can_view_contributors FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0];
    expect(row).toEqual({ role: 'moderator', can_act_tickets: false, can_view_contributors: true });
  });

  it('can see the overview, tickets and verifications', async () => {
    const sub = await failedSubmission();
    for (const url of ['', '/tickets', `/tickets/${sub.id}`, '/contributors']) {
      const res = await env.server.inject({ method: 'GET', url: w() + url, ...get(mod) });
      expect(res.statusCode, url).toBe(200);
    }
    const overview = await env.server.inject({ method: 'GET', url: w(), ...get(mod) });
    expect(overview.body).toContain('You&#39;re a moderator');
    expect(overview.body).not.toContain('/setup/github');
    expect(overview.body).not.toContain('/settings"');
    expect(overview.body).not.toContain('/members"');
    expect(overview.body).not.toContain('/tickets/panel');
  });

  it('cannot open or change setup, panels, apps, types, contributor setup or settings', async () => {
    const pages = ['/setup/github', '/setup/discord', '/apps', '/apps/new', '/tickets/panel', '/tickets/types', '/tickets/types/new', '/tickets/settings', '/contributors/roles', '/contributors/panel', '/members', '/settings', '/deployment'];
    for (const p of pages) {
      expect((await env.server.inject({ method: 'GET', url: w() + p, ...get(mod) })).statusCode, p).toBe(403);
    }
    const posts = [
      '/tickets/panel', '/tickets/panel/remove', '/tickets/panel/test', '/tickets/settings', '/apps', `/apps/${ws.apps[0]!.id}/delete`, '/tickets/types', '/tickets/types/create-labels',
      '/contributors/panel', '/contributors/publish', '/contributors/tiers', '/contributors/apps', '/settings', '/members/invites',
      '/setup/github/install', '/setup/github/disconnect', '/setup/discord/install', '/setup/discord/disconnect',
      `/members/${mod.user.id}/permissions`, `/members/${mod.user.id}/role`, `/members/${mod.user.id}/remove`,
    ];
    for (const p of posts) {
      expect((await env.server.inject({ method: 'POST', url: w() + p, ...form(mod) })).statusCode, p).toBe(403);
    }
    expect(env.discord.messages.size).toBe(0);
  });

  it('can only act on tickets when an admin allows it', async () => {
    const sub = await failedSubmission();
    const detail = await env.server.inject({ method: 'GET', url: `${w()}/tickets/${sub.id}`, ...get(mod) });
    expect(detail.body).toContain('View only');
    expect(detail.body).not.toContain('/dismiss');
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/${sub.id}/dismiss`, ...form(mod, { note: 'x' }) })).statusCode).toBe(403);

    // An admin grants "Act on tickets".
    await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/permissions`, ...form(ws.owner, { can_act_tickets: '1', can_view_contributors: '1' }) });
    expect((await env.server.inject({ method: 'GET', url: `${w()}/tickets/${sub.id}`, ...get(mod) })).body).toContain('/dismiss');
    const res = await env.server.inject({ method: 'POST', url: `${w()}/tickets/${sub.id}/dismiss`, ...form(mod, { reason: 'Spam' }) });
    expect(res.statusCode).toBe(302);
    expect((await env.db.query('SELECT status FROM submissions WHERE id = $1', [sub.id])).rows[0].status).toBe('dismissed');
  });

  it('lose contributor verifications when an admin turns them off, and never see revoke', async () => {
    const page = await env.server.inject({ method: 'GET', url: `${w()}/contributors`, ...get(mod) });
    expect(page.body).toContain('View only');
    expect(page.body).not.toContain('/revoke');
    await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/permissions`, ...form(ws.owner, {}) });
    expect((await env.server.inject({ method: 'GET', url: `${w()}/contributors`, ...get(mod) })).statusCode).toBe(403);
    expect((await env.server.inject({ method: 'POST', url: `${w()}/contributors/verifications/x/revoke`, ...form(mod) })).statusCode).toBe(403);
  });
});

describe('roles', () => {
  it('only the owner changes roles; admins can scope moderators', async () => {
    const admin = await makeAdmin(env, 'jamie');
    const token = await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'admin');
    await env.server.inject({ method: 'POST', url: `/invite/${token}`, ...form(admin) });

    expect((await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/role`, ...form(admin, { role: 'admin' }) })).statusCode).toBe(403);
    await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/permissions`, ...form(admin, { can_act_tickets: '1' }) });
    expect((await env.db.query('SELECT can_act_tickets, can_view_contributors FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0]).toEqual({ can_act_tickets: true, can_view_contributors: false });

    await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/role`, ...form(ws.owner, { role: 'admin' }) });
    expect((await env.server.inject({ method: 'GET', url: `${w()}/settings`, ...get(mod) })).statusCode).toBe(200);
    // The owner's own role can't be changed.
    await env.server.inject({ method: 'POST', url: `${w()}/members/${ws.owner.user.id}/role`, ...form(ws.owner, { role: 'moderator' }) });
    expect((await env.db.query('SELECT role FROM workspace_members WHERE user_id = $1', [ws.owner.user.id])).rows[0].role).toBe('owner');
  });

  it('still hides other workspaces from moderators with 404', async () => {
    const other = await makeWorkspace(env, { owner: await makeAdmin(env) });
    expect((await env.server.inject({ method: 'GET', url: `/w/${other.workspace.id}/tickets`, ...get(mod) })).statusCode).toBe(404);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite, setModeratorAccess } from '../src/domain/workspaces.js';
import { getTriageSettings, parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

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

describe('Triage access for moderators', () => {
  it('starts with no access: AI triage is locked, and every AI triage page is refused', async () => {
    expect(await access()).toEqual({ verifications: 'view' });
    const inbox = await page('/tickets');
    expect(inbox.body).not.toContain(`href="${w()}/triage`);
    expect(inbox.body).toContain('title="You don’t have access to AI triage. Ask an admin if you need it."');
    for (const url of ['/triage', '/triage/actions', '/triage/labels', '/triage/prompt', '/triage/prompt/full', '/triage/runs', '/triage/activity']) {
      expect((await page(url)).statusCode, url).toBe(403);
    }
    expect((await post('/triage/enabled', { set: '1', enabled: '1' })).statusCode).toBe(403);
    expect((await post('/triage/labels/add', { preset: 'empty' })).statusCode).toBe(403);
  });

  it('is set page by page on the Members page, and saved right away', async () => {
    const members = await page('/members', ws.owner);
    expect(members.body).toContain('id="moderator-access"');
    expect(members.body).toContain(`name="triage.labels" form="acc-${mod.user.id}"`);

    const res = await env.server.inject({
      method: 'POST', url: `${w()}/members/${mod.user.id}/access`,
      headers: { ...form(ws.owner).headers, accept: 'application/json', 'x-requested-with': 'fetch' },
      payload: new URLSearchParams({ _csrf: ws.owner.csrf, 'triage.actions': 'view', 'triage.labels': 'edit', 'triage.prompt': 'none', 'triage.runs': 'view', 'triage.activity': 'edit' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, message: 'mia: Actions → View, Label groups → Edit, Re-run → View, Activity → View' });
    // Activity is a log: Edit becomes View. No access isn't stored; other pages keep theirs.
    expect(await access()).toEqual({ verifications: 'view', 'triage.actions': 'view', 'triage.labels': 'edit', 'triage.runs': 'view', 'triage.activity': 'view' });
    expect((await page('/members', ws.owner)).body).toContain('Triage · 4 of 6');
    // Moderators can't change their own access.
    expect((await post(`/members/${mod.user.id}/access`, { 'triage.actions': 'edit' })).statusCode).toBe(403);
  });

  it('View shows the page with every control off; Edit lets them change it', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.actions': 'view', 'triage.labels': 'edit', 'triage.runs': 'view', 'triage.activity': 'view' });
    const inbox = await page('/tickets');
    expect(inbox.body).toContain(`href="${w()}/triage/actions"`);

    const actions = await page('/triage/actions');
    expect(actions.statusCode).toBe(200);
    expect(actions.body).toContain('View only');
    expect(actions.body).toContain('class="plain stack view-only" disabled');
    expect(actions.body).not.toContain('Save changes');
    expect(actions.body).not.toContain('data-copy-modes');
    expect(actions.body).not.toContain('/settings#claude');
    // Prompt is locked in the AI triage tabs and not linked; Review isn't open to them either.
    expect(actions.body).toContain('title="You don’t have access to Prompt. Ask an admin if you need it."');
    expect(actions.body).not.toContain(`href="${w()}/triage/prompt"`);
    expect(actions.body).toContain('<span class="tab locked" aria-disabled="true" title="You don’t have access to Review. Ask an admin if you need it.">');
    expect(actions.body).toContain(`<a class="tab" href="${w()}/triage/actions" aria-current="page">Actions</a>`);
    const before = (await getTriageSettings(env.db, wid())).config;
    expect((await post('/triage/actions', { model: 'claude-haiku-4-5', threshold: '60', monthly_limit: '5' })).statusCode).toBe(403);
    expect((await post('/triage/enabled', { set: '1', enabled: '1' })).statusCode).toBe(403);
    expect((await getTriageSettings(env.db, wid())).config).toEqual(before);

    // Label groups: Edit.
    const labels = await page('/triage/labels');
    expect(labels.body).not.toContain('view-only');
    expect(labels.body).not.toContain('title="You can see the label groups.');
    expect(labels.body).toContain('Moderator</div>'); // not “Moderator · View only”: they can change something
    expect(labels.body).toContain('Empty group');
    expect((await post('/triage/labels/add', { preset: 'empty' })).statusCode).toBe(302);
    expect((await getTriageSettings(env.db, wid())).config.labelGroups).toHaveLength(1);

    // Prompt: no access, and the page says which.
    const refused = await page('/triage/prompt');
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('You don’t have access to AI triage › Prompt. Ask an admin if you need it.');
    expect((await post('/triage/prompt', { instructions: 'x' })).statusCode).toBe(403);

    // Re-run: View, without the start form.
    const runs = await page('/triage/runs');
    expect(runs.statusCode).toBe(200);
    expect(runs.body).toContain('Starting, stopping and applying a re-run needs Edit on Re-run');
    expect(runs.body).not.toContain('data-estimate=');
    expect((await post('/triage/runs', { never: '1', untouched: '1', mode: 'preview' })).statusCode).toBe(403);

    // Activity: View.
    expect((await page('/triage/activity')).statusCode).toBe(200);
  });

  it('opens the first page they can see, and view-only pages read well', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.prompt': 'view', 'triage.activity': 'view' });
    const tab = await page('/tickets');
    expect(tab.body).toContain(`href="${w()}/triage/prompt"`);
    // AI triage opens on Review; without it, on the first page they can see.
    const res = await page('/triage');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${w()}/triage/prompt`);
    expect((await page('/triage/actions')).statusCode).toBe(403);

    const prompt = await page('/triage/prompt');
    expect(prompt.body).toContain('class="plain stack view-only" disabled');
    expect(prompt.body).toContain('View only. Ask an admin if you need to change the prompt.');
    expect(prompt.body).not.toContain('Save prompt');
    expect(prompt.body).not.toContain(`${w()}/apps"`);
    expect((await page('/triage/prompt/full')).statusCode).toBe(200);
  });

  it('“Use these settings” needs Edit on Re-run, Actions, Label groups and Prompt', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'suggest' } }));
    await setTriageEnabled(env.db, wid(), true);
    const r = await acceptSubmission(env.deps, {
      workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: 'int-a1', interactionToken: null,
      guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: 'r1', displayName: 'Casey', username: 'casey' },
      title: 'Export crashes', description: 'Every export closes the app.', ticketType: null,
    });
    if (r.kind !== 'accepted') throw new Error(r.kind);
    await env.worker.drain();
    await env.triage.drain();
    await post('/triage/runs', { never: '1', untouched: '1', mode: 'preview' }, ws.owner);
    await env.triage.drain();
    const run = (await env.db.query('SELECT id FROM triage_runs')).rows[0];
    // The current settings change, so the run's differ.
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'auto' } }));

    await grant(env, wid(), mod.user.id, { 'triage.runs': 'edit', 'triage.actions': 'view', 'triage.labels': 'edit', 'triage.prompt': 'edit' });
    const runPage = await page(`/triage/runs/${run.id}`);
    expect(runPage.statusCode).toBe(200);
    expect(runPage.body).not.toContain('Use these settings');
    expect(runPage.body).toContain('Delete run');
    const refused = await post(`/triage/runs/${run.id}/use-settings`);
    expect(refused.statusCode).toBe(302);
    expect((await getTriageSettings(env.db, wid())).config.priority.mode).toBe('auto');

    await grant(env, wid(), mod.user.id, { 'triage.runs': 'edit', 'triage.actions': 'edit', 'triage.labels': 'edit', 'triage.prompt': 'edit' });
    expect((await page(`/triage/runs/${run.id}`)).body).toContain('Use these settings');
    await post(`/triage/runs/${run.id}/use-settings`);
    expect((await getTriageSettings(env.db, wid())).config.priority.mode).toBe('suggest');

    // View only: no Stop, Apply, Delete or Use these settings.
    await grant(env, wid(), mod.user.id, { 'triage.runs': 'view' });
    const viewOnly = await page(`/triage/runs/${run.id}`);
    expect(viewOnly.body).toContain('View only');
    expect(viewOnly.body).not.toContain('Delete run');
    expect(viewOnly.body).not.toContain('id="apply-run"');
    expect(viewOnly.body).not.toContain('Activity log');
    expect((await post(`/triage/runs/${run.id}/delete`)).statusCode).toBe(403);
  });

  it('only applies to moderators; admins can do everything', async () => {
    await expect(setModeratorAccess(env.db, wid(), ws.owner.user.id, { 'triage.actions': 'view' })).rejects.toThrow('Only moderators have adjustable permissions.');
    const actions = await page('/triage/actions', ws.owner);
    expect(actions.body).toContain('Save changes');
    expect(actions.body).not.toContain('nav-item locked');
    expect(actions.body).not.toContain('seg-item locked');
  });
});

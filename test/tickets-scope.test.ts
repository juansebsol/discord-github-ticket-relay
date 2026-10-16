import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultForm, formFor } from '../src/domain/forms.js';
import type { MemberAccess } from '../src/domain/permissions.js';
import { getPanel } from '../src/domain/store.js';
import { createTicketType, getTicketType, listTicketTypes, saveTicketTypeForm, type TicketType } from '../src/domain/ticket-types.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

/**
 * Discord tickets › Panel, Ticket types and Settings for moderators: No access (403 on every
 * page and change), View (everything shown, nothing to change) and Edit (works like an admin).
 */

let env: TestEnv;
let ws: ConfiguredWorkspace;
const w = () => `/w/${ws.workspace.id}`;
const page = (who: Admin, url: string) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (who: Admin, url: string, fields: Record<string, string | string[]> = {}) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const postJson = (who: Admin, url: string, fields: Record<string, string> = {}) => env.server.inject({
  method: 'POST', url: `${w()}${url}`,
  headers: { ...form(who).headers, accept: 'application/json' },
  payload: new URLSearchParams({ _csrf: who.csrf, ...fields }).toString(),
});

/** Where the page's POST forms send things (sign out aside). */
function postTargets(body: string): string[] {
  return [...body.matchAll(/<form\b[^>]*\bmethod="post"[^>]*\baction="([^"]+)"/g)].map((m) => m[1]!).filter((a) => a !== '/logout');
}

async function join(role: 'admin' | 'moderator', name: string, access?: MemberAccess['access']): Promise<Admin> {
  const person = await makeAdmin(env, name);
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, role)}`, ...form(person) });
  if (access) await grant(env, ws.workspace.id, person.user.id, access);
  return person;
}

async function addType(name: string, label: string | null = null): Promise<TicketType> {
  await createTicketType(env.db, ws.workspace.id, { name, description: null, label, title_prefix: null, guidance: null, placeholder: null, enabled: true });
  return (await listTicketTypes(env.db, ws.workspace.id)).find((t) => t.name === name)!;
}

const sectionsFor = (t: TicketType) => {
  const s = defaultForm(t);
  const fields: Record<string, string | string[]> = { sec: s.map((x) => x.key) };
  for (const x of s) Object.assign(fields, { [`${x.key}.kind`]: x.kind, [`${x.key}.label`]: x.label, [`${x.key}.hint`]: x.hint, [`${x.key}.placeholder`]: x.placeholder, [`${x.key}.text`]: x.text, [`${x.key}.max`]: String(x.maxFiles) });
  return fields;
};

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App' }, { name: 'Website', repoIndex: 1 }] });
});
afterAll(async () => {
  await testDb().end();
});

describe('Discord tickets › Panel', () => {
  it('without access: 403 on the page and on every change', async () => {
    const mod = await join('moderator', 'nora', { inbox: 'edit', types: 'edit', 'ticket-settings': 'edit' });
    expect((await page(mod, '/tickets/panel')).statusCode).toBe(403);
    for (const url of ['/tickets/panel', '/tickets/panel/remove', '/tickets/panel/test']) {
      expect((await post(mod, url, { intent: 'publish', panel_title: 'Changed', app_id: ws.apps[0]!.id })).statusCode, url).toBe(403);
    }
    expect(env.discord.messages.size).toBe(0);
    expect(env.github.allIssues()).toHaveLength(0);
    expect((await env.db.query('SELECT panel_title FROM workspaces WHERE id = $1', [ws.workspace.id])).rows[0].panel_title).toBeNull();
  });

  it('View shows the settings, health and live preview with every control turned off', async () => {
    await addType('Bug report');
    // A problem whose fix is on a page this moderator can't change.
    env.github.repos.get(ws.repoIds[1]!)!.has_issues = false;
    const mod = await join('moderator', 'vera', { panel: 'view' });
    const res = await page(mod, '/tickets/panel');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('<fieldset class="plain view-only" disabled>');
    expect(body).toContain('View only. Ask an admin if you need to change the panel.');
    expect(body).toContain('title="You can see'); // the View only tag in the header
    // Settings and preview are all there.
    expect(body).toContain('name="panel_title"');
    expect(body).toContain('id="channel"');
    expect(body).toContain('Website: Issues are disabled');
    expect(body).toContain('<h4 id="pv-title">');
    expect(body).toContain('Preview of the ticket panel in Discord');
    expect(body).toContain('What kind of ticket is this?');
    // Nothing to publish, remove, test or reset, and no forms that would.
    for (const text of ['Publish panel', 'Save changes', 'Remove panel', 'Send test', 'Test ticket', 'Reset to default', 'data-reset-fields', 'data-dirty']) expect(body, text).not.toContain(text);
    expect(postTargets(body)).toEqual([]);
    // Fix links to pages they can't use stay as text: Edit app, and the type's form page.
    expect(body).not.toContain(`href="${w()}/apps/${ws.apps[1]!.id}/edit"`);
    expect(body).not.toContain(`${w()}/tickets/types/`);
    expect(body).not.toContain('style="');

    // Every change is refused, and nothing reaches Discord or GitHub.
    for (const url of ['/tickets/panel', '/tickets/panel/remove', '/tickets/panel/test']) {
      expect((await post(mod, url, { intent: 'publish', panel_title: 'Changed', app_id: ws.apps[0]!.id })).statusCode, url).toBe(403);
    }
    expect(env.discord.messages.size).toBe(0);
    expect(env.github.allIssues()).toHaveLength(0);
    expect((await env.db.query('SELECT panel_title FROM workspaces WHERE id = $1', [ws.workspace.id])).rows[0].panel_title).toBeNull();
  });

  it('View never links to setup pages that stay with admins', async () => {
    env.discord.botGuildIds.delete(ws.guildId);
    const mod = await join('moderator', 'vic', { panel: 'view' });
    const body = (await page(mod, '/tickets/panel')).body;
    expect(body).toContain('The bot is not in this Discord server');
    expect(body).not.toContain(`href="${w()}/setup/discord"`);
    // The owner gets the fix link.
    expect((await page(ws.owner, '/tickets/panel')).body).toContain(`href="${w()}/setup/discord"`);
  });

  it('Edit can change, publish, test and remove the panel', async () => {
    const mod = await join('moderator', 'eli', { panel: 'edit', apps: 'edit', types: 'view' });
    env.github.repos.get(ws.repoIds[1]!)!.has_issues = false;
    const before = await page(mod, '/tickets/panel');
    expect(before.statusCode).toBe(200);
    expect(before.body).not.toContain('view-only');
    expect(postTargets(before.body)).toEqual([`${w()}/tickets/panel`, `${w()}/tickets/panel/test`]);
    expect(before.body).toContain('Send test');
    // Fix links they can follow are kept.
    expect(before.body).toContain(`href="${w()}/apps/${ws.apps[1]!.id}/edit"`);
    env.github.repos.get(ws.repoIds[1]!)!.has_issues = true;

    const saved = await post(mod, '/tickets/panel', { panel_title: 'Need help? Ask here', intent: 'publish' });
    expect(saved.statusCode).toBe(302);
    expect((await env.db.query('SELECT panel_title FROM workspaces WHERE id = $1', [ws.workspace.id])).rows[0].panel_title).toBe('Need help? Ask here');
    expect(env.discord.messages.size).toBe(1);
    expect(postTargets((await page(mod, '/tickets/panel')).body)).toContain(`${w()}/tickets/panel/remove`);

    const test = await post(mod, '/tickets/panel/test', { app_id: ws.apps[0]!.id });
    expect(test.statusCode).toBe(302);
    expect(test.headers.location).toMatch(new RegExp(`^${w()}/tickets/`));
    expect(env.github.allIssues()).toHaveLength(1);

    expect((await post(mod, '/tickets/panel/remove')).statusCode).toBe(302);
    expect(await getPanel(env.db, ws.workspace.id)).toBeNull();
  });
});

describe('Discord tickets › Ticket types', () => {
  it('without access: 403 on every page and every change', async () => {
    const question = await addType('Question', 'question');
    const mod = await join('moderator', 'nina', { inbox: 'edit', panel: 'edit', 'ticket-settings': 'edit' });
    for (const url of ['/tickets/types', '/tickets/types/new', `/tickets/types/${question.id}/edit`, `/tickets/types/${question.id}/form`]) {
      expect((await page(mod, url)).statusCode, url).toBe(403);
    }
    await expectNoChanges(mod, question);
  });

  it('View shows the list, each type and its form read-only', async () => {
    const question = await addType('Question', 'question');
    const bug = await addType('Bug report', 'bug');
    await saveTicketTypeForm(env.db, ws.workspace.id, bug.id, defaultForm(bug).filter((s) => s.kind !== 'files'));
    const mod = await join('moderator', 'val', { types: 'view' });

    const list = await page(mod, '/tickets/types');
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('Question');
    expect(list.body).toContain('<code>question</code> is missing'); // the label check still shows
    expect(list.body).toContain('See the Question form');
    expect(list.body).toContain('title="You can see');
    for (const text of ['New type', 'Create missing labels', '/toggle', '/move', '/delete', 'Delete type', 'Move up', 'role="switch"', `href="${w()}/tickets/types/new"`]) expect(list.body, text).not.toContain(text);
    expect(postTargets(list.body)).toEqual([]);

    expect((await page(mod, '/tickets/types/new')).statusCode).toBe(403);

    const detail = await page(mod, `/tickets/types/${question.id}/edit`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('<fieldset class="plain view-only" disabled>');
    expect(detail.body).toContain('value="Question"');
    expect(detail.body).toContain('View only. Ask an admin if you need to change this type.');
    expect(detail.body).toContain('See form');
    for (const text of ['Save changes', 'Edit form', 'label-suggestions', 'placeholder="bug"']) expect(detail.body, text).not.toContain(text);
    expect(postTargets(detail.body)).toEqual([]);

    const builder = await page(mod, `/tickets/types/${bug.id}/form`);
    expect(builder.statusCode).toBe(200);
    expect(builder.body).toContain('<fieldset class="plain view-only" disabled>');
    expect(builder.body).toContain('Customized');
    expect(builder.body).toContain('id="form-preview"');
    expect(builder.body).toContain('Always included');
    expect(builder.body).toContain('View only. Ask an admin if you need to change this form.');
    for (const text of ['Save form', 'Restore the default form', 'data-fb-add', 'data-fb-move', 'data-fb-remove', 'data-fb-template', 'id="form-builder"', 'Add a section']) expect(builder.body, text).not.toContain(text);
    expect(postTargets(builder.body)).toEqual([]);
    expect(builder.body).not.toContain('style="');

    await expectNoChanges(mod, question);
  });

  it('Edit can add, change, switch, move, delete types, edit forms and create labels', async () => {
    const question = await addType('Question', 'question');
    const mod = await join('moderator', 'eva', { types: 'edit' });

    const list = await page(mod, '/tickets/types');
    expect(list.body).toContain('New type');
    expect(list.body).toContain('Create missing labels');
    expect(postTargets(list.body)).toContain(`${w()}/tickets/types/${question.id}/toggle`);
    expect((await page(mod, '/tickets/types/new')).statusCode).toBe(200);
    expect(postTargets((await page(mod, `/tickets/types/${question.id}/edit`)).body)).toEqual([`${w()}/tickets/types/${question.id}`]);
    expect((await page(mod, `/tickets/types/${question.id}/form`)).body).toContain('id="form-builder"');

    expect((await post(mod, '/tickets/types', { name: 'Bug report', label: 'bug', enabled: '1' })).statusCode).toBe(302);
    const bug = (await listTicketTypes(env.db, ws.workspace.id)).find((t) => t.name === 'Bug report')!;
    expect(bug).toBeTruthy();
    expect((await post(mod, `/tickets/types/${question.id}`, { name: 'Questions', label: 'question', enabled: '1' })).statusCode).toBe(302);
    expect((await getTicketType(env.db, ws.workspace.id, question.id))!.name).toBe('Questions');

    // Labels are checked for types shown on the panel, so before switching it off.
    await post(mod, '/tickets/types/create-labels');
    expect(env.github.repos.get(ws.repoIds[0]!)!.labels).toContain('question');

    expect((await postJson(mod, `/tickets/types/${question.id}/toggle`, { set: '1' })).json()).toMatchObject({ ok: true });
    expect((await getTicketType(env.db, ws.workspace.id, question.id))!.enabled).toBe(false);
    await post(mod, `/tickets/types/${bug.id}/move`, { direction: 'up' });
    expect((await listTicketTypes(env.db, ws.workspace.id)).map((t) => t.name)).toEqual(['Bug report', 'Questions']);

    const sections = sectionsFor(bug);
    expect((await post(mod, `/tickets/types/${bug.id}/form`, { ...sections, 'intro.text': 'Tell us what broke.' })).statusCode).toBe(302);
    expect(formFor((await getTicketType(env.db, ws.workspace.id, bug.id))!).find((s) => s.kind === 'intro')!.text).toBe('Tell us what broke.');
    expect((await page(mod, `/tickets/types/${bug.id}/form`)).body).toContain('Restore the default form');
    await post(mod, `/tickets/types/${bug.id}/form/reset`);
    expect((await getTicketType(env.db, ws.workspace.id, bug.id))!.form).toBeNull();

    await post(mod, `/tickets/types/${question.id}/delete`);
    expect(await getTicketType(env.db, ws.workspace.id, question.id)).toBeNull();
  });
});

/** Every ticket type change is refused for this person, and nothing changes. */
async function expectNoChanges(who: Admin, t: TicketType) {
  const sections = sectionsFor(t);
  const changes: [string, Record<string, string | string[]>][] = [
    ['/tickets/types', { name: 'Sneaky', enabled: '1' }],
    [`/tickets/types/${t.id}`, { name: 'Renamed', enabled: '1' }],
    [`/tickets/types/${t.id}/toggle`, { set: '1' }],
    [`/tickets/types/${t.id}/move`, { direction: 'up' }],
    [`/tickets/types/${t.id}/form`, { ...sections, 'intro.text': 'Changed' }],
    [`/tickets/types/${t.id}/form/reset`, {}],
    ['/tickets/types/create-labels', {}],
    [`/tickets/types/${t.id}/delete`, {}],
  ];
  for (const [url, fields] of changes) expect((await post(who, url, fields)).statusCode, url).toBe(403);
  // The switch in the list asks for JSON and gets a JSON refusal.
  const toggle = await postJson(who, `/tickets/types/${t.id}/toggle`, { set: '1' });
  expect(toggle.statusCode).toBe(403);
  expect(toggle.json()).toMatchObject({ ok: false });
  const now = (await getTicketType(env.db, ws.workspace.id, t.id))!;
  expect(now).toMatchObject({ name: t.name, enabled: true, form: null });
  expect((await listTicketTypes(env.db, ws.workspace.id)).map((x) => x.name)).not.toContain('Sneaky');
  expect(env.github.repos.get(ws.repoIds[0]!)!.labels).not.toContain('question');
}

describe('Discord tickets › Settings', () => {
  const limits = { rate_limit_count: '3', rate_limit_window_minutes: '15', duplicate_window_minutes: '0' };
  const stored = async () => (await env.db.query('SELECT rate_limit_count, rate_limit_window_minutes, duplicate_window_minutes FROM workspaces WHERE id = $1', [ws.workspace.id])).rows[0];

  it('without access: 403 on the page and on saving', async () => {
    const before = await stored();
    const mod = await join('moderator', 'noah', { inbox: 'edit', panel: 'edit', types: 'edit' });
    expect((await page(mod, '/tickets/settings')).statusCode).toBe(403);
    expect((await post(mod, '/tickets/settings', limits)).statusCode).toBe(403);
    expect(await stored()).toEqual(before);
  });

  it('View shows the limits read-only; saving is refused', async () => {
    const before = await stored();
    const mod = await join('moderator', 'vince', { 'ticket-settings': 'view' });
    const res = await page(mod, '/tickets/settings');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<fieldset class="plain view-only" disabled>');
    expect(res.body).toContain(`name="rate_limit_count" value="${before.rate_limit_count}"`);
    expect(res.body).toContain('View only. Ask an admin if you need to change these limits.');
    expect(res.body).not.toContain('Save changes');
    expect(postTargets(res.body)).toEqual([]);
    expect((await post(mod, '/tickets/settings', limits)).statusCode).toBe(403);
    expect(await stored()).toEqual(before);
  });

  it('Edit saves the limits', async () => {
    const mod = await join('moderator', 'emma', { 'ticket-settings': 'edit' });
    const res = await page(mod, '/tickets/settings');
    expect(postTargets(res.body)).toEqual([`${w()}/tickets/settings`]);
    expect(res.body).toContain('Save changes');
    expect((await post(mod, '/tickets/settings', limits)).statusCode).toBe(302);
    expect(await stored()).toEqual({ rate_limit_count: 3, rate_limit_window_minutes: 15, duplicate_window_minutes: 0 });
  });
});

describe('admins', () => {
  it('keep every control on Panel, Ticket types and Settings', async () => {
    const t = await addType('Question');
    const admin = await join('admin', 'ada');
    for (const who of [ws.owner, admin]) {
      const panel = await page(who, '/tickets/panel');
      expect(postTargets(panel.body)).toEqual([`${w()}/tickets/panel`, `${w()}/tickets/panel/test`]);
      expect(panel.body).not.toContain('view-only');
      expect(panel.body).toContain(`href="${w()}/tickets/types/${t.id}/form"`);
      const types = await page(who, '/tickets/types');
      expect(types.body).toContain('New type');
      expect(postTargets(types.body)).toEqual(expect.arrayContaining([`${w()}/tickets/types/${t.id}/toggle`, `${w()}/tickets/types/${t.id}/delete`]));
      expect((await page(who, `/tickets/types/${t.id}/form`)).body).toContain('id="form-builder"');
      expect(postTargets((await page(who, '/tickets/settings')).body)).toEqual([`${w()}/tickets/settings`]);
    }
    expect((await post(admin, '/tickets/settings', { rate_limit_count: '4', rate_limit_window_minutes: '10', duplicate_window_minutes: '5' })).statusCode).toBe(302);
    expect((await post(admin, `/tickets/types/${t.id}`, { name: 'Questions', enabled: '1' })).statusCode).toBe(302);
  });
});

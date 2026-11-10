import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLinkedWorkspace, listLinked } from '../src/domain/linked.js';
import { checkPanel, publishPanel } from '../src/domain/panel.js';
import { createApp, getDiscordConnection, getGitHubConnection, getPanel, saveGitHubConnection } from '../src/domain/store.js';
import type { AppRow, WorkspaceRow } from '../src/domain/types.js';
import { acceptInvite, createInvite, getMembership, getWorkspace, listMemberships, setMemberActions, setMyTickets } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, member, modalSubmit, nextInteractionId, resetDb, sendInteraction, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let main: ConfiguredWorkspace;
let linked: WorkspaceRow;
let mailcraft: AppRow;
const ALEX = '555000000000000031';
const MAILCRAFT_INSTALL = 7990;
const MAILCRAFT_REPO = 9990;

const click = (customId: string, o: { values?: string[]; guild?: string } = {}) =>
  sendInteraction(env, { id: nextInteractionId(), type: 3, token: `tok-${customId}`, guild_id: o.guild ?? main.guildId, member: member(ALEX, 'Alex'), data: { custom_id: customId, ...(o.values ? { values: o.values } : {}) } });
const fresh = async () => {
  main.workspace = (await getWorkspace(env.db, main.workspace.id))!;
  linked = (await getWorkspace(env.db, linked.id))!;
};
/** Someone in the main workspace with this role (a moderator can be global). */
async function join(role: 'admin' | 'moderator', o: { global?: boolean; workspace?: string } = {}): Promise<Admin> {
  const person = await makeAdmin(env);
  const token = await createInvite(env.db, o.workspace ?? main.workspace.id, main.owner.user.id, role, { global: o.global });
  await acceptInvite(env.db, token, person.user.id);
  return person;
}
beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  main = await makeWorkspace(env, { repos: [{ id: 9801, name: 'photocraft', private: false }], apps: [{ name: 'PhotoCraft', repoIndex: 0 }] });
  linked = await createLinkedWorkspace(env.db, main.workspace, 'Mailcraft');
  env.github.addInstallation(MAILCRAFT_INSTALL, 'mailcraft-org', [{ id: MAILCRAFT_REPO, name: 'mailcraft', private: false }]);
  await saveGitHubConnection(env.db, linked.id, { installationId: MAILCRAFT_INSTALL, accountLogin: 'mailcraft-org', accountType: 'Organization', accountAvatarUrl: null, repositorySelection: 'selected', suspended: false }, null);
  mailcraft = await createApp(env.db, linked.id, { name: 'Mailcraft', description: 'Email designer', repo: { id: MAILCRAFT_REPO, owner: 'mailcraft-org', name: 'mailcraft', private: false }, labels: [], enabled: true });
});
afterAll(async () => {
  await testDb().end();
});

describe('Linked workspaces: who is in them', () => {
  it('has the main’s owner and global admins as admins and its global moderators as moderators, with their pages', async () => {
    const admin = await join('admin', { global: true });
    const mainAdmin = await join('admin');
    const globalMod = await join('moderator', { global: true });
    const mod = await join('moderator');
    await grant(env, main.workspace.id, globalMod.user.id, { moderation: 'edit' });

    expect(await getMembership(env.db, main.owner.user.id, linked.id)).toMatchObject({ role: 'owner', via: main.workspace.name });
    expect(await getMembership(env.db, admin.user.id, linked.id)).toMatchObject({ role: 'admin', via: main.workspace.name });
    expect(await getMembership(env.db, globalMod.user.id, linked.id)).toMatchObject({ role: 'moderator', global: true, access: { moderation: 'edit' } });
    expect(await getMembership(env.db, mod.user.id, linked.id)).toBeNull();
    expect(await getMembership(env.db, mainAdmin.user.id, linked.id)).toBeNull();

    // A linked workspace sits right after its main.
    expect((await listMemberships(env.db, admin.user.id)).map((m) => m.workspace.name)).toEqual([main.workspace.name, 'Mailcraft']);
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}/moderation`, ...get(globalMod) })).statusCode).toBe(200);
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}`, ...get(mod) })).statusCode).toBe(404);
  });

  it('invites admins and moderators of its own, who don’t see the main or the server’s pages', async () => {
    const res = await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/invites`, ...form(main.owner, { role: 'admin', global: '1' }) });
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(res.body)![1]!;
    expect(res.body).toContain('Admin invite link');
    const sam = await makeAdmin(env);
    await acceptInvite(env.db, token, sam.user.id);
    expect(await getMembership(env.db, sam.user.id, linked.id)).toMatchObject({ role: 'admin', global: false, local: true });
    expect(await getMembership(env.db, sam.user.id, main.workspace.id)).toBeNull();

    // Sam runs Mailcraft, but the whole server's pages stay with the main's team.
    const at = (path: string) => env.server.inject({ method: 'GET', url: `/w/${linked.id}${path}`, ...get(sam) });
    expect((await at('/setup/github')).statusCode).toBe(200);
    const overview = await at('');
    expect(overview.body).not.toContain(`href="/w/${linked.id}/deployment"`);
    expect(overview.body).not.toContain('Server health');
    for (const path of ['/deployment', '/health']) {
      const page = await at(path);
      expect(page.statusCode).toBe(403);
      expect(page.body).toContain('cover the whole server');
    }

    // Sam invites moderators of Mailcraft (never admins), and removes them; roles stay with the owner.
    const invite = await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/invites`, ...form(sam, { role: 'admin' }) });
    expect(invite.body).toContain('Moderator invite link');
    const lee = await makeAdmin(env);
    await acceptInvite(env.db, /\/invite\/([A-Za-z0-9_-]+)/.exec(invite.body)![1]!, lee.user.id);
    expect(await getMembership(env.db, lee.user.id, linked.id)).toMatchObject({ role: 'moderator', local: true });
    expect((await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${lee.user.id}/role`, ...form(sam, { role: 'admin' }) })).statusCode).toBe(403);
    // Lee can't be given Server health from here either.
    await grant(env, linked.id, lee.user.id, { health: 'view' });
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}/health`, ...get(lee) })).statusCode).toBe(403);
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${lee.user.id}/remove`, ...form(sam) });
    expect(await getMembership(env.db, lee.user.id, linked.id)).toBeNull();
    // Not someone the owner made admin.
    const kit = await join('admin', { workspace: linked.id });
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${kit.user.id}/remove`, ...form(sam) });
    expect(await getMembership(env.db, kit.user.id, linked.id)).toMatchObject({ role: 'admin' });

    const page = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/members`, ...get(main.owner) });
    expect(page.body).toContain(`From ${main.workspace.name}`);
    expect(page.body).toContain('Added in Mailcraft');
  });

  it('makes a global moderator an admin of a linked workspace alone, and back', async () => {
    const benz = await join('moderator', { global: true });
    await grant(env, main.workspace.id, benz.user.id, { moderation: 'edit' });
    const members = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/members`, ...get(main.owner) });
    expect(members.body).toContain(`id="role-${benz.user.id}"`);
    expect(members.body).toContain('Admin of Mailcraft');

    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${benz.user.id}/role`, ...form(main.owner, { role: 'admin' }) });
    expect(await getMembership(env.db, benz.user.id, linked.id)).toMatchObject({ role: 'admin', local: true });
    expect(await getMembership(env.db, benz.user.id, main.workspace.id)).toMatchObject({ role: 'moderator', global: true });
    expect((await env.server.inject({ method: 'GET', url: `/w/${linked.id}/setup/github`, ...get(benz) })).statusCode).toBe(200);
    expect((await listMemberships(env.db, benz.user.id)).map((m) => [m.workspace.name, m.role])).toEqual([[main.workspace.name, 'moderator'], ['Mailcraft', 'admin']]);
    const after = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/members`, ...get(main.owner) });
    expect(after.body).toContain(`global moderator in ${main.workspace.name}`);

    // Back to moderator: through the main again, with the main's pages.
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/members/${benz.user.id}/role`, ...form(main.owner, { role: 'moderator' }) });
    expect(await getMembership(env.db, benz.user.id, linked.id)).toMatchObject({ role: 'moderator', via: main.workspace.name, access: { moderation: 'edit' } });
    expect((await env.db.query('SELECT count(*) AS n FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [linked.id, benz.user.id])).rows[0].n).toBe(0);
  });

  it('makes global admins and moderators from the invite switch or a role change, and taking it away takes the linked workspaces away', async () => {
    const page = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/members?invite=1`, ...get(main.owner) });
    expect(page.body).toContain('Also an admin or moderator in Mailcraft, the same as here.');
    expect(page.body).not.toMatch(/name="global"[^>]*checked/);
    const admin = await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/invites`, ...form(main.owner, { role: 'admin', global: '1' }) });
    expect(admin.body).toContain('Global admin invite link');
    const res = await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/invites`, ...form(main.owner, { role: 'moderator', global: '1' }) });
    expect(res.body).toContain('Global moderator invite link');
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(res.body)![1]!;
    const kim = await makeAdmin(env);
    await acceptInvite(env.db, token, kim.user.id);
    expect(await getMembership(env.db, kim.user.id, linked.id)).toMatchObject({ role: 'moderator' });

    // Moderator only in the main: out of Mailcraft, and their claims there end.
    await env.db.query(`INSERT INTO ticket_claims (id, workspace_id, user_id, repo_id, number) VALUES ('c1', $1, $2, $3, 1)`, [linked.id, kim.user.id, MAILCRAFT_REPO]);
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'moderator' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toBeNull();
    expect((await env.db.query(`SELECT end_reason FROM ticket_claims WHERE id = 'c1'`)).rows[0]).toEqual({ end_reason: 'left' });
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'moderator', global: '1' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toMatchObject({ role: 'moderator', global: true });
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'admin', global: '1' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toMatchObject({ role: 'admin', via: main.workspace.name });
    const members = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/members`, ...get(main.owner) });
    expect(members.body).toContain('Global admin');
    // An admin of the main only: not in Mailcraft.
    await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/members/${kim.user.id}/role`, ...form(main.owner, { role: 'admin' }) });
    expect(await getMembership(env.db, kim.user.id, linked.id)).toBeNull();
  });

  it('is made from the main’s Settings, and not from a linked workspace', async () => {
    const res = await env.server.inject({ method: 'POST', url: `/w/${main.workspace.id}/settings/linked`, ...form(main.owner, { name: 'Notecraft' }) });
    const made = (await listLinked(env.db, main.workspace.id)).find((l) => l.name === 'Notecraft')!;
    expect(res.headers.location).toBe(`/w/${made.id}`);
    expect(made).toMatchObject({ parent_id: main.workspace.id, on_main_panel: true });
    await expect(createLinkedWorkspace(env.db, made, 'Deeper')).rejects.toThrow('can’t have linked workspaces of its own');
    // The workspace switcher offers it too, to the main's owner and admins, from a linked workspace as well.
    for (const w of [main.workspace.id, made.id]) {
      const page = await env.server.inject({ method: 'GET', url: `/w/${w}`, ...get(main.owner) });
      expect(page.body).toContain('New linked workspace…');
      expect(page.body).toContain(`action="/w/${main.workspace.id}/settings/linked"`);
    }
    const globalMod = await join('moderator', { global: true });
    expect((await env.server.inject({ method: 'GET', url: `/w/${made.id}`, ...get(globalMod) })).body).not.toContain('New linked workspace…');
    // An admin of the linked workspace alone can't add workspaces to the main.
    const own = await join('admin', { workspace: made.id });
    expect((await env.server.inject({ method: 'GET', url: `/w/${made.id}`, ...get(own) })).body).not.toContain('New linked workspace…');
    const settings = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/settings`, ...get(main.owner) });
    expect(settings.body).toContain('Linked workspaces');
    expect(settings.body).toContain('GitHub: mailcraft-org');
  });

  it('uses the main’s Discord server and leaves the server-wide tools to the main', async () => {
    expect(await getDiscordConnection(env.db, linked.id)).toMatchObject({ guild_id: main.guildId, workspace_id: linked.id, tickets_channel_id: null });
    const discord = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/setup/discord`, ...get(main.owner) });
    expect(discord.body).toContain(`Mailcraft uses ${main.workspace.name}’s Discord server`);
    expect(discord.body).not.toContain('Disconnect Discord');
    const tools = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/contributors/roles`, ...get(main.owner) });
    expect(tools.body).toContain('Set up in the main workspace');
    const overview = await env.server.inject({ method: 'GET', url: `/w/${linked.id}`, ...get(main.owner) });
    expect(overview.body).not.toContain(`href="/w/${linked.id}/announcements"`);
    expect(overview.body).toContain(`Linked to ${main.workspace.name}`);
  });
});

describe('Linked workspaces: tickets in Discord', () => {
  it('lists its apps on the main’s panel and files them in its own workspace and repository', async () => {
    await publishPanel(env.deps, main.workspace.id, null);
    const posted = [...env.discord.messages.values()].at(-1)!.payload as any;
    // A menu for each workspace, under its name.
    expect(posted.components.map((r: any) => r.components[0].placeholder)).toEqual([`${main.workspace.name}: choose an app…`, 'Mailcraft: choose an app…']);
    expect(posted.components.map((r: any) => r.components[0].options.map((o: { label: string }) => o.label))).toEqual([['PhotoCraft'], ['Mailcraft']]);
    expect(posted.embeds[0].description).toContain('1. Choose your app from its menu.');

    const modal = (await click('tr:pick:1', { values: [mailcraft.public_id] })).json();
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe(`tr:form:${mailcraft.public_id}:${MAILCRAFT_REPO}`);

    const res = await sendInteraction(env, { ...modalSubmit(main, mailcraft, { title: 'Templates vanish', description: 'They disappear after saving.' }), member: member(ALEX, 'Alex') });
    expect(res.json().type).toBe(5);
    await env.worker.drain();
    const sub = (await env.db.query('SELECT workspace_id, installation_id, repo_id, issue_number FROM submissions ORDER BY created_at DESC LIMIT 1')).rows[0];
    expect(sub).toMatchObject({ workspace_id: linked.id, installation_id: MAILCRAFT_INSTALL, repo_id: MAILCRAFT_REPO });
    expect(env.github.repos.get(MAILCRAFT_REPO)!.issues.map((i) => i.title)).toEqual([expect.stringContaining('Templates vanish')]);
    // A server it isn't on can't reach it.
    const other = await makeWorkspace(env);
    expect((await click('tr:pick', { values: [mailcraft.public_id], guild: other.guildId })).json().data.embeds[0].title).toBe('App unavailable');
  });

  it('shows a member’s tickets from both in My tickets on the main’s panel, each with its own workspace’s buttons', async () => {
    await setMyTickets(env.db, main.workspace.id, true);
    await setMemberActions(env.db, linked.id, { details: true, files: false, close: false, text: {} });
    await sendInteraction(env, { ...modalSubmit(main, main.apps[0]!, { title: 'Export crashes', description: 'Every time I export.' }), member: member(ALEX, 'Alex') });
    await sendInteraction(env, { ...modalSubmit(main, mailcraft, { title: 'Templates vanish', description: 'They disappear after saving.' }), member: member(ALEX, 'Alex') });
    await env.worker.drain();
    const list = (await click('tr:mine')).json().data;
    const options = list.components.find((r: any) => r.components[0].type === 3).components[0].options;
    expect(options.map((o: { label: string }) => o.label).sort()).toEqual(['Export crashes', 'Templates vanish']);
    const refs = (await env.db.query('SELECT ref, workspace_id FROM submissions')).rows as { ref: string; workspace_id: string }[];
    const mine = refs.find((r) => r.workspace_id === linked.id)!.ref;
    const theirs = refs.find((r) => r.workspace_id === main.workspace.id)!.ref;
    const labels = async (ref: string) => (await click('tr:mine:t:0', { values: [ref] })).json().data.components.flatMap((r: any) => r.components.map((c: any) => c.label));
    expect(await labels(mine)).toContain('Add details');
    expect(await labels(theirs)).not.toContain('Add details');
  });

  it('can have a panel of its own, whose clicks stay with it', async () => {
    await env.db.query('UPDATE workspaces SET on_main_panel = 0, panel_channel_id = $2, panel_channel_name = $3 WHERE id = $1', [linked.id, main.channelId, 'tickets']);
    await setMyTickets(env.db, linked.id, true);
    await fresh();
    await publishPanel(env.deps, linked.id, null);
    const own = (await getPanel(env.db, linked.id))!;
    const payload = env.discord.messages.get(own.message_id)!.payload as any;
    expect(payload.components[0].components.map((c: { custom_id: string }) => c.custom_id)).toEqual([`tr:open~${linked.id}`, `tr:mine~${linked.id}`]);

    // Open a ticket on it: Mailcraft's form (its only app), still tagged.
    const opened = (await click(`tr:open~${linked.id}`)).json();
    expect(opened.data.custom_id).toBe(`tr:form:${mailcraft.public_id}:${MAILCRAFT_REPO}~${linked.id}`);
    // The main's panel no longer lists Mailcraft: its one app goes straight to PhotoCraft's form.
    expect((await click('tr:open')).json().data.custom_id).toBe(`tr:form:${main.apps[0]!.public_id}:${main.apps[0]!.repo_id}`);
    // My tickets on it is Mailcraft's alone, and its buttons keep the tag.
    const mine = (await click(`tr:mine~${linked.id}`)).json().data;
    expect(JSON.stringify(mine)).not.toMatch(/"custom_id":"tr:[^"~]*"/);
    // A tag for a workspace that isn't linked to this server's: out of date.
    const other = await makeWorkspace(env);
    expect((await click(`tr:open~${other.workspace.id}`)).json().data.embeds[0].title).toBe('Out of date');
  });

  it('chooses its panel on its Panel page, and the main’s Panel page lists it', async () => {
    const page = await env.server.inject({ method: 'GET', url: `/w/${linked.id}/tickets/panel`, ...get(main.owner) });
    expect(page.body).toContain('Where members open tickets');
    expect(page.body).toContain(`On ${main.workspace.name}’s panel`);
    expect(page.body).not.toContain('value="publish"');
    const mainPage = await env.server.inject({ method: 'GET', url: `/w/${main.workspace.id}/tickets/panel`, ...get(main.owner) });
    expect(mainPage.body).toContain('<h3>Menus</h3>');
    expect(mainPage.body).toContain('1 app: Mailcraft');
    expect(mainPage.body).toContain(`id="section_title_${linked.id}"`);

    const res = await env.server.inject({ method: 'POST', url: `/w/${linked.id}/tickets/panel`, ...form(main.owner, { panel_home_sent: '1', panel_home: 'own' }) });
    expect(res.headers.location).toBe(`/w/${linked.id}/tickets/panel`);
    await fresh();
    expect(linked.on_main_panel).toBe(false);
    // Its own panel goes up, then comes down again when it moves back to the main's.
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/tickets/panel`, ...form(main.owner, { channel_id: main.channelId, intent: 'publish' }) });
    expect(await getPanel(env.db, linked.id)).not.toBeNull();
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/tickets/panel`, ...form(main.owner, { panel_home_sent: '1', panel_home: 'main' }) });
    expect(await getPanel(env.db, linked.id)).toBeNull();
  });
});

describe('Linked workspaces: a menu for each workspace', () => {
  const placeholders = (payload: any) => payload.components.map((r: any) => r.components[0].placeholder);

  it('names each menu after its workspace, or what the main’s or the linked workspace’s admins call it', async () => {
    const save = (ws: string, fields: Record<string, string>) => env.server.inject({ method: 'POST', url: `/w/${ws}/tickets/panel`, ...form(main.owner, fields) });
    await save(main.workspace.id, { [`section_title_${main.workspace.id}`]: 'ArtCraft apps', [`section_title_${linked.id}`]: '  Community   Apps ' });
    await fresh();
    expect(main.workspace.panel_section_title).toBe('ArtCraft apps');
    expect(linked.panel_section_title).toBe('Community Apps');
    // The published panel is out of date until it's published again.
    await publishPanel(env.deps, main.workspace.id, null);
    expect(placeholders([...env.discord.messages.values()].at(-1)!.payload)).toEqual(['ArtCraft apps: choose an app…', 'Community Apps: choose an app…']);

    // The linked workspace's page names its own; its name again means "its name".
    const page = (await env.server.inject({ method: 'GET', url: `/w/${linked.id}/tickets/panel`, ...get(main.owner) })).body;
    expect(page).toContain(`Menu name on ${main.workspace.name}’s panel`);
    const res = await save(linked.id, { section_title: 'Mailcraft' });
    await fresh();
    expect(linked.panel_section_title).toBeNull();
    // The main's panel shows the old name until its admins publish it again.
    expect(await checkPanel(env.deps, main.workspace.id, { live: false })).toMatchObject({ state: 'published', outdated: true });
    expect(res.headers.location).toBe(`/w/${linked.id}/tickets/panel`);
    // A workspace that isn't one of the main's can't be named from its page.
    const other = await makeWorkspace(env);
    await save(main.workspace.id, { [`section_title_${other.workspace.id}`]: 'Hijacked' });
    expect((await getWorkspace(env.db, other.workspace.id))!.panel_section_title).toBeNull();
  });

  it('shows the menus privately for Open a ticket, and one workspace’s apps page by page from More apps', async () => {
    await setMyTickets(env.db, main.workspace.id, true);
    await env.db.query('UPDATE workspaces SET panel_section_title = $2 WHERE id = $1', [linked.id, 'Community Apps']);
    for (let n = 0; n < 26; n++) {
      await createApp(env.db, linked.id, { name: `Tool ${String(n).padStart(2, '0')}`, description: null, repo: { id: MAILCRAFT_REPO, owner: 'mailcraft-org', name: 'mailcraft', private: false }, labels: [], enabled: true });
    }
    const picker = (await click('tr:open')).json().data;
    expect(picker.flags & 64).toBe(64);
    expect(placeholders(picker)).toEqual([`${main.workspace.name}: choose an app…`, 'Community Apps: choose an app…']);
    const community = picker.components[1].components[0];
    expect(community.custom_id).toBe('tr:pickp:1');
    expect(community.options).toHaveLength(25);
    expect(community.options.at(-1)).toMatchObject({ label: 'More apps…', value: `__more:${linked.id}`, description: 'Browse all 27 in Community Apps' });

    // More apps: Community Apps' 27, page by page, in place of the menus.
    const more = (await click('tr:pickp:1', { values: [`__more:${linked.id}`] })).json();
    expect(more.type).toBe(7);
    expect(more.data.content).toBe('Choose the app you need help with in Community Apps (page 1 of 2).');
    expect(more.data.components[1].components.map((b: any) => b.custom_id)).toEqual([`tr:page:-1:${linked.id}`, `tr:page:1:${linked.id}`]);
    const next = (await click(`tr:page:1:${linked.id}`)).json().data;
    expect(next.components[0].components[0].options.map((o: any) => o.label)).toEqual(['Tool 24', 'Tool 25']);
    // A pick from it files in the linked workspace.
    const modal = (await click('tr:pickp', { values: [mailcraft.public_id] })).json();
    expect(modal.type).toBe(9);
    // Another workspace's ID isn't a menu here.
    const other = await makeWorkspace(env);
    expect((await click(`tr:page:0:${other.workspace.id}`)).json().data.embeds[0].title).toBe('Out of date');
  });

  it('keeps one menu when only one workspace has apps on the panel', async () => {
    await env.db.query('UPDATE apps SET enabled = 0 WHERE workspace_id = $1', [linked.id]);
    await publishPanel(env.deps, main.workspace.id, null);
    const posted = [...env.discord.messages.values()].at(-1)!.payload as any;
    expect(posted.components).toHaveLength(1);
    expect(posted.components[0].components[0]).toMatchObject({ custom_id: 'tr:pick', placeholder: 'Choose an app…' });
  });
});

describe('Install links', () => {
  async function makeLink(ws: WorkspaceRow) {
    await env.db.query('DELETE FROM github_connections WHERE workspace_id = $1', [ws.id]);
    await env.server.inject({ method: 'POST', url: `/w/${ws.id}/setup/github/share`, ...form(main.owner) });
    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.id}/setup/github`, ...get(main.owner) });
    return /\/github\/connect\/([A-Za-z0-9_-]+)/.exec(page.body)![1]!;
  }
  const stateOf = (location: string) => new URL(location).searchParams.get('state')!;

  it('lets the organization’s owner install the app without an account, once', async () => {
    const token = await makeLink(linked);
    const landing = await env.server.inject({ method: 'GET', url: `/github/connect/${token}` });
    expect(landing.body).toContain('Connect GitHub for Mailcraft');
    const go = await env.server.inject({ method: 'GET', url: `/github/connect/${token}/install` });
    expect(go.headers.location).toContain('/installations/new?state=');

    env.github.addInstallation(8123, 'their-org', [{ id: 8124, name: 'mailer' }]);
    env.github.addInstallation(8200, 'someone-else', [{ id: 8201, name: 'other' }]);
    env.github.userInstallationIds = [8123];
    // An installation they can't access isn't connected.
    const spoof = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&installation_id=8200&setup_action=install&state=${stateOf(go.headers.location as string)}` });
    expect(spoof.body).toContain('Nothing was connected');
    expect(await getGitHubConnection(env.db, linked.id)).toBeNull();

    const again = await env.server.inject({ method: 'GET', url: `/github/connect/${token}/install` });
    const done = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&installation_id=8123&setup_action=install&state=${stateOf(again.headers.location as string)}` });
    expect(done.body).toContain('Connected');
    expect(await getGitHubConnection(env.db, linked.id)).toMatchObject({ installation_id: 8123, account_login: 'their-org', connected_by: null });
    expect((await env.server.inject({ method: 'GET', url: `/github/connect/${token}` })).body).toContain('doesn’t work anymore');
  });

  it('asks which account when they sign in with several, and stops when the admins stop it', async () => {
    const token = await makeLink(linked);
    env.github.addInstallation(8301, 'org-a', [{ id: 8302, name: 'a' }]);
    env.github.addInstallation(8311, 'org-b', [{ id: 8312, name: 'b' }]);
    env.github.userInstallationIds = [8301, 8311];
    const go = await env.server.inject({ method: 'GET', url: `/github/connect/${token}/signin` });
    expect(go.headers.location).toContain('/login/oauth/authorize');
    const pick = await env.server.inject({ method: 'GET', url: `/oauth/github/callback?code=good-code&state=${stateOf(go.headers.location as string)}` });
    const href = /href="(\/github\/connect\/choose\?[^"]+installation_id=8311)"/.exec(pick.body)![1]!.replace(/&amp;/g, '&');
    expect((await env.server.inject({ method: 'GET', url: href })).body).toContain('Connected');
    expect(await getGitHubConnection(env.db, linked.id)).toMatchObject({ installation_id: 8311 });

    const second = await makeLink(linked);
    await env.server.inject({ method: 'POST', url: `/w/${linked.id}/setup/github/share/revoke`, ...form(main.owner) });
    expect((await env.server.inject({ method: 'GET', url: `/github/connect/${second}` })).body).toContain('doesn’t work anymore');
  });
});

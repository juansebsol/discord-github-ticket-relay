import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { announcementPayload, fill, githubNotes, resolveButtons, suggestButton } from '../src/announcements/message.js';
import { EPHEMERAL } from '../src/discord/messages.js';
import { createInvite } from '../src/domain/workspaces.js';
import { eventually, form, get, grant, makeAdmin, makeApp, makeWorkspace, member, nextInteractionId, resetDb, sendInteraction, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let releasesChannel: string;
const ROLE_ALL = '700000000000000001';
const ROLE_VECTOR = '700000000000000002';
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string> = {}, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const tick = () => env.triage.engine.announcer.tick();
const rows = async () => (await env.db.query('SELECT * FROM announcements ORDER BY tag')).rows;
const posts = () => [...env.discord.messages.entries()].filter(([, m]) => m.channelId === releasesChannel).map(([id, m]) => ({ id, ...m.payload }));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function release(tag: string, publishedAt: string, o: { body?: string; prerelease?: boolean; name?: string } = {}) {
  return {
    tag, name: o.name, published_at: publishedAt, prerelease: o.prerelease, body: o.body ?? `## What's Changed\n* Faster export by @dev in https://github.com/o/r/pull/12\n* chore: bump deps`,
    assets: [
      { name: `app-${tag}-windows-arm64.msi`, downloads: 0 },
      { name: `app-${tag}-windows-x64.msi`, downloads: 0 },
      { name: `app-${tag}-windows-x64-portable.zip`, downloads: 0 },
      { name: `app-${tag}-macos-universal.dmg`, downloads: 0 },
      { name: `app-${tag}-linux-x86_64.AppImage`, downloads: 0 },
      { name: 'SHA256SUMS.txt', downloads: 0 },
    ],
  };
}

/** A download button per desktop platform, found by file name in every release. */
const DOWNLOADS = { buttons: '1', btn_label: ['Windows', 'macOS', 'Linux'], btn_url: ['{file:*-windows-x64.msi}', '{file:*-macos-universal.dmg}', '{file:*-linux-x86_64.AppImage}'], btn_app: ['', '', ''], notes_button: '1' };

/** Announcements on, posting in #releases (an announcement channel). */
async function turnOn(fields: Record<string, string | string[]> = {}) {
  const res = await env.server.inject({ method: 'POST', url: `${w()}/announcements/settings`, ...form(ws.owner, {
    enabled: '1', mode: 'review', channel_id: releasesChannel, notes_source: 'claude', apps: '1', ...DOWNLOADS,
    ...Object.fromEntries(ws.apps.map((a) => [`app_${a.id}_on`, '1'])),
    ...fields,
  }) });
  expect(res.statusCode).toBe(302);
}

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'PhotoCraft', repoIndex: 0 }, { name: 'VectorCraft', repoIndex: 1 }] });
  const g = env.discord.guilds.get(ws.guildId)!;
  releasesChannel = String(BigInt(ws.channelId) + 5n);
  g.channels.push({ id: releasesChannel, type: 5, name: 'releases', position: 1 });
  g.roles.push({ id: ROLE_ALL, name: 'App Updates', permissions: '0', position: 0, mentionable: true }, { id: ROLE_VECTOR, name: 'VectorCraft Updates', permissions: '0', position: 0, mentionable: false });
  await env.server.inject({ method: 'POST', url: `${w()}/settings/claude/key`, ...form(ws.owner, { api_key: 'sk-ant-test-key-0123456789abcdef' }) });
});
afterAll(async () => {
  await testDb().end();
});

describe('Announcements: the message', () => {
  const r = { appId: 'app-photo', appName: 'PhotoCraft', tag: 'v1.1.0', releaseName: null, releaseUrl: 'https://github.com/o/r/releases/tag/v1.1.0', publishedAt: new Date('2026-10-20T10:00:00Z'), notes: '- Faster', files: release('v1.1.0', '').assets.map((a) => ({ name: a.name, url: `https://dl/${a.name}` })) };

  it('fills the templates and pings only the chosen role', () => {
    const s = { messageText: null, titleText: null, bodyText: 'Update now!\n{notes}\n{unknown}', buttons: [], notesButton: true, notesButtonLabel: null };
    const pinged = announcementPayload(r, s, ROLE_ALL);
    expect(pinged.content).toBe(`<@&${ROLE_ALL}> **PhotoCraft v1.1.0** is out!`);
    expect(pinged.allowed_mentions).toEqual({ parse: [], roles: [ROLE_ALL] });
    expect(pinged.embeds[0]).toMatchObject({ title: 'What’s new in v1.1.0', url: r.releaseUrl, description: 'Update now!\n- Faster\n{unknown}', timestamp: '2026-10-20T10:00:00.000Z' });
    expect(pinged.components).toEqual([{ type: 1, components: [{ type: 2, style: 5, label: 'Release notes', url: r.releaseUrl }] }]);
    const quiet = announcementPayload(r, { ...s, notesButton: false }, null);
    expect(quiet.content).toBe('**PhotoCraft v1.1.0** is out!');
    expect(quiet.allowed_mentions).toEqual({ parse: [] });
    expect(quiet.components).toEqual([]);
    expect(fill('{app} {nope}', { app: 'A', version: '', name: '', notes: '', link: '', role: '' })).toBe('A {nope}');
  });

  it('builds the buttons you set: a file of the release by name, a web address with the version, or a button for one app', () => {
    const buttons = [
      { label: 'Windows', url: '{file:*-WINDOWS-x64.msi}', appId: null },
      { label: 'Windows ARM', url: '{file:*-windows-arm64.exe}', appId: null },
      { label: 'Website {number}', url: 'https://photocraft.app/download/{number}?app={app}', appId: null },
      { label: 'Changelog', url: '{link}#changes', appId: null },
      { label: 'Vector only', url: 'https://vector.app', appId: 'app-vector' },
      { label: 'Broken', url: 'not a link', appId: null },
    ];
    expect(resolveButtons(buttons, r)).toEqual({
      shown: [
        { label: 'Windows', url: 'https://dl/app-v1.1.0-windows-x64.msi', file: 'app-v1.1.0-windows-x64.msi' },
        { label: 'Website 1.1.0', url: 'https://photocraft.app/download/1.1.0?app=PhotoCraft', file: null },
        { label: 'Changelog', url: `${r.releaseUrl}#changes`, file: null },
      ],
      left: [{ label: 'Windows ARM', why: 'no file matches *-windows-arm64.exe' }, { label: 'Broken', why: 'its link isn’t a web address' }],
    });
    // More than five go on more rows; the release notes button keeps its own label.
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `B${i}`, url: `https://x.y/${i}`, appId: null }));
    const payload = announcementPayload(r, { messageText: null, titleText: null, bodyText: null, buttons: many, notesButton: true, notesButtonLabel: 'All the changes' }, null);
    expect(payload.components.map((row) => row.components.map((b) => b.label))).toEqual([['B0', 'B1', 'B2', 'B3', 'B4'], ['B5', 'All the changes']]);
    // Ready-made from a file: the name from the version on, so it finds the same file next time.
    expect(suggestButton('photocraft-0.12.0-windows-arm64.msi', 'v0.12.0')).toEqual({ label: 'Windows ARM (MSI)', url: '{file:*-windows-arm64.msi}', appId: null });
    expect(suggestButton('PhotoCraft.dmg', 'v0.12.0')).toEqual({ label: 'macOS (DMG)', url: '{file:PhotoCraft.dmg}', appId: null });
  });

  it('makes GitHub’s notes fit Discord: no comments, images or pings', () => {
    expect(githubNotes('<!-- hidden -->\n![shot](https://x/y.png)\n#### Fixes\n- Crash fixed @everyone\n\n\n\n<details><summary>More</summary>All</details>'))
      .toBe('### Fixes\n- Crash fixed @​everyone\n\nMoreAll');
  });
});

describe('Announcements: new releases', () => {
  it('is off until turned on, then announces only releases published after; Review first waits for someone to post', async () => {
    repo().releases = [release('v1.0.0', ago(60 * 24))];
    await tick();
    expect(await rows()).toEqual([]);
    expect((await page('/announcements')).body).toContain('Announcements are off');

    await turnOn();
    await tick();
    expect(await rows()).toEqual([]);
    repo().releases!.unshift(release('v1.1.0', new Date(Date.now() + 1000).toISOString(), { name: 'The export one' }));
    // Checked every 5 minutes: the next check finds it.
    await env.db.query('UPDATE announcement_checks SET checked_at = $1', [new Date(Date.now() - 6 * 60_000)]);
    await tick();
    const [row] = await rows();
    expect(row).toMatchObject({ tag: 'v1.1.0', app_name: 'PhotoCraft', status: 'waiting', notes_by: 'claude', notes: '- **Faster exports**\n- Fixed a crash when opening big files', release_name: 'The export one' });
    const asked = env.anthropic.requests.at(-1)!.body;
    expect(asked.system[0].text).toMatch(/^You write release announcements/);
    expect(asked.messages[0].content).toContain('Faster export by @dev');
    expect(posts()).toEqual([]);

    const list = (await page('/announcements')).body;
    expect(list).toContain('Waiting to post');
    expect(list).toMatch(/PhotoCraft<\/span> <span class="mono">v1\.1\.0/);
    const one = await page(`/announcements/${row.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.body).toContain('Post now');
    expect(one.body).toContain('Faster exports');

    expect((await post(`/announcements/${row.id}`, { intent: 'post', notes: row.notes })).statusCode).toBe(302);
    const [sent] = posts();
    expect(sent).toMatchObject({ content: '**PhotoCraft v1.1.0** is out!', allowed_mentions: { parse: [] }, nonce: row.id.slice(0, 25), enforce_nonce: true });
    expect(sent!.embeds[0]).toMatchObject({ title: 'What’s new in v1.1.0', description: row.notes });
    expect(sent!.components[0].components.map((b: { label: string; url: string }) => b.label)).toEqual(['Windows', 'macOS', 'Linux', 'Release notes']);
    expect(sent!.components[0].components[0].url).toMatch(/releases\/download\/v1\.1\.0\/app-v1\.1\.0-windows-x64\.msi$/);
    // An announcement channel: published to the servers following it too.
    expect(env.discord.crossposts).toEqual([sent!.id]);
    expect((await rows())[0]).toMatchObject({ status: 'posted', message_id: sent!.id, channel_id: releasesChannel, posted_by: ws.owner.user.id });
    // A second press doesn't post it again.
    await post(`/announcements/${row.id}`, { intent: 'post' });
    expect(posts()).toHaveLength(1);
  });

  it('Automatic posts on its own, pinging the chosen role; an app can have its own role or none; pre-releases wait to be turned on', async () => {
    const [photo, vector] = ws.apps;
    await turnOn({ mode: 'auto', ping_enabled: '1', role_id: ROLE_ALL, [`app_${vector!.id}_role`]: 'none' });
    repo(0).releases = [release('v2.0.0', new Date(Date.now() + 1000).toISOString()), release('v2.1.0-beta', new Date(Date.now() + 2000).toISOString(), { prerelease: true })];
    repo(1).releases = [release('v5.0.0', new Date(Date.now() + 1000).toISOString())];
    await tick();
    const sent = posts();
    expect(sent.map((m) => m.content).sort()).toEqual(['**VectorCraft v5.0.0** is out!', `<@&${ROLE_ALL}> **PhotoCraft v2.0.0** is out!`]);
    expect(sent.find((m) => m.content.includes('PhotoCraft'))!.allowed_mentions).toEqual({ parse: [], roles: [ROLE_ALL] });
    expect((await rows()).map((r) => [r.tag, r.status, r.posted_by])).toEqual([['v2.0.0', 'posted', null], ['v5.0.0', 'posted', null]]);

    // VectorCraft gets its own role (which can't be pinged yet: the health list says so).
    await turnOn({ mode: 'auto', ping_enabled: '1', role_id: ROLE_ALL, include_prereleases: '1', [`app_${vector!.id}_role`]: ROLE_VECTOR, [`app_${photo!.id}_channel`]: ws.channelId });
    const settings = (await page('/announcements/settings')).body;
    expect(settings).toContain('@VectorCraft Updates won’t be pinged');
    expect(settings).toContain('@App Updates can be pinged');
    await env.db.query('UPDATE announcement_checks SET checked_at = $1', [new Date(Date.now() - 6 * 60_000)]);
    // Pre-releases on: the beta (published since announcements were on) is announced, in PhotoCraft's own channel.
    await tick();
    expect((await rows()).map((r) => r.tag)).toEqual(['v2.0.0', 'v2.1.0-beta', 'v5.0.0']);
    const beta = [...env.discord.messages.values()].find((m) => m.payload.content.includes('v2.1.0-beta'))!;
    expect(beta.channelId).toBe(ws.channelId);
    expect((await rows()).find((r) => r.tag === 'v2.1.0-beta').prerelease).toBe(1);
  });

  it('falls back to GitHub’s notes when Claude can’t, and the notes can be edited, rewritten, updated and deleted in Discord', async () => {
    env.anthropic.queue.push({ status: 401, type: 'authentication_error', message: 'invalid x-api-key' });
    await turnOn();
    repo().releases = [release('v3.0.0', new Date(Date.now() + 1000).toISOString(), { body: '<!-- x -->\n- Fixed it @here' })];
    await tick();
    let [row] = await rows();
    expect(row).toMatchObject({ status: 'waiting', notes_by: 'github', notes: '- Fixed it @​here' });
    expect(row.notes_error).toMatch(/^Claude couldn’t write the notes/);

    await post(`/announcements/${row.id}`, { intent: 'save', notes: '- Fixed the crash' });
    [row] = await rows();
    expect(row).toMatchObject({ notes: '- Fixed the crash', notes_by: 'edited' });

    await post(`/announcements/${row.id}`, { intent: 'rewrite' });
    expect((await rows())[0].status).toBe('writing');
    expect((await page(`/announcements/${row.id}`)).body).toContain('data-live="3000"');
    await tick();
    [row] = await rows();
    // Rewritten notes wait to be posted, even in Automatic mode.
    expect(row).toMatchObject({ status: 'waiting', notes_by: 'claude', notes_error: null });

    await post(`/announcements/${row.id}`, { intent: 'post', notes: row.notes });
    const id = posts()[0]!.id;
    await post(`/announcements/${row.id}`, { intent: 'update', notes: '- Even faster' });
    expect(env.discord.messages.get(id)!.payload.embeds[0].description).toBe('- Even faster');
    await post(`/announcements/${row.id}`, { intent: 'delete' });
    expect(env.discord.messages.has(id)).toBe(false);
    expect((await rows())[0]).toMatchObject({ status: 'waiting', message_id: null });
    await post(`/announcements/${row.id}`, { intent: 'skip' });
    expect((await rows())[0].status).toBe('skipped');
  });

  it('announces an older release by hand: it waits to be posted, even in Automatic mode', async () => {
    await turnOn({ mode: 'auto' });
    repo().releases = [release('v0.9.0', ago(60 * 24 * 30))];
    const pick = await page(`/announcements/new?app=${ws.apps[0]!.id}`);
    expect(pick.body).toContain('value="v0.9.0"');
    const res = await post('/announcements/new', { app: ws.apps[0]!.id, tag: 'v0.9.0' });
    const [row] = await rows();
    expect(res.headers.location).toBe(`${w()}/announcements/${row.id}`);
    await tick();
    expect((await rows())[0]).toMatchObject({ manual: true, status: 'waiting', notes_by: 'claude' });
    expect(posts()).toEqual([]);
  });

  it('a failed post says why and can be tried again', async () => {
    await turnOn({ mode: 'auto' });
    env.discord.failNextCreate = { status: 403, code: 50013 };
    repo().releases = [release('v4.0.0', new Date(Date.now() + 1000).toISOString())];
    await tick();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row.error).toMatch(/can’t post in that channel/);
    expect((await page('/announcements?show=waiting')).body).toContain('Failed');
    await post(`/announcements/${row.id}`, { intent: 'post' });
    expect((await rows())[0].status).toBe('posted');
  });
});

describe('Announcements: buttons in Settings', () => {
  it('shows what each link finds in the latest release, offers its files, and refuses a link that can’t work', async () => {
    repo().releases = [release('v1.0.0', ago(60))];
    await turnOn({ buttons: '1', btn_label: ['Windows', 'Store'], btn_url: ['{file:*-windows-x64.msi}', '{file:*.msix}'], btn_app: ['', ws.apps[0]!.id], notes_button_label: 'Full changelog' });
    const page1 = (await page('/announcements/settings')).body;
    // The preview uses PhotoCraft's latest release, read from GitHub.
    expect(page1).toContain('v1.0.0: app-v1.0.0-windows-x64.msi');
    expect(page1).toContain('Left out for v1.0.0: no file matches *.msix');
    expect(page1).toContain('data-label="Linux (AppImage)"');
    expect(page1).toContain('value="{file:*-linux-x86_64.AppImage}"');
    expect(page1).toMatch(/id="pv-buttons"[^>]*>.*Windows.*Full changelog/s);
    const s = (await env.db.query('SELECT buttons, notes_button_label FROM announcement_settings')).rows[0];
    expect(s.buttons).toEqual([{ label: 'Windows', url: '{file:*-windows-x64.msi}', appId: null }, { label: 'Store', url: '{file:*.msix}', appId: ws.apps[0]!.id }]);
    expect(s.notes_button_label).toBe('Full changelog');

    // Half filled in, or a link that isn't one: nothing is saved.
    await turnOn({ buttons: '1', btn_label: ['Windows'], btn_url: ['ftp://x'], btn_app: [''] });
    await turnOn({ buttons: '1', btn_label: [''], btn_url: ['https://x.y'], btn_app: [''] });
    expect((await env.db.query('SELECT buttons FROM announcement_settings')).rows[0].buttons).toHaveLength(2);
    // Release notes button off, no buttons of your own: no buttons at all.
    await turnOn({ buttons: '1', btn_label: [], btn_url: [], btn_app: [], notes_button: [] });
    expect((await env.db.query('SELECT buttons, notes_button FROM announcement_settings')).rows[0]).toEqual({ buttons: [], notes_button: false });
  });
});

describe('Announcements: pings panel', () => {
  it('posts a button per role, and members turn their pings on and off', async () => {
    const vector = ws.apps[1]!;
    await turnOn({ ping_enabled: '1', role_id: ROLE_ALL, [`app_${vector.id}_role`]: ROLE_VECTOR });
    const res = await post('/announcements/pings', { intent: 'publish', panel_title: 'Get update pings', panel_intro: 'Pick your apps.' });
    expect(res.statusCode).toBe(302);
    const panel = posts().at(-1)!;
    expect(panel.embeds[0].description).toBe(`Pick your apps.\n\n- <@&${ROLE_ALL}>: PhotoCraft\n- <@&${ROLE_VECTOR}>: VectorCraft`);
    expect(panel.components[0].components.map((b: { custom_id: string }) => b.custom_id)).toEqual([`an:role:${ROLE_ALL}`, `an:role:${ROLE_VECTOR}`]);
    expect(panel.allowed_mentions).toEqual({ parse: [] });

    const who = member('555000000000000009', 'Robin');
    const click = (roles: string[], roleId = ROLE_VECTOR) => sendInteraction(env, {
      id: nextInteractionId(), type: 3, token: `ptok-${roles.length}-${roleId}`, guild_id: ws.guildId, channel_id: releasesChannel,
      member: { ...who, roles }, data: { custom_id: `an:role:${roleId}` },
    });
    const on = await click([]);
    expect(on.json()).toEqual({ type: 5, data: { flags: EPHEMERAL } });
    await eventually(async () => env.discord.interactionEdits.length === 1);
    expect(env.discord.roleChanges.at(-1)).toMatchObject({ method: 'PUT', userId: who.user.id, roleId: ROLE_VECTOR });
    expect(env.discord.interactionEdits[0]!.payload.embeds[0].title).toBe('Update pings on');
    await click([ROLE_VECTOR]);
    await eventually(async () => env.discord.interactionEdits.length === 2);
    expect(env.discord.roleChanges.at(-1)).toMatchObject({ method: 'DELETE', roleId: ROLE_VECTOR });
    // Only the roles announcements ping can be given this way.
    const other = await click([], '700000000000000099');
    expect(other.json().data.embeds[0].title).toBe('Not available');
    expect(env.discord.roleChanges).toHaveLength(2);
  });

  it('never hands out a role with moderator permissions', async () => {
    const g = env.discord.guilds.get(ws.guildId)!;
    g.roles.push({ id: '700000000000000003', name: 'Helpers', permissions: String(1n << 13n), position: 0, mentionable: true });
    const refused = await post('/announcements/settings', { enabled: '1', mode: 'review', channel_id: releasesChannel, apps: '1', ping_enabled: '1', role_id: '700000000000000003' });
    expect(refused.statusCode).toBe(302);
    // Refused: nothing is saved.
    expect((await env.db.query('SELECT role_id FROM announcement_settings')).rows).toEqual([]);
    // Chosen while it was harmless, then given Manage Messages: clicking doesn't give it.
    await turnOn({ ping_enabled: '1', role_id: ROLE_ALL });
    g.roles.find((r) => r.id === ROLE_ALL)!.permissions = String(1n << 13n);
    expect((await page('/announcements/pings')).body).toContain('@App Updates has moderator permissions');
    await sendInteraction(env, {
      id: nextInteractionId(), type: 3, token: 'ptok-elevated', guild_id: ws.guildId, channel_id: releasesChannel,
      member: { ...member('555000000000000010', 'Sam'), roles: [] }, data: { custom_id: `an:role:${ROLE_ALL}` },
    });
    await eventually(async () => env.discord.interactionEdits.length === 1);
    expect(env.discord.interactionEdits[0]!.payload.embeds[0].title).toBe('Not available');
    expect(env.discord.roleChanges).toEqual([]);
  });
});

describe('Announcements: access', () => {
  it('is in the sidebar and on the Overview; moderators need access, and Edit to post', async () => {
    await turnOn();
    const overview = (await page('')).body;
    expect(overview).toContain('Announcements');
    expect(overview).toContain('Review first');
    repo().releases = [release('v1.5.0', new Date(Date.now() + 1000).toISOString())];
    await tick();
    const [row] = await rows();
    const mod = await makeAdmin(env, 'an-mod');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await grant(env, ws.workspace.id, mod.user.id, {});
    expect((await page('/announcements', mod)).statusCode).toBe(403);
    await grant(env, ws.workspace.id, mod.user.id, { announcements: 'view' });
    const view = await page(`/announcements/${row.id}`, mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain('Post now');
    expect((await post(`/announcements/${row.id}`, { intent: 'post' }, mod)).statusCode).toBe(403);
    expect((await page('/announcements/settings', mod)).statusCode).toBe(403);
    await grant(env, ws.workspace.id, mod.user.id, { announcements: 'edit' });
    await post(`/announcements/${row.id}`, { intent: 'post' }, mod);
    expect((await rows())[0]).toMatchObject({ status: 'posted', posted_by: mod.user.id });
  });
});

import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postPayload } from '../src/announcements/posts.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let news: string;
let general: string;
const ROLE = '700000000000000001';
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string | string[]> = {}, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const rows = async () => (await env.db.query('SELECT * FROM posts ORDER BY created_at')).rows;
const sent = () => [...env.discord.messages.entries()].filter(([, m]) => m.channelId === news || m.channelId === general).map(([id, m]): Record<string, any> => ({ id, channelId: m.channelId, ...m.payload }));

const WRITTEN = {
  content: 'Version 2.0 is out!\n- **Faster** exports', role_id: ROLE, card_title: 'What’s new', card_text: 'Everything, really.', card_color: 'green',
  buttons: '1', btn_label: ['Download', ''], btn_url: ['https://example.com/download', ''],
};

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
  const g = env.discord.guilds.get(ws.guildId)!;
  news = String(BigInt(ws.channelId) + 3n);
  general = String(BigInt(ws.channelId) + 4n);
  g.channels.push({ id: news, type: 5, name: 'news', position: 1 }, { id: general, type: 0, name: 'general', position: 2 });
  g.roles.push({ id: ROLE, name: 'Everyone Updates', permissions: '0', position: 0, mentionable: true });
});
afterAll(async () => {
  await testDb().end();
});

describe('Announcements: writing and posting', () => {
  it('saves a draft, posts it in every chosen channel, updates it in place and deletes it from Discord', async () => {
    expect((await page('/announcements')).body).toContain('No announcements yet');

    // A draft: nothing in Discord yet.
    const saved = await post('/announcements/new', { ...WRITTEN, channel_ids: [news, general], intent: 'save' });
    const [draft] = await rows();
    expect(saved.headers.location).toBe(`${w()}/announcements/${draft.id}`);
    expect(draft).toMatchObject({ status: 'draft', role_name: 'Everyone Updates', card_color: 'green', buttons: [{ label: 'Download', url: 'https://example.com/download' }] });
    expect(draft.targets.map((t: { channelName: string }) => t.channelName)).toEqual(['news', 'general']);
    expect(sent()).toEqual([]);
    const editor = (await page(`/announcements/${draft.id}`)).body;
    expect(editor).toContain('Post now');
    expect(editor).toContain('<span class="dp-mention">@Everyone Updates</span>');

    // Posted: one message per channel, pinging only the chosen role; published to followers in the announcement channel.
    await post(`/announcements/${draft.id}`, { ...WRITTEN, channel_ids: [news, general], intent: 'post' });
    const msgs = sent();
    expect(msgs.map((m) => m.channelId).sort()).toEqual([news, general].sort());
    expect(msgs[0]).toMatchObject({
      content: `<@&${ROLE}>\nVersion 2.0 is out!\n- **Faster** exports`,
      embeds: [{ title: 'What’s new', description: 'Everything, really.', color: 0x57f287 }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Download', url: 'https://example.com/download' }] }],
      allowed_mentions: { parse: [], roles: [ROLE] },
    });
    expect(env.discord.crossposts).toEqual([msgs.find((m) => m.channelId === news)!.id]);
    const [live] = await rows();
    expect(live).toMatchObject({ status: 'posted', posted_by: ws.owner.user.id });
    expect(live.targets.every((t: { messageId: string | null }) => t.messageId)).toBe(true);
    // Posted once only.
    await post(`/announcements/${draft.id}`, { intent: 'post' });
    expect(sent()).toHaveLength(2);

    // Changed: the same messages are edited (the channels stay as they are).
    await post(`/announcements/${draft.id}`, { ...WRITTEN, content: 'Version 2.0.1 is out!', channel_ids: [general], intent: 'update' });
    expect(sent()).toHaveLength(2);
    expect(sent().every((m) => m.content === `<@&${ROLE}>\nVersion 2.0.1 is out!`)).toBe(true);

    // A message someone deleted in Discord is dropped on the next update.
    env.discord.messages.delete(msgs.find((m) => m.channelId === general)!.id);
    await post(`/announcements/${draft.id}`, { ...WRITTEN, content: 'Version 2.0.2 is out!', intent: 'update' });
    expect((await rows())[0].targets.map((t: { channelName: string }) => t.channelName)).toEqual(['news']);

    // Deleted from Discord: a draft again, with its channels.
    await post(`/announcements/${draft.id}`, { intent: 'unpost' });
    expect(sent()).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: 'draft', targets: [{ channelName: 'news', messageId: null }] });
    expect((await page('/announcements?show=draft')).body).toContain('Version 2.0.2 is out!');

    await post(`/announcements/${draft.id}`, { intent: 'delete' });
    expect(await rows()).toEqual([]);
  });

  it('refuses a channel or role of another server and a button that isn’t a link, and keeps what was written', async () => {
    const res = await post('/announcements/new', { content: 'Hello', channel_ids: ['123456789012345678'], intent: 'post' });
    const [kept] = await rows();
    expect(kept).toMatchObject({ status: 'draft', content: 'Hello', targets: [] });
    expect(res.headers.location).toBe(`${w()}/announcements/${kept.id}`);
    await post(`/announcements/${kept.id}`, { content: 'Hello', role_id: '999', intent: 'save' });
    expect((await rows())[0].role_id).toBeNull();
    await post(`/announcements/${kept.id}`, { content: 'Hello', buttons: '1', btn_label: 'Go', btn_url: 'javascript:alert(1)', intent: 'save' });
    expect((await rows())[0].buttons).toEqual([]);
    // Nothing to post without a channel.
    await post(`/announcements/${kept.id}`, { content: 'Hello', intent: 'post' });
    expect((await rows())[0].status).toBe('draft');
    expect(sent()).toEqual([]);
  });

  it('never pings @everyone or other roles', () => {
    const payload = postPayload({ content: '@everyone look <@&1>', card_title: null, card_text: null, card_color: 'blurple', role_id: null, buttons: [] });
    expect(payload).toMatchObject({ content: '@everyone look <@&1>', embeds: [], components: [], allowed_mentions: { parse: [], roles: [] } });
  });
});

describe('Announcements: access and the move from GitHub releases', () => {
  it('needs access, and Edit to write; old release addresses go to Bot features', async () => {
    await post('/announcements/new', { content: 'Hello', channel_ids: [news], intent: 'save' });
    const [draft] = await rows();
    const mod = await makeAdmin(env, 'pc-mod');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await grant(env, ws.workspace.id, mod.user.id, {});
    expect((await page('/announcements', mod)).statusCode).toBe(403);
    await grant(env, ws.workspace.id, mod.user.id, { announcements: 'view' });
    const view = await page(`/announcements/${draft.id}`, mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain('Post now');
    expect((await post(`/announcements/${draft.id}`, { intent: 'post' }, mod)).statusCode).toBe(403);
    expect((await page('/announcements/new', mod)).statusCode).toBe(403);

    expect((await page('/announcements/settings')).headers.location).toBe(`${w()}/bot/releases/settings`);
    expect((await page('/announcements/pings')).headers.location).toBe(`${w()}/bot/releases/pings`);
    await env.db.query(`INSERT INTO announcements (id, workspace_id, app_name, repo_id, repo_owner, repo_name, tag, release_url, status) VALUES ('rel1', $1, 'PhotoCraft', 1, 'o', 'r', 'v1', 'https://github.com', 'posted')`, [ws.workspace.id]);
    expect((await page('/announcements/rel1')).headers.location).toBe(`${w()}/bot/releases/rel1`);
  });

  it('moves moderators’ release access to its new pages, and gives no one the new Announcements', async () => {
    const sql = await readFile(new URL('../src/db/migrations/044_announcements_posts.sql', import.meta.url), 'utf8');
    const moves = sql.slice(0, sql.indexOf('CREATE TABLE')).replace(/^\s*--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean);
    await env.db.query(`UPDATE workspace_members SET access = $2 WHERE user_id = $1`, [ws.owner.user.id, JSON.stringify({ inbox: 'view', announcements: 'edit', 'announcement-settings': 'view', 'announcement-pings': 'edit' })]);
    for (const m of moves) await env.db.query(m);
    const { access } = (await env.db.query('SELECT access FROM workspace_members WHERE user_id = $1', [ws.owner.user.id])).rows[0];
    expect(access).toEqual({ inbox: 'view', releases: 'edit', 'release-settings': 'view', 'release-pings': 'edit' });
  });
});

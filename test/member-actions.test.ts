import { crc32 } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IssueIndexer, setDuplicateOf } from '../src/domain/issue-index.js';
import { DEFAULT_MEMBER_TEXT, memberActions, UPDATES_PER_HOUR } from '../src/domain/member-actions.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { getWorkspace, setMemberActions, setMyTickets } from '../src/domain/workspaces.js';
import { undoAction } from '../src/moderation/actions.js';
import { setModerationEnabled } from '../src/moderation/settings.js';
import { eventually, form, get, makeApp, makeWorkspace, member, nextInteractionId, resetDb, sendInteraction, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
const w = () => `/w/${ws.workspace.id}`;
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const ALEX = '555000000000000021';
const SAM = '555000000000000022';
const who = (id: string) => member(id, id === ALEX ? 'Alex' : 'Sam');
const click = (customId: string, as = ALEX, values?: string[]) =>
  sendInteraction(env, { id: nextInteractionId(), type: 3, token: `tok-${customId}`, guild_id: ws.guildId, member: who(as), data: { custom_id: customId, ...(values ? { values } : {}) } });
const submit = (customId: string, components: unknown[], o: { as?: string; attachments?: Record<string, unknown> } = {}) =>
  sendInteraction(env, {
    id: nextInteractionId(), type: 5, token: `tok-${customId}`, guild_id: ws.guildId, member: who(o.as ?? ALEX),
    data: { custom_id: customId, components, ...(o.attachments ? { resolved: { attachments: o.attachments } } : {}) },
  });
const detailsForm = (text: string) => [{ type: 10, id: 1 }, { type: 18, id: 2, component: { type: 4, id: 3, custom_id: 'details', value: text } }];
const filesForm = (ids: string[]) => [{ type: 10, id: 1 }, { type: 18, id: 2, component: { type: 19, id: 3, custom_id: 'screenshots', values: ids } }];
/** The edit made once the action is done (its token is the button's). */
const finished = (customId: string) => eventually(async () => env.discord.interactionEdits.find((e) => e.token === `tok-${customId}`)?.payload as any);

let k = 0;
async function ticket(title: string, as: string, o: { app?: number } = {}) {
  k++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[o.app ?? 0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-ma${k}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: as, displayName: as === ALEX ? 'Alex' : 'Sam', username: as === ALEX ? 'alex' : 'sam' },
    title, description: `It happens every time (${k}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, ref, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; ref: string; issue_number: number };
}
const issue = (n: number, i = 0) => repo(i).issues.find((x) => x.number === n)!;
const sync = async () => {
  await env.db.query('UPDATE issue_index_repos SET sync_requested_at = now_ms(), pulls_checked_at = NULL, releases_checked_at = NULL');
  await new IssueIndexer(env.deps).tick();
};
async function allow(o: Partial<{ details: boolean; files: boolean; close: boolean }>, text: Record<string, string | null> = {}) {
  await setMyTickets(env.db, ws.workspace.id, true);
  await setMemberActions(env.db, ws.workspace.id, { details: false, files: false, close: false, ...o, text });
  ws.workspace = (await getWorkspace(env.db, ws.workspace.id))!;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function png(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01, 0x01, 0x01, 0x00])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, {
    repos: [{ id: 9701, name: 'photocraft', private: false }],
    apps: [{ name: 'PhotoCraft', repoIndex: 0 }],
  });
});
afterAll(async () => {
  await testDb().end();
});

describe('My tickets: what members can do on a ticket', () => {
  it('shows no buttons until admins turn the actions on, and only on open tickets', async () => {
    const t = await ticket('Export crashes', ALEX);
    await setMyTickets(env.db, ws.workspace.id, true);
    const page = (await click('tr:mine:t:0', ALEX, [t.ref])).json().data;
    expect(page.components).toHaveLength(1);
    expect(page.components[0].components.map((c: { label: string }) => c.label)).toEqual(['Back to your tickets', 'Open on GitHub']);
    // An old button for an action that's off: the page says so.
    expect((await click(`tr:mine:d:${t.ref}:0`)).json().data.content).toBe('This isn’t available anymore. A server admin turned it off.');

    await allow({ details: true, files: true, close: true });
    const on = (await click('tr:mine:t:0', ALEX, [t.ref])).json().data;
    expect(on.components[0].components.map((c: { label: string; custom_id: string }) => [c.label, c.custom_id])).toEqual([
      ['Add details', `tr:mine:d:${t.ref}:0`], ['Add screenshots', `tr:mine:f:${t.ref}:0`], ['Close my ticket', `tr:mine:c:${t.ref}:0`],
    ]);

    // Closed on GitHub: no buttons, and old ones say why.
    Object.assign(issue(t.issue_number), { state: 'closed', state_reason: 'completed', closed_at: new Date().toISOString() });
    await sync();
    expect((await click('tr:mine:t:0', ALEX, [t.ref])).json().data.components).toHaveLength(1);
    expect((await click(`tr:mine:d:${t.ref}:0`)).json().data.content).toBe('This ticket is closed, so it can’t be changed from here anymore.');
  });

  it('adds details as a comment inside the admins’ text, once, and asks for them when the team needs more information', async () => {
    const t = await ticket('Export crashes', ALEX);
    issue(t.issue_number).labels.push('Needs info');
    await sync();
    await allow({ details: true });
    // Needs more information: Add details stands out, with a word on what to do.
    const page = (await click('tr:mine:t:0', ALEX, [t.ref])).json().data;
    expect(page.embeds[0].description).toContain('**Status:** ❓ The team needs more information\nPress **Add details** to answer the team.');
    expect(page.components[0].components[0]).toMatchObject({ label: 'Add details', style: 1 });

    const modal = (await click(`tr:mine:d:${t.ref}:0`)).json();
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe(`tr:mine:d:${t.ref}:0`);
    expect(modal.data.title).toBe('Add details');
    expect(modal.data.components[0].content).toContain('Adding to **Export crashes**');
    expect(modal.data.components[0].content).toContain('posted publicly on GitHub');
    expect(modal.data.components[1].component).toMatchObject({ custom_id: 'details', style: 2, min_length: 10, max_length: 2000, required: true });

    const id = `tr:mine:d:${t.ref}:0`;
    const sent = (await submit(id, detailsForm('It only happens with files over 2 GB. @octocat knows.'))).json();
    // Answered at once, without buttons while it's being added.
    expect(sent.type).toBe(7);
    expect(sent.data.content).toBe('⏳ Adding your details…');
    expect(sent.data.components).toEqual([]);
    const done = await finished(id);
    expect(done.content).toBe('✅ Your details were added to the ticket. Thanks!');
    expect(done.embeds[0].description).toMatch(/- You added details · <t:\d+:R>/);
    expect(issue(t.issue_number).comments).toEqual(['**Update from the reporter on Discord:**\n\nIt only happens with files over 2 GB. @\u200boctocat knows.']);

    // The same words again: not posted twice.
    env.discord.interactionEdits = [];
    await submit(id, detailsForm('It only happens with files over 2 GB.  @octocat knows. '));
    expect((await finished(id)).content).toBe('You already added these details.');
    expect(issue(t.issue_number).comments).toHaveLength(1);

    // The admins' own text, with {app}.
    await allow({ details: true }, { details: 'From the reporter ({app}):\n\n{details}' });
    env.discord.interactionEdits = [];
    await submit(id, detailsForm('It also happens on the beta build.'));
    await finished(id);
    expect(issue(t.issue_number).comments![1]).toBe('From the reporter (PhotoCraft):\n\nIt also happens on the beta build.');

    // The team's ticket page tells who added what.
    const activity = (await env.server.inject({ method: 'GET', url: `${w()}/tickets/${t.id}`, ...get(ws.owner) })).body;
    expect(activity).toContain('added details from My tickets in Discord');
  });

  it('gives their words back when GitHub can’t take them, and limits how often they add', async () => {
    const t = await ticket('Export crashes', ALEX);
    await allow({ details: true });
    const id = `tr:mine:d:${t.ref}:0`;
    // GitHub can't take it: the member gets their text back to copy.
    await env.db.query("UPDATE github_connections SET status = 'suspended' WHERE workspace_id = $1", [ws.workspace.id]);
    await submit(id, detailsForm('Steps: open, export, crash.'));
    const failed = await finished(id);
    expect(failed.content).toBe('⚠️ Your details couldn’t be added right now. Please try again in a few minutes.\nHere’s what you wrote, so you can copy it:\n> Steps: open, export, crash.');
    expect(issue(t.issue_number).comments ?? []).toEqual([]);
    await env.db.query("UPDATE github_connections SET status = 'active' WHERE workspace_id = $1", [ws.workspace.id]);

    for (let i = 0; i < UPDATES_PER_HOUR; i++) {
      env.discord.interactionEdits = [];
      await submit(id, detailsForm(`Another detail number ${i}.`));
      await finished(id);
    }
    expect(issue(t.issue_number).comments).toHaveLength(UPDATES_PER_HOUR);
    const limited = (await click(id)).json();
    expect(limited.type).toBe(7);
    expect(limited.data.content).toMatch(/^You’ve added to your tickets several times in the last hour\. You can add more in about \d+ minutes?\.$/);
    // Sent from a form opened before the limit: their words come back.
    const late = (await submit(id, detailsForm('One more thing I noticed.'))).json();
    expect(late.data.content).toMatch(/You can add more in about \d+ minutes?\.\nHere’s what you wrote, so you can copy it:\n> One more thing I noticed\.$/);
    expect(issue(t.issue_number).comments).toHaveLength(UPDATES_PER_HOUR);
  });

  it('adds screenshots to the issue’s attachments, and says which couldn’t be added', async () => {
    const t = await ticket('Export crashes', ALEX);
    await allow({ files: true });
    const modal = (await click(`tr:mine:f:${t.ref}:0`)).json();
    expect(modal.type).toBe(9);
    expect(modal.data.components[1].component).toMatchObject({ type: 19, custom_id: 'screenshots', min_values: 1, max_values: 5, required: true });

    const good = env.discord.addCdnFile('shot.png', png());
    const bad = env.discord.addCdnFile('notes.txt', Buffer.from('not an image'), 'text/plain');
    const id = `tr:mine:f:${t.ref}:0`;
    const sent = (await submit(id, filesForm(['a1', 'a2']), {
      attachments: {
        a1: { id: 'a1', filename: 'shot.png', size: 200, url: good, content_type: 'image/png' },
        a2: { id: 'a2', filename: 'notes.txt', size: 12, url: bad, content_type: 'text/plain' },
      },
    })).json();
    expect(sent.data.content).toBe('⏳ Adding your screenshots…');
    const done = await finished(id);
    expect(done.content).toBe('✅ Added 1 screenshot to the ticket. Thanks!\nOne wasn’t added:\n- notes.txt: Only PNG or JPG images are accepted.');
    expect(done.embeds[0].description).toMatch(/- You added 1 screenshot · <t:\d+:R>/);
    const body = issue(t.issue_number).body;
    expect(body).toContain('### Attachments');
    expect(body).toMatch(/!\[shot\.png\]\(http[^)]+\/f\/[A-Za-z0-9_-]{22}\/shot\.png\)/);
    expect(body).not.toContain('notes.txt');
    expect(issue(t.issue_number).comments).toEqual([DEFAULT_MEMBER_TEXT.files.replace('{screenshots}', '1 screenshot')]);
    // The one that couldn't be saved isn't kept.
    const files = (await env.db.query('SELECT filename, status FROM ticket_files WHERE submission_id = $1', [t.id])).rows;
    expect(files).toEqual([{ filename: 'shot.png', status: 'stored' }]);
  });

  it('closes it for their reason, in the Mod log as theirs, and moderators can undo it', async () => {
    const t = await ticket('Export crashes', ALEX);
    await allow({ close: true }, { notNeeded: '' });
    const confirm = (await click(`tr:mine:c:${t.ref}:0`)).json();
    expect(confirm.type).toBe(7);
    expect(confirm.data.embeds[0].title).toBe('Close this ticket?');
    expect(confirm.data.components[0].components.map((c: { label: string; custom_id: string; style: number }) => [c.label, c.custom_id, c.style])).toEqual([
      ['It works now', `tr:mine:cw:${t.ref}:0`, 3], ['I don’t need it anymore', `tr:mine:cn:${t.ref}:0`, 2], ['Cancel', `tr:mine:v:${t.ref}:0`, 2],
    ]);
    // Cancel: back to the ticket.
    expect((await click(`tr:mine:v:${t.ref}:0`)).json().data.embeds[0].title).toBe('Export crashes');

    const id = `tr:mine:cw:${t.ref}:0`;
    expect((await click(id)).json().data.content).toBe('⏳ Closing your ticket…');
    const done = await finished(id);
    expect(done.content).toBe('✅ Your ticket was closed (it works now). Thanks for letting the team know.');
    expect(done.embeds[0].description).toContain('**Status:** ☑️ You closed it');
    expect(done.embeds[0].description).toMatch(/- You closed it: it works now · <t:\d+:R>/);
    expect(issue(t.issue_number)).toMatchObject({ state: 'closed', state_reason: 'completed', comments: [DEFAULT_MEMBER_TEXT.works] });
    // In their list under Closed.
    const list = (await click('tr:mine')).json().data.embeds[0].description;
    expect(list).toMatch(/^\*\*Closed · 1\*\*\n☑️ Export crashes · You closed it · \[#\d+\]/);

    const [action] = (await env.db.query('SELECT * FROM mod_actions WHERE workspace_id = $1', [ws.workspace.id])).rows as any[];
    expect(action).toMatchObject({ kind: 'close', reason: 'member:works', via: 'member', user_id: null, detail: { member: 'Alex', commented: true, closedAs: 'completed' } });
    const log = (await env.server.inject({ method: 'GET', url: `${w()}/moderation/log`, ...get(ws.owner) })).body;
    expect(log).toContain('Closed: It works now, with the comment');
    expect(log).toMatch(/Alex<span class="tag subtle"[^>]*>Reporter/);

    // A moderator undoes it: open again, the comment gone, and the member sees it.
    await setModerationEnabled(env.db, ws.workspace.id, true, ws.owner.user.id);
    await undoAction(env.deps, ws.workspace.id, action.id, ws.owner.user.id);
    expect(issue(t.issue_number)).toMatchObject({ state: 'open', comments: [] });
    const again = (await click('tr:mine:t:0', ALEX, [t.ref])).json().data;
    expect(again.embeds[0].description).toContain('**Status:** 🔍 Looking into it');
    expect(again.embeds[0].description).toMatch(/- You closed it: it works now · <t:\d+:R>\n- The team reopened it · <t:\d+:R>/);
    expect(again.components[0].components.map((c: { label: string }) => c.label)).toEqual(['Close my ticket']);

    // "I don't need it anymore" with its comment left empty: closed as not planned, no comment.
    const id2 = `tr:mine:cn:${t.ref}:0`;
    await click(id2);
    await finished(id2);
    expect(issue(t.issue_number)).toMatchObject({ state: 'closed', state_reason: 'not_planned', comments: [] });
  });

  it('leaves closing to the team when other reports follow the ticket', async () => {
    const t = await ticket('Export crashes', ALEX);
    const same = await ticket('Exporting crashes for me too', SAM);
    await allow({ details: true, close: true });
    await sync();
    await setDuplicateOf(env.db, repo().id, same.issue_number, t.issue_number);
    const page = (await click('tr:mine:t:0', ALEX, [t.ref])).json().data;
    expect(page.components[0].components.map((c: { label: string }) => c.label)).toEqual(['Add details']);
    // An older button: the page says why, and nothing is closed.
    expect((await click(`tr:mine:cw:${t.ref}:0`)).json().data.content).toBe('Other people reported the same problem, so the team will close this ticket when it’s sorted out.');
    expect(issue(t.issue_number).state ?? 'open').toBe('open');
  });

  it('only acts on the member’s own tickets', async () => {
    const t = await ticket('Export crashes', ALEX);
    await allow({ details: true, files: true, close: true });
    // Sam presses an action for Alex's ticket: Sam's own list instead, nothing done.
    for (const action of ['d', 'f', 'c', 'cw', 'cn', 'v']) {
      const res = (await click(`tr:mine:${action}:${t.ref}:0`, SAM)).json();
      expect(res.type).toBe(7);
      expect(res.data.embeds[0].title).toBe('Your tickets');
    }
    const res = (await submit(`tr:mine:d:${t.ref}:0`, detailsForm('Not my ticket at all, sorry.'), { as: SAM })).json();
    expect(res.data.embeds[0].title).toBe('Your tickets');
    expect(issue(t.issue_number).state ?? 'open').toBe('open');
    expect(issue(t.issue_number).comments ?? []).toEqual([]);
  });
});

describe('Panel › My tickets: the actions’ settings', () => {
  it('saves each switch and comment, keeps {details} in, and shows the buttons in the preview', async () => {
    await setMyTickets(env.db, ws.workspace.id, true);
    const page = (await env.server.inject({ method: 'GET', url: `${w()}/tickets/panel`, ...get(ws.owner) })).body;
    expect(page).toContain('On each open ticket');
    expect(page).toMatch(/name="member_details"[^>]*id="member_details"/);
    expect(page).toContain('Preview of a ticket’s page in My tickets');
    // Off: the preview's buttons and the comments are hidden until switched on.
    expect(page).toMatch(/<span class="dp-button grey" data-follows="member_details" hidden>Add details<\/span>/);
    expect(page).toMatch(/class="fields" data-follows="member_close" hidden/);

    const save = (fields: Record<string, string>) => env.server.inject({ method: 'POST', url: `${w()}/tickets/panel`, ...form(ws.owner, { member_actions_sent: '1', intent: 'save', ...fields }) });
    const bad = await save({ member_details: '1', member_text_details: 'Update: no placeholder' });
    expect(bad.statusCode).toBe(302);
    expect(memberActions((await getWorkspace(env.db, ws.workspace.id))!).details).toBe(false);

    await save({ member_details: '1', member_close: '1', member_text_details: DEFAULT_MEMBER_TEXT.details, member_text_files: DEFAULT_MEMBER_TEXT.files, member_text_works: 'Closed by the reporter: fixed for them.', member_text_notNeeded: '' });
    const saved = (await getWorkspace(env.db, ws.workspace.id))!;
    // The defaults stay defaults (null); an emptied comment stays empty.
    expect(saved.member_actions).toEqual({ details: true, files: false, close: true, text: { details: null, files: null, works: 'Closed by the reporter: fixed for them.', notNeeded: '' } });
    expect(memberActions(saved)).toMatchObject({ details: true, files: false, close: true, text: { works: 'Closed by the reporter: fixed for them.', notNeeded: '' } });
    const after = (await env.server.inject({ method: 'GET', url: `${w()}/tickets/panel`, ...get(ws.owner) })).body;
    expect(after).toMatch(/<span class="dp-button grey" data-follows="member_details" >Add details<\/span>/);
    expect(after).toMatch(/<span class="dp-button grey" data-follows="member_files" hidden>Add screenshots<\/span>/);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_INTRO } from '../src/discord/messages.js';
import { IssueIndexer, setDuplicateOf } from '../src/domain/issue-index.js';
import { panelPayloadFor } from '../src/domain/panel.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createTicketType } from '../src/domain/ticket-types.js';
import { getWorkspace, setMyTickets } from '../src/domain/workspaces.js';
import { form, get, makeApp, makeWorkspace, member, nextInteractionId, resetDb, sendInteraction, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
const w = () => `/w/${ws.workspace.id}`;
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const sync = async () => {
  await env.db.query('UPDATE issue_index_repos SET sync_requested_at = now_ms(), pulls_checked_at = NULL, releases_checked_at = NULL');
  await new IssueIndexer(env.deps).tick();
};
const ALEX = '555000000000000011';
const SAM = '555000000000000012';
const click = (customId: string, who = ALEX, values?: string[]) =>
  sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(who, who === ALEX ? 'Alex' : 'Sam'), data: { custom_id: customId, ...(values ? { values } : {}) } });

let k = 0;
/** A Discord ticket from this member, filed as an issue, sent `minutesAgo` minutes ago. */
async function ticket(title: string, who: string, o: { app?: number; minutesAgo?: number } = {}) {
  k++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[o.app ?? 0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-mt${k}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: who, displayName: who, username: who },
    title, description: `It happens every time (${k}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  await env.db.query('UPDATE submissions SET created_at = $2 WHERE id = $1', [r.submission.id, new Date(Date.now() - (o.minutesAgo ?? 0) * 60_000)]);
  return (await env.db.query('SELECT ref, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { ref: string; issue_number: number };
}
const issue = (n: number, i = 0) => repo(i).issues.find((x) => x.number === n)!;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, {
    repos: [{ id: 9601, name: 'photocraft', private: false }, { id: 9602, name: 'vectorcraft', private: true }],
    apps: [{ name: 'PhotoCraft', repoIndex: 0 }, { name: 'VectorCraft', repoIndex: 1 }],
  });
});
afterAll(async () => {
  await testDb().end();
});

describe('My tickets: the panel', () => {
  it('shows Open a ticket and My tickets instead of the menu once an admin turns it on', async () => {
    const before = await env.server.inject({ method: 'GET', url: `${w()}/tickets/panel`, ...get(ws.owner) });
    expect(before.body).toMatch(/name="my_tickets"[^>]*id="my_tickets"[^>]*data-layout-switch/);
    expect(before.body).not.toMatch(/id="my_tickets"[^>]* checked/);
    expect(before.body).toMatch(/class="dp-buttons" data-layout="buttons" hidden/);

    // The form sends the introduction as shown: the menu's default stays the default, so it follows the buttons.
    const res = await env.server.inject({ method: 'POST', url: `${w()}/tickets/panel`, ...form(ws.owner, { my_tickets_sent: '1', my_tickets: '1', panel_intro: DEFAULT_PANEL_INTRO, intent: 'save' }) });
    expect(res.statusCode).toBe(302);
    const saved = (await getWorkspace(env.db, ws.workspace.id))!;
    expect(saved).toMatchObject({ my_tickets: true, panel_intro: null });
    const { payload } = panelPayloadFor(saved, (await env.db.query('SELECT * FROM apps WHERE workspace_id = $1', [ws.workspace.id])).rows as never);
    expect(payload.components[0]!.components.map((c) => [c.type, 'label' in c ? c.label : null, c.custom_id])).toEqual([[2, 'Open a ticket', 'tr:open'], [2, 'My tickets', 'tr:mine']]);
    expect(payload.embeds[0]!.description).toContain('Press **Open a ticket** to tell us about a problem.');
    expect(payload.embeds[0]!.description).toContain('1. Press **Open a ticket** and choose your app.');
    expect(payload.embeds[0]!.description).toContain('Press **My tickets** any time to see what’s happening with the tickets you’ve sent.');

    const after = (await env.server.inject({ method: 'GET', url: `${w()}/tickets/panel`, ...get(ws.owner) })).body;
    expect(after).toMatch(/id="my_tickets"[^>]* checked/);
    expect(after).toMatch(/class="dp-buttons" data-layout="buttons" >/);
    // An example of the reply, in the board's words.
    expect(after).toContain('Preview of My tickets in Discord');
    expect(after).toContain('Export crashes on large files');
    expect(after).toContain('🛠️ Being worked on');
    // Turned off again: back to the menu.
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/panel`, ...form(ws.owner, { my_tickets_sent: '1', intent: 'save' }) });
    expect((await getWorkspace(env.db, ws.workspace.id))!.my_tickets).toBe(false);
  });

  it('Open a ticket shows the apps privately, and goes straight on when there is one', async () => {
    const open = (await click('tr:open')).json();
    expect(open.type).toBe(4);
    expect(open.data.flags).toBe(64);
    expect(open.data.content).toBe('Choose the app you need help with.');
    // One page: the menu without Previous and Next.
    expect(open.data.components).toHaveLength(1);
    expect(open.data.components[0].components[0]).toMatchObject({ custom_id: 'tr:pickp', options: [{ label: 'PhotoCraft' }, { label: 'VectorCraft' }] });

    // With ticket types, picking an app replaces the menu with the types.
    await createTicketType(env.db, ws.workspace.id, { name: 'Bug report', description: null, label: 'bug', title_prefix: 'Bug', guidance: null, placeholder: null, enabled: true });
    const picked = (await click('tr:pickp', ALEX, [ws.apps[0]!.public_id])).json();
    expect(picked.type).toBe(7);
    expect(picked.data.flags).toBeUndefined();
    expect(picked.data.embeds[0].title).toBe('What kind of ticket is this?');

    // One enabled app: straight to its types (or its form).
    await env.db.query('UPDATE apps SET enabled = 0 WHERE id = $1', [ws.apps[1]!.id]);
    const one = (await click('tr:open')).json();
    expect(one.type).toBe(4);
    expect(one.data.embeds[0].description).toContain('**PhotoCraft**');
    await env.db.query('DELETE FROM ticket_types');
    expect((await click('tr:open')).json().type).toBe(9);
  });
});

describe('My tickets: a member’s own tickets', () => {
  it('lists them with what’s happening with each, only to them, and tells each one’s story', async () => {
    const crash = await ticket('Export crashes the app', ALEX, { minutesAgo: 60 });
    const undo = await ticket('Undo forgets the last step', ALEX, { minutesAgo: 50 });
    const lag = await ticket('Brush lags on big canvases', SAM, { minutesAgo: 45 });
    const lagToo = await ticket('Brush is slow', ALEX, { minutesAgo: 40 });
    const unclear = await ticket('It broke', ALEX, { minutesAgo: 30 });
    const splash = await ticket('Add a dark splash screen', ALEX, { minutesAgo: 20 });
    const secret = await ticket('Vector tool crashes', ALEX, { app: 1, minutesAgo: 10 });
    repo().pulls = [
      { number: 50, title: 'Stop the export crash', body: `Fixes #${crash.issue_number}`, user: 'dev', created_at: ago(1), updated_at: ago(1) },
      { number: 51, title: 'Keep undo history', body: `Fixes #${undo.issue_number}`, user: 'dev', created_at: ago(3), updated_at: ago(2), merged_at: ago(2) },
      { number: 52, title: 'Faster brush', body: `Fixes #${lag.issue_number}`, user: 'dev', created_at: ago(1), updated_at: ago(1) },
    ];
    repo().releases = [{ tag: 'v1.2.0', published_at: ago(1) }];
    Object.assign(issue(undo.issue_number), { state: 'closed', state_reason: 'completed', closed_at: ago(2) });
    Object.assign(issue(splash.issue_number), { state: 'closed', state_reason: 'not_planned', closed_at: ago(1) });
    issue(unclear.issue_number).labels.push('Needs info');
    await sync();
    await setDuplicateOf(env.db, repo().id, lagToo.issue_number, lag.issue_number);

    // Off: the button says so.
    expect((await click('tr:mine')).json().data.embeds[0].title).toBe('Not available');
    await setMyTickets(env.db, ws.workspace.id, true);

    const list = (await click('tr:mine')).json();
    expect(list.type).toBe(4);
    expect(list.data.flags).toBe(64);
    const embed = list.data.embeds[0];
    expect(embed.title).toBe('Your tickets');
    // One page: no footer (Discord says "Only you can see this" itself).
    expect(embed.footer).toBeUndefined();
    // Open ones first, newest first; Sam's ticket isn't there.
    const options = list.data.components[0].components[0].options as { label: string; value: string; description: string }[];
    expect(options.map((o) => [o.label, o.description])).toEqual([
      ['Vector tool crashes', '🔍 Looking into it'],
      ['It broke', '❓ The team needs more information'],
      ['Brush is slow', '🛠️ Being worked on'],
      ['Export crashes the app', '🛠️ Being worked on'],
      ['Add a dark splash screen', '🚫 Closed: not planned'],
      ['Undo forgets the last step', '✅ Fixed in v1.2.0: update to get it'],
    ]);
    expect(embed.description).not.toContain('Brush lags on big canvases');
    // Open under an Open heading, two lines each; closed under a Closed heading, one line each, titles not bold.
    expect(embed.description.startsWith('**Open · 4**\n**Vector tool crashes**\n')).toBe(true);
    expect(embed.description).toMatch(new RegExp(
      `\\n\\n\\*\\*Closed · 2\\*\\*\\n🚫 Add a dark splash screen · Not planned · \\[#${splash.issue_number}\\]\\(https://github\\.com/[^)]+\\) · <t:\\d+:R>\\n`
      + `✅ Undo forgets the last step · Fixed in v1\\.2\\.0: update to get it · \\[#${undo.issue_number}\\]\\(https://github\\.com/[^)]+\\) · <t:\\d+:R>$`,
    ));
    expect(embed.description).toContain(`**Export crashes the app**\n🛠️ Being worked on · PhotoCraft · [#${crash.issue_number}](https://github.com/`);
    expect(embed.description).toContain(`↳ Same problem as [#${lag.issue_number}](https://github.com/`);
    // The private repository's ticket: no link.
    expect(embed.description).toMatch(/\*\*Vector tool crashes\*\*\n🔍 Looking into it · VectorCraft · #\d+ · <t:\d+:R>/);

    // A ticket's story: the same problem as Sam's, which is being worked on.
    const detail = (await click('tr:mine:t:0', ALEX, [lagToo.ref])).json();
    expect(detail.type).toBe(7);
    const d = detail.data.embeds[0];
    expect(d.title).toBe('Brush is slow');
    expect(d.description).toContain('**Status:** 🛠️ Being worked on');
    expect(d.description).toContain(`It’s the same problem as [#${lag.issue_number}]`);
    expect(d.description).toContain(`- Work on a fix started ([pull request #52](https://github.com/`);
    expect(detail.data.components[0].components.map((c: { label: string }) => c.label)).toEqual(['Back to your tickets', 'Open on GitHub']);
    expect(detail.data.components[0].components[0].custom_id).toBe('tr:mine:p:0');
    const fixed = (await click('tr:mine:t:0', ALEX, [undo.ref])).json().data.embeds[0].description;
    expect(fixed).toContain('- Marked as fixed · <t:');
    expect(fixed).toContain('- Released in v1.2.0: update to get it · <t:');
    // Private: no GitHub link or button.
    const hidden = (await click('tr:mine:t:0', ALEX, [secret.ref])).json().data;
    expect(hidden.embeds[0].description).toContain(`#${secret.issue_number} (private repository)`);
    expect(hidden.components[0].components).toHaveLength(1);

    // Someone else's ticket can't be opened: the list comes back instead.
    const other = (await click('tr:mine:t:0', ALEX, [lag.ref])).json();
    expect(other.data.embeds[0].title).toBe('Your tickets');
    // Sam sees only Sam's.
    expect((await click('tr:mine', SAM)).json().data.components[0].components[0].options.map((o: { label: string }) => o.label)).toEqual(['Brush lags on big canvases']);
  });

  it('pages through many, and says so when there are none', async () => {
    await setMyTickets(env.db, ws.workspace.id, true);
    const none = (await click('tr:mine')).json().data;
    expect(none.embeds[0].description).toContain('You haven’t sent any tickets here yet.');
    expect(none.components).toEqual([]);
    for (let i = 0; i < 12; i++) await ticket(`Problem ${String(i).padStart(2, '0')}`, ALEX, { minutesAgo: 100 - i });
    const first = (await click('tr:mine')).json().data;
    expect(first.components[0].components[0].options).toHaveLength(10);
    expect(first.embeds[0].footer.text).toBe('Page 1 of 2');
    // Every page counts all of them under its heading.
    expect(first.embeds[0].description.startsWith('**Open · 12**\n')).toBe(true);
    const second = (await click('tr:mine:p:1')).json();
    expect(second.type).toBe(7);
    expect(second.data.components[0].components[0].options.map((o: { label: string }) => o.label)).toEqual(['Problem 01', 'Problem 00']);
    expect(second.data.components[0].components[0].custom_id).toBe('tr:mine:t:1');
  });
});

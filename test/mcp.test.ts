import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepos, IssueIndexer } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { resetMcpLimits } from '../src/mcp/server.js';
import { liveIdle } from '../src/moderation/live.js';
import { setModerationEnabled } from '../src/moderation/settings.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
let rpcId = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const ref = (num: number) => `${repo().owner}/${repo().name}#${num}`;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

beforeEach(async () => {
  await liveIdle();
  await resetDb();
  resetMcpLimits();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

async function fileTicket(title: string, description = `It breaks every time (${n + 1}).`) {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-mcp${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, ref, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; ref: string; issue_number: number };
}

async function syncAll() {
  await ensureRepos(env.db);
  await env.db.query('UPDATE issue_index_repos SET sync_requested_at = now_ms()');
  await new IssueIndexer(env.deps).tick();
}

async function joinAs(name: string): Promise<Admin> {
  const person = await makeAdmin(env, name);
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(person) });
  return person;
}

const page = (who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}/mcp`, ...get(who) });
const enable = (on = true, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}/mcp/enable`, ...form(who, { on: on ? '1' : '0' }) });
/** Switches exactly these MCP tools on for a moderator, as Members & permissions does. */
const giveTools = (mod: Admin, tools: string[]) => env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/access`, ...form(ws.owner, { mcp_sent: '1', mcp: tools }) });

async function makeToken(who: Admin = ws.owner, fields: Record<string, string> = {}): Promise<string> {
  const res = await env.server.inject({ method: 'POST', url: `${w()}/mcp/tokens`, ...form(who, { name: 'Laptop', days: '90', ...fields }) });
  expect(res.statusCode).toBe(200);
  const token = /trm_[A-Za-z0-9_-]{43}/.exec(res.body)?.[0];
  expect(token).toBeTruthy();
  return token!;
}

function rpc(token: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  return env.server.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    payload: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  expect(res.statusCode).toBe(200);
  const r = res.json().result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
  const text = r.content[0]!.text ?? '';
  return { isError: Boolean(r.isError), text, data: r.isError ? null : (JSON.parse(text) as any), content: r.content };
}

const toolNames = async (token: string) => ((await rpc(token, 'tools/list')).json().result.tools as { name: string }[]).map((t) => t.name);

describe('MCP › access', () => {
  it('is off until an admin turns it on, and moderators need a tool of their own, apart from the pages', async () => {
    const off = await page();
    expect(off.body).toContain('MCP is off');
    expect(off.body).toContain('Turn on MCP');

    const mod = await joinAs('Robin');
    // Seeing Ticket management doesn't open MCP.
    await env.db.query(`UPDATE workspace_members SET access = '{"moderation":"edit"}' WHERE user_id = $1`, [mod.user.id]);
    expect((await page(mod)).statusCode).toBe(403);
    expect((await env.server.inject({ method: 'GET', url: w(), ...get(mod) })).body).toContain('You don’t have access to MCP');
    expect((await enable(true, mod)).statusCode).toBe(403);
    expect((await enable()).statusCode).toBe(302);

    const saved = await giveTools(mod, ['find_tickets', 'get_ticket', 'not_a_tool']);
    expect(saved.statusCode).toBe(302);
    const access = (await env.db.query('SELECT access FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0]!.access;
    expect(access).toEqual({ moderation: 'edit', mcp: ['find_tickets', 'get_ticket'] });
    // Changing pages keeps the tools, and the members table shows them.
    await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/access`, ...form(ws.owner, { inbox: 'edit' }) });
    expect((await env.db.query('SELECT access FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0]!.access.mcp).toEqual(['find_tickets', 'get_ticket']);
    const members = await env.server.inject({ method: 'GET', url: `${w()}/members?mod=${mod.user.id}`, ...get(ws.owner) });
    expect(members.body).toContain('MCP · 2');
    expect(members.body).toContain('data-mcp="close_ticket"');
    expect(members.body).toContain('2 read tools');
    expect(members.body).toContain('data-mcp-group-switch="write"');
    expect(members.body).toContain('2 of 11 on');

    const view = await page(mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('Connect your agent');
    expect(view.body).not.toContain('Everyone’s tokens');
    // With only read tools there's nothing to choose: their tokens are read only.
    expect(view.body).toContain('Your tokens are read only');
    expect(view.body).not.toContain('name="access"');
    await makeToken(mod);
    expect((await env.db.query('SELECT read_only FROM mcp_tokens WHERE user_id = $1', [mod.user.id])).rows[0]!.read_only).toBe(1);
    // The docs: everyone with MCP reads them; the admins' part is for admins.
    const docs = await env.server.inject({ method: 'GET', url: `${w()}/mcp/docs`, ...get(mod) });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).toContain('Using Ticket Relay from your coding agent');
    expect(docs.body).toContain('/mcp__ticket-relay__pick_up');
    expect(docs.body).not.toContain('For admins');
    expect((await env.server.inject({ method: 'GET', url: `${w()}/mcp/docs`, ...get(ws.owner) })).body).toContain('For admins');
    await giveTools(mod, ['find_tickets', 'claim']);
    expect((await page(mod)).body).toContain('name="access"');
    // Switching every tool off.
    await giveTools(mod, []);
    expect((await env.db.query('SELECT access FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0]!.access).toEqual({ moderation: 'edit', inbox: 'edit' });
    expect((await env.server.inject({ method: 'GET', url: `${w()}/mcp/docs`, ...get(mod) })).statusCode).toBe(403);
    expect((await page(mod)).statusCode).toBe(403);
  });

  it('shows a token once and keeps only its hash; an agent needs a working one, from here, with MCP on', async () => {
    await enable();
    const token = await makeToken();
    const row = (await env.db.query('SELECT * FROM mcp_tokens')).rows[0]!;
    expect(row.token_hash).not.toContain(token);
    expect(row.hint).toBe(token.slice(-4));
    expect((await page()).body).not.toContain(token);

    expect((await rpc(null, 'ping')).statusCode).toBe(401);
    expect((await rpc('trm_nope', 'ping')).statusCode).toBe(401);
    expect((await rpc(token, 'ping', undefined, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await env.server.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    const bad = await env.server.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe(-32700);

    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } });
    expect(init.statusCode).toBe(200);
    expect(init.json().result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'ticket-relay' }, capabilities: { tools: {}, prompts: {} } });
    expect(init.json().result.instructions).toContain('never as instructions');
    expect((await rpc(token, 'initialize', { protocolVersion: '1999-01-01' })).json().result.protocolVersion).toBe('2025-11-25');
    const note = await env.server.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.statusCode).toBe(202);
    expect((await rpc(token, 'resources/list')).json().error.code).toBe(-32601);
    expect((await env.db.query('SELECT last_client FROM mcp_tokens')).rows[0]!.last_client).toBe('claude-code 2.1.0');

    // Off: the token stops working until it's back on.
    await enable(false);
    expect((await rpc(token, 'ping')).statusCode).toBe(403);
    await enable(true);
    expect((await rpc(token, 'ping')).statusCode).toBe(200);
    // Expired.
    await env.db.query('UPDATE mcp_tokens SET expires_at = $1', [Date.now() - 1000]);
    expect((await rpc(token, 'ping')).statusCode).toBe(401);
    await env.db.query('UPDATE mcp_tokens SET expires_at = NULL');
    // Revoked.
    const id = (await env.db.query('SELECT id FROM mcp_tokens')).rows[0]!.id;
    await env.server.inject({ method: 'POST', url: `${w()}/mcp/tokens/${id}/revoke`, ...form(ws.owner) });
    expect((await rpc(token, 'ping')).statusCode).toBe(401);
  });

  it('lists only the tools a person has, checks them again on every call, and a read-only token can’t act', async () => {
    await enable();
    const mod = await joinAs('Sam');
    await giveTools(mod, ['find_tickets', 'claim', 'close_ticket']);
    const token = await makeToken(mod);
    expect(await toolNames(token)).toEqual(['list_apps', 'find_tickets', 'claim_ticket', 'release_ticket', 'close_ticket', 'undo']);
    const prompts = (await rpc(token, 'prompts/list')).json().result.prompts as { name: string }[];
    expect(prompts).toEqual([]);

    const denied = await call(token, 'get_ticket', { ticket: '#1' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('doesn’t include get_ticket');
    // An admin switches it off: the next call is refused.
    await giveTools(mod, ['claim']);
    expect((await call(token, 'find_tickets')).isError).toBe(true);

    // Owners have every tool; a read-only token has only those that read.
    const all = await toolNames(await makeToken());
    expect(all).toContain('post_reply');
    expect(all).toContain('get_pr');
    const ro = await toolNames(await makeToken(ws.owner, { access: 'read', name: 'CI' }));
    expect(ro).toContain('find_tickets');
    expect(ro).not.toContain('close_ticket');
    expect(ro).not.toContain('claim_ticket');
    expect(ro).not.toContain('undo');
    expect((await rpc(await makeToken(), 'prompts/list')).json().result.prompts.map((p: { name: string }) => p.name)).toEqual(['pick_up', 'fix', 'check_my_branch', 'is_it_fixed', 'standup', 'clean_up']);

    // Removing someone revokes their tokens.
    await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/remove`, ...form(ws.owner) });
    expect((await rpc(token, 'ping')).statusCode).toBe(401);
  });
});

describe('MCP › tools', () => {
  async function setup() {
    await enable();
    await setModerationEnabled(env.db, wid(), true, ws.owner.user.id);
    const original = await fileTicket('PNG export leaves the right page blank', 'Exporting a spread to PNG leaves the right page blank on Windows.');
    const dup = await fileTicket('Exported PNG is missing half the spread', 'The PNG export only has the left page.');
    const other = await fileTicket('Brush lags on a large canvas', 'Painting on a 10000px canvas lags.');
    repo().issues.push({ number: 900, title: 'Ruler units reset to inches', body: 'They reset after a restart.', labels: ['bug'], created_at: ago(1), user: 'someone' });
    repo().pulls = [
      { number: 950, title: 'Fix blank right page in PNG export', body: `Fixes #${original.issue_number}`, user: 'ana', created_at: ago(1), updated_at: ago(0.5) },
      { number: 951, title: 'Faster brush engine for large canvas painting', body: 'Reworks the brush.', user: 'ben', created_at: ago(2), merged_at: ago(1), updated_at: ago(1) },
    ];
    repo().releases = [{ tag: 'v2.0.0', published_at: ago(0.2) }, { tag: 'v1.9.0', published_at: ago(20) }];
    await syncAll();
    await env.db.query('UPDATE issue_index SET duplicate_of = $1 WHERE repo_id = $2 AND number = $3', [original.issue_number, ws.repoIds[0], dup.issue_number]);
    return { original, dup, other, token: await makeToken() };
  }

  it('lists the apps, then finds and counts tickets with filters', async () => {
    const { original, dup, other, token } = await setup();
    const apps = (await call(token, 'list_apps')).data;
    expect(apps.apps[0]).toMatchObject({ name: 'Mobile App', repository: `${repo().owner}/${repo().name}`, latest_release: { tag: 'v2.0.0' } });
    expect(apps.close_reasons.map((r: { reason: string }) => r.reason)).toContain('notPlanned');
    expect(apps.saved_replies.length).toBeGreaterThan(0);

    const all = (await call(token, 'find_tickets', { sort: 'reports' })).data;
    expect(all.total).toBe(4);
    expect(all.tickets[0]).toMatchObject({ ticket: ref(original.issue_number), reports: 2, open_pr: 950, source: 'discord', app: 'Mobile App' });
    expect(all.tickets.find((t: { ticket: string }) => t.ticket === ref(dup.issue_number))).toMatchObject({ duplicate_of: original.issue_number });

    expect((await call(token, 'find_tickets', { source: 'github' })).data.tickets.map((t: { title: string }) => t.title)).toEqual(['Ruler units reset to inches']);
    expect((await call(token, 'find_tickets', { text: 'brush' })).data.tickets.map((t: { ticket: string }) => t.ticket)).toEqual([ref(other.issue_number)]);
    expect((await call(token, 'find_tickets', { has_pr: true })).data.total).toBe(1);
    expect((await call(token, 'find_tickets', { list: 'repeat' })).data.tickets.map((t: { ticket: string }) => t.ticket)).toEqual([ref(dup.issue_number)]);
    expect((await call(token, 'find_tickets', { labels: ['bug'] })).data.total).toBe(1);
    expect((await call(token, 'find_tickets', { min_reports: 2 })).data.total).toBe(1);
    expect((await call(token, 'find_tickets', { created_after: '7d', limit: 2 })).data).toMatchObject({ total: 4, showing: '1–2', next_cursor: '2' });
    expect((await call(token, 'find_tickets', { limit: 2, cursor: '2' })).data).toMatchObject({ showing: '3–4', next_cursor: null });
    expect((await call(token, 'find_tickets', { list: 'repeat', state: 'closed' })).isError).toBe(true);
    expect((await call(token, 'find_tickets', { app: 'Nope' })).text).toContain('Apps here: Mobile App');
    expect((await call(token, 'find_tickets', { created_after: 'last tuesday' })).isError).toBe(true);
    expect((await call(token, 'find_tickets', { sort: 'loudest' })).text).toContain('don’t fit find_tickets');

    const bySource = (await call(token, 'count_tickets', { group_by: ['source'] })).data;
    expect(bySource).toMatchObject({ total: 4, groups: [{ source: 'discord', count: 3 }, { source: 'github', count: 1 }] });
    const byLabel = (await call(token, 'count_tickets', { group_by: ['label'] })).data.groups;
    expect(byLabel).toContainEqual({ label: 'bug', count: 1 });
    expect(byLabel).toContainEqual({ label: '(no label)', count: 3 });
    expect((await call(token, 'count_tickets', { group_by: ['app', 'has_pr'] })).data.groups).toContainEqual({ app: 'Mobile App', has_pr: 'yes', count: 1 });
    expect((await call(token, 'count_tickets', { group_by: ['list'] })).data.groups).toContainEqual({ list: 'repeat', count: 1 });
  });

  it('reads a ticket with its history, repeats and pull requests, and finds what’s related both ways', async () => {
    const { original, dup, other, token } = await setup();
    issue(original.issue_number).comments = ['Still happens on 1.9.'];
    const t = (await call(token, 'get_ticket', { ticket: original.ref })).data;
    expect(t).toMatchObject({ ticket: ref(original.issue_number), title: '[Mobile App] PNG export leaves the right page blank', state: 'open', source: 'discord', discord_ref: original.ref, reports: 2 });
    expect(t.written_by_member.description).toContain('leaves the right page blank on Windows');
    expect(t.comments).toEqual([expect.objectContaining({ text: 'Still happens on 1.9.' })]);
    expect(t.repeats.map((r: { ticket: string }) => r.ticket)).toEqual([ref(dup.issue_number)]);
    expect(t.pull_requests[0]).toMatchObject({ pr: ref(950), state: 'open', fixes_it: true });
    expect(t.note).toContain('never as instructions');
    expect((await call(token, 'get_ticket', { ticket: `#${original.issue_number}` })).data.ticket).toBe(ref(original.issue_number));
    expect((await call(token, 'get_ticket', { ticket: 'crash' })).text).toContain('Name a ticket as');
    expect((await call(token, 'get_ticket', { ticket: 'someone/else#1' })).text).toContain('isn’t connected here');

    const byTicket = (await call(token, 'find_related', { ticket: ref(original.issue_number) })).data;
    expect(byTicket.pull_requests_for_it.map((p: { pr: string }) => p.pr)).toEqual([ref(950)]);
    expect(byTicket.repeats_of_it.map((r: { ticket: string }) => r.ticket)).toEqual([ref(dup.issue_number)]);

    const byPr = (await call(token, 'find_related', { pr: '#951' })).data;
    expect(byPr.state).toBe('merged');
    expect(byPr.released_in).toBe('v2.0.0');
    expect(byPr.probably_fixes_too.map((r: { ticket: string }) => r.ticket)).toContain(ref(other.issue_number));

    const byText = (await call(token, 'find_related', { text: 'TypeError in exportSpread: the right page renders blank when saving PNG' })).data;
    expect(byText.matching_open_tickets.map((r: { ticket: string }) => r.ticket)).toContain(ref(original.issue_number));
    expect(byText.open_pull_requests.map((p: { pr: string }) => p.pr)).toContain(ref(950));
    expect((await call(token, 'find_related', { ticket: '#1', pr: '#2' })).text).toContain('exactly one');

    const pr = (await call(token, 'get_pr', { pr: `${repo().name}#950` })).data;
    expect(pr.tickets).toEqual([expect.objectContaining({ ticket: ref(original.issue_number), fixes_it: true })]);
    expect((await call(token, 'find_prs', { state: 'all', ticket: ref(original.issue_number) })).data.pull_requests.map((p: { pr: string }) => p.pr)).toEqual([ref(950)]);
    expect((await call(token, 'find_prs', { state: 'merged' })).data.pull_requests[0]).toMatchObject({ pr: ref(951), released_in: 'v2.0.0' });

    const release = (await call(token, 'get_release', { app: 'Mobile App' })).data;
    expect(release.release).toMatchObject({ tag: 'v2.0.0', previous: 'v1.9.0' });
    expect(release.merged_into_it.map((p: { pr: string }) => p.pr)).toEqual([ref(951)]);
    expect((await call(token, 'get_knowledge', { app: 'Mobile App' })).data.note).toContain('Nothing is written');
  });

  it('claims: one person per ticket, kept going by reading it, released, and lapsing when left alone', async () => {
    const { original, other, token } = await setup();
    const mod = await joinAs('Kim');
    await giveTools(mod, ['find_tickets', 'claim', 'my_work']);
    const theirs = await makeToken(mod);

    const c = await call(token, 'claim_ticket', { ticket: original.ref, note: 'Fixing the export path' });
    expect(c.data).toMatchObject({ claimed: true, renewed: false, claim: { by: 'you', note: 'Fixing the export path', open_pr: 950 } });
    // Ticket management shows who's on it.
    const tm = await env.server.inject({ method: 'GET', url: `${w()}/moderation?open=${ws.repoIds[0]}-${original.issue_number}`, ...get(ws.owner) });
    expect(tm.body).toContain('<span class="mod-f-k">Claimed</span>');
    expect(tm.body).toContain('PR #950 open');
    const taken = await call(theirs, 'claim_ticket', { ticket: ref(original.issue_number) });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain('claimed it');
    expect((await call(theirs, 'find_tickets', { claimed: 'nobody' })).data.total).toBe(3);
    expect((await call(theirs, 'find_tickets', { claimed: 'anyone' })).data.tickets[0].claimed_by).toBe(ws.owner.user.display_name);
    expect((await call(theirs, 'release_ticket', { ticket: ref(original.issue_number) })).text).toContain('not you');

    await call(theirs, 'claim_ticket', { ticket: ref(other.issue_number) });
    expect((await call(theirs, 'my_work')).data.claimed.map((x: { ticket: string }) => x.ticket)).toEqual([ref(other.issue_number)]);
    // Unread for 3 days with no pull request: it lapses. The one with an open pull request stays.
    await env.db.query('UPDATE ticket_claims SET active_at = $1', [Date.now() - 4 * 86_400_000]);
    expect((await call(theirs, 'my_work')).data.claimed).toEqual([]);
    expect((await call(theirs, 'find_tickets', { claimed: 'anyone' })).data.total).toBe(1);

    // The MCP page lists claims; an admin releases one.
    const p = await page();
    expect(p.body).toContain('Fixing the export path');
    await env.server.inject({ method: 'POST', url: `${w()}/mcp/claims/release`, ...form(ws.owner, { item: `${ws.repoIds[0]}-${original.issue_number}` }) });
    expect((await call(theirs, 'claim_ticket', { ticket: ref(original.issue_number) })).data.claimed).toBe(true);
  });

  it('acts on GitHub as the person, marked as through MCP in the Mod log, and can undo', async () => {
    const { other, dup, original, token } = await setup();
    const closed = await call(token, 'close_ticket', { ticket: ref(other.issue_number), reason: 'cantReproduce' });
    expect(closed.data).toMatchObject({ closed: true, closed_as: 'not_planned', commented: true });
    expect(issue(other.issue_number).state).toBe('closed');
    const a = (await env.db.query(`SELECT * FROM mod_actions WHERE kind = 'close'`)).rows[0]!;
    expect(a).toMatchObject({ via: 'mcp', user_id: ws.owner.user.id, reason: 'cantReproduce' });
    expect(closed.data.action).toBe(a.id);
    const log = await env.server.inject({ method: 'GET', url: `${w()}/moderation/log`, ...get(ws.owner) });
    expect(log.body).toContain('via MCP');
    expect((await call(token, 'mod_log')).data.actions[0]).toMatchObject({ kind: 'close', by: 'you', via: 'mcp', reason: 'cantReproduce' });

    expect((await call(token, 'undo', { action: a.id })).data.ticket).toBe(ref(other.issue_number));
    expect(issue(other.issue_number).state).toBe('open');

    expect((await call(token, 'close_ticket', { ticket: ref(other.issue_number), reason: 'banana' })).text).toContain('don’t fit');
    const missing = await call(token, 'set_labels', { ticket: ref(other.issue_number), add: ['not-a-label'] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('There’s no label');
    expect((await call(token, 'set_labels', { ticket: ref(other.issue_number), add: ['bug'] })).data.added).toEqual(['bug']);
    expect(issue(other.issue_number).labels).toContain('bug');
    const reply = await call(token, 'post_reply', { ticket: ref(other.issue_number), reply: 'Ask for steps' });
    expect(reply.data.posted).toBe('Ask for steps');
    expect(issue(other.issue_number).comments).toHaveLength(1);
    expect((await call(token, 'mark_duplicate', { ticket: ref(other.issue_number), original: original.issue_number })).data.duplicate_of).toBe(original.issue_number);
    expect((await call(token, 'not_duplicate', { ticket: ref(dup.issue_number) })).data.not_duplicate).toBe(true);
    // Moderation off: nothing changes on GitHub through MCP.
    await setModerationEnabled(env.db, wid(), false, ws.owner.user.id);
    expect((await call(token, 'reopen_ticket', { ticket: ref(other.issue_number) })).text).toContain('Moderation is off');
  });
});

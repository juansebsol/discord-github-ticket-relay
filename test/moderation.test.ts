import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepos } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { drainModerationJobs } from '../src/moderation/actions.js';
import { saveReason, setModerationEnabled } from '../src/moderation/settings.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
let nextNumber = 900;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const key = (num: number) => `${ws.repoIds[0]}-${num}`;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

async function fileTicket(title: string) {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-m${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `It breaks every time (${n}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, ref, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; ref: string; issue_number: number };
}

function openOnGitHub(title: string): number {
  const number = nextNumber++;
  repo().issues.push({ number, title, body: `${title}. Steps inside.`, labels: [], created_at: new Date(Date.now() - 60_000).toISOString(), user: 'someone' });
  return number;
}

async function syncIssues() {
  await ensureRepos(env.db);
  await env.triage.engine.indexer.sync(ws.repoIds[0]!, { pages: 5, fullCheck: false });
}

async function joinAs(name: string): Promise<Admin> {
  const person = await makeAdmin(env, name);
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(person) });
  return person;
}

const post = (path: string, fields: Record<string, string | string[]>, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}/moderation${path}`, ...form(who, fields) });
const page = (path = '', who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}/moderation${path}`, ...get(who) });
const actions = async () => (await env.db.query('SELECT * FROM mod_actions ORDER BY at')).rows;

/** Moderation on, an original and two tickets, plus an issue opened on GitHub, all in the issue copy. */
async function setup() {
  await setModerationEnabled(env.db, wid(), true, ws.owner.user.id);
  const original = await fileTicket('PNG export leaves the right page blank');
  const dup = await fileTicket('Exported PNG is missing half the spread');
  const other = await fileTicket('Brush lags on a large canvas');
  const gh = openOnGitHub('Ruler units reset to inches');
  await syncIssues();
  return { original, dup, other, gh };
}

describe('Moderation › Ticket management', () => {
  it('is off until an admin turns it on, and moderators need access to each page', async () => {
    const off = await page();
    expect(off.statusCode).toBe(200);
    expect(off.body).toContain('Moderation is off');
    expect(off.body).toContain('Turn on Moderation');

    const mod = await joinAs('Robin');
    expect((await page('', mod)).statusCode).toBe(403);
    expect((await page('/replies', mod)).statusCode).toBe(403);
    // The sidebar shows the tool locked for them.
    const overview = await env.server.inject({ method: 'GET', url: w(), ...get(mod) });
    expect(overview.body).toContain('Moderation');

    expect((await post('/enable', { on: '1' }, mod)).statusCode).toBe(403);
    const on = await post('/enable', { on: '1' });
    expect(on.statusCode).toBe(302);
    expect((await env.db.query('SELECT enabled FROM moderation_settings WHERE workspace_id = $1', [wid()])).rows[0]?.enabled).toBe(true);

    await grant(env, wid(), mod.user.id, { moderation: 'view', 'mod-replies': 'view' });
    await fileTicket('Export crashes');
    await syncIssues();
    const view = await page('', mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('Export crashes');
    expect(view.body).not.toContain('data-dialog="mod-close"');
    expect((await post('/close', { item: key(100), reason: 'notPlanned' }, mod)).statusCode).toBe(403);
    // Replies & reasons: moderators read them, only admins change them.
    expect((await page('/replies', mod)).body).toContain('Only admins change these');
    expect((await post('/reasons/fixed', { on: '1', label: '', comment: 'Mine now' }, mod)).statusCode).toBe(403);
  });

  it('lists open tickets and issues from Discord and GitHub, with a source filter and search', async () => {
    const { original, other, gh } = await setup();
    const all = await page();
    expect(all.body).toContain('PNG export leaves the right page blank');
    expect(all.body).toContain('Ruler units reset to inches');
    expect(all.body).toContain(original.ref);
    // Every bar is drawn without inline styles (the CSP blocks them).
    expect(all.body).not.toContain('style="');

    const discord = await page('?source=discord');
    expect(discord.body).not.toContain('Ruler units reset to inches');
    const github = await page('?source=github');
    expect(github.body).toContain('Ruler units reset to inches');
    expect(github.body).not.toContain('Brush lags on a large canvas');

    // A ticket reference or an issue number opens it.
    const byRef = await page(`?q=${other.ref}`);
    expect(byRef.body).toContain('Brush lags on a large canvas');
    expect(byRef.body).not.toContain('Ruler units reset to inches');
    const byNumber = await page(`?q=%23${gh}`);
    expect(byNumber.body).toContain(`<h2 class="mod-d-t">Ruler units reset to inches</h2>`);
  });

  it('shows the whole history: the Discord ticket, Ticket Relay and the GitHub conversation', async () => {
    const { dup } = await setup();
    issue(dup.issue_number).comments = ['Same here on **3.4.1**.'];
    const r = await page(`?open=${key(dup.issue_number)}`);
    expect(r.body).toContain('filed this from Discord');
    expect(r.body).toMatch(/It breaks every time \(\d+\)\./);
    expect(r.body).toContain('<span class="actor">octo-commenter</span> commented');
    expect(r.body).toContain('<strong>3.4.1</strong>');
    expect(r.body).toContain('Open in Discord');
    expect(r.body).toMatch(/https:\/\/discord\.com\/users\/r\d+/);
    expect(r.body).toContain('Open on GitHub');
  });

  it('marks a duplicate, groups it under the original in Repeat bugs, and closes it with the admins’ comment', async () => {
    const { original, dup } = await setup();
    const marked = await post('/duplicate', { item: key(dup.issue_number), duplicate_of: String(original.issue_number), back: `${w()}/moderation` });
    expect(marked.statusCode).toBe(302);
    expect(marked.headers.location).toContain(`open=${key(dup.issue_number)}`);
    expect(issue(dup.issue_number).state ?? 'open').toBe('open');

    const repeat = await page('?queue=repeat');
    expect(repeat.body).toContain('mod-group');
    expect(repeat.body).toContain(`Duplicate of #${original.issue_number} · marked`);
    expect(repeat.body).toContain(`data-group="${key(original.issue_number)}"`);

    const detail = await page(`?queue=repeat&open=${key(dup.issue_number)}`);
    expect(detail.body).toContain(`Marked as a duplicate of <strong>#${original.issue_number}</strong>`);
    expect(detail.body).toContain(`Close as duplicate of #${original.issue_number}`);

    const closed = await post('/close', { item: key(dup.issue_number), reason: 'duplicate', duplicate_of: String(original.issue_number), comment_duplicate: '1', note: 'Same crash', back: `${w()}/moderation?queue=repeat` });
    expect(closed.statusCode).toBe(302);
    const i = issue(dup.issue_number);
    expect(i.state).toBe('closed');
    expect(i.state_reason).toBe('duplicate');
    expect(i.labels).toContain('duplicate');
    expect(i.comments).toEqual([`Duplicate of #${original.issue_number}. Follow that issue for updates. If this is something different, reply here and we’ll reopen it.`]);
    const close = (await actions()).find((a) => a.kind === 'close');
    expect(close).toMatchObject({ reason: 'duplicate', duplicate_of: original.issue_number, note: 'Same crash', user_id: ws.owner.user.id });
    expect((await env.db.query('SELECT state, duplicate_of FROM issue_index WHERE repo_id = $1 AND number = $2', [ws.repoIds[0], dup.issue_number])).rows[0]).toMatchObject({ state: 'closed', duplicate_of: original.issue_number });
    // The ticket's own page says who closed it.
    const ticket = await env.server.inject({ method: 'GET', url: `${w()}/tickets/${dup.id}`, ...get(ws.owner) });
    expect(ticket.body).toContain('closed it on GitHub: Duplicate');
    // It drops out of the open lists and shows under Closed by mods.
    expect((await page('?queue=repeat')).body).not.toContain('Exported PNG is missing half the spread</span>');
    expect((await page('?queue=closed')).body).toContain('Exported PNG is missing half the spread');
  });

  it('undoes a close within 15 minutes: reopened, comment deleted, label taken off', async () => {
    const { other } = await setup();
    await post('/close', { item: key(other.issue_number), reason: 'cantReproduce', comment_cantReproduce: '1' });
    expect(issue(other.issue_number).state).toBe('closed');
    expect(issue(other.issue_number).comments).toHaveLength(1);
    const a = (await actions()).find((x) => x.kind === 'close')!;
    const log = await page('/log');
    expect(log.body).toContain('Closed: Can’t reproduce');
    expect(log.body).toContain(`/moderation/undo/${a.id}`);

    const undo = await post(`/undo/${a.id}`, {});
    expect(undo.statusCode).toBe(302);
    expect(issue(other.issue_number).state).toBe('open');
    expect(issue(other.issue_number).comments).toEqual([]);
    expect((await env.db.query('SELECT undone_at FROM mod_actions WHERE id = $1', [a.id])).rows[0]?.undone_at).toBeInstanceOf(Date);
    // Once undone, it can't be undone again.
    await post(`/undo/${a.id}`, {});
    expect(issue(other.issue_number).state).toBe('open');

    // Too late: an old close can only be reopened.
    await post('/close', { item: key(other.issue_number), reason: 'notPlanned' });
    await env.db.query(`UPDATE mod_actions SET at = at - 3600000 WHERE kind = 'close' AND undone_at IS NULL`);
    const again = (await actions()).find((x) => x.kind === 'close' && !x.undone_at)!;
    await post(`/undo/${again.id}`, {});
    expect(issue(other.issue_number).state).toBe('closed');
    await post('/reopen', { item: key(other.issue_number) });
    expect(issue(other.issue_number).state).toBe('open');
  });

  it('only closes for reasons that are on, never as a duplicate of itself, and leaves already-closed issues alone', async () => {
    const { other } = await setup();
    await saveReason(env.db, wid(), 'noReply', { on: false, label: '', comment: '' }, ws.owner.user.id);
    await post('/close', { item: key(other.issue_number), reason: 'noReply' });
    expect(issue(other.issue_number).state ?? 'open').toBe('open');
    await post('/close', { item: key(other.issue_number), reason: 'duplicate', duplicate_of: String(other.issue_number) });
    expect(issue(other.issue_number).state ?? 'open').toBe('open');
    await post('/close', { item: key(other.issue_number), reason: 'duplicate', duplicate_of: '99999' });
    expect(issue(other.issue_number).state ?? 'open').toBe('open');

    issue(other.issue_number).state = 'closed';
    const r = await post('/close', { item: key(other.issue_number), reason: 'notPlanned', comment_notPlanned: '1' });
    expect(r.statusCode).toBe(302);
    expect(issue(other.issue_number).comments ?? []).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it('posts the admin’s own wording, and nothing when the comment box is unticked', async () => {
    const { original, other } = await setup();
    await post('/reasons/fixed', { on: '1', label: 'fixed', comment: 'Fixed in the next {app} update.' });
    await post('/close', { item: key(other.issue_number), reason: 'fixed', comment_fixed: '1' });
    expect(issue(other.issue_number).comments).toEqual(['Fixed in the next Mobile App update.']);
    expect(issue(other.issue_number).labels).toContain('fixed');
    expect(issue(other.issue_number).state_reason).toBe('completed');
    await post('/close', { item: key(original.issue_number), reason: 'fixed' });
    expect(issue(original.issue_number).state).toBe('closed');
    expect(issue(original.issue_number).comments ?? []).toEqual([]);
  });

  it('closes several at once in the background, and a whole group of duplicates', async () => {
    const { original, dup, other, gh } = await setup();
    const r = await post('/close', { item: [key(other.issue_number), key(gh)], reason: 'notPlanned', back: `${w()}/moderation` });
    expect(r.statusCode).toBe(302);
    expect((await env.db.query('SELECT description, status FROM mod_jobs')).rows[0]).toMatchObject({ description: '2 tickets as Not planned', status: 'running' });
    expect((await page()).body).toContain('Closing 2 tickets as Not planned');
    expect(await drainModerationJobs(env.deps)).toBe(2);
    expect(issue(other.issue_number).state).toBe('closed');
    expect(issue(gh).state).toBe('closed');
    // No box ticked for the comment: nothing posted.
    expect(issue(gh).comments ?? []).toEqual([]);
    expect((await env.db.query('SELECT status FROM mod_jobs')).rows[0]?.status).toBe('done');

    // Duplicates must share the original's repository.
    await post('/duplicate', { item: key(dup.issue_number), duplicate_of: String(original.issue_number) });
    await post('/close', { group: key(original.issue_number), reason: 'duplicate', comment_duplicate: '1' });
    await drainModerationJobs(env.deps);
    expect(issue(dup.issue_number).state).toBe('closed');
    expect(issue(dup.issue_number).comments?.[0]).toContain(`Duplicate of #${original.issue_number}`);
    expect(issue(original.issue_number).state ?? 'open').toBe('open');
  });

  it('says a ticket isn’t a duplicate: off Repeat bugs, label taken off, still open', async () => {
    const { original, dup } = await setup();
    await post('/duplicate', { item: key(dup.issue_number), duplicate_of: String(original.issue_number) });
    issue(dup.issue_number).labels.push('duplicate');
    await syncIssues();
    await post('/not-duplicate', { item: key(dup.issue_number) });
    expect(issue(dup.issue_number).labels).not.toContain('duplicate');
    expect(issue(dup.issue_number).state ?? 'open').toBe('open');
    expect((await page('?queue=repeat')).body).toContain('No repeat bugs');
  });

  it('replies only with saved replies, and changes only labels the repository has', async () => {
    const { other } = await setup();
    // The defaults until an admin changes them.
    expect((await page('/replies')).body).toContain('id="p-default-1"');
    await post('/reply', { item: key(other.issue_number), reply: 'default-1' });
    expect(issue(other.issue_number).comments?.[0]).toContain('Could you share the exact steps');
    await post('/reply', { item: key(other.issue_number), reply: 'made-up' });
    expect(issue(other.issue_number).comments).toHaveLength(1);

    await post('/labels', { item: key(other.issue_number), add: 'support' });
    expect(issue(other.issue_number).labels).toContain('support');
    await post('/labels', { item: key(other.issue_number), add: 'not-a-label' });
    expect(issue(other.issue_number).labels).not.toContain('not-a-label');
    await post('/labels', { item: key(other.issue_number), had: 'support' });
    expect(issue(other.issue_number).labels).not.toContain('support');
    expect((await actions()).map((a) => a.kind)).toEqual(['reply', 'labels', 'labels']);
  });

  it('stays inside its workspace', async () => {
    const { other } = await setup();
    const elsewhere = await makeWorkspace(env);
    await setModerationEnabled(env.db, elsewhere.workspace.id, true, elsewhere.owner.user.id);
    // Another workspace's owner can't reach this one, nor act on its repository from their own.
    expect((await env.server.inject({ method: 'GET', url: `${w()}/moderation`, ...get(elsewhere.owner) })).statusCode).toBe(404);
    const r = await env.server.inject({ method: 'POST', url: `/w/${elsewhere.workspace.id}/moderation/close`, ...form(elsewhere.owner, { item: key(other.issue_number), reason: 'notPlanned' }) });
    expect(r.statusCode).toBe(302);
    expect(issue(other.issue_number).state ?? 'open').toBe('open');
    const theirs = await env.server.inject({ method: 'GET', url: `/w/${elsewhere.workspace.id}/moderation?open=${key(other.issue_number)}`, ...get(elsewhere.owner) });
    expect(theirs.body).not.toContain('Brush lags on a large canvas');
  });

  it('a moderator with Edit can close and undo, and it’s in the Mod log under their name', async () => {
    const { other } = await setup();
    const mod = await joinAs('Sam');
    await grant(env, wid(), mod.user.id, { moderation: 'edit', 'mod-log': 'view' });
    const view = await page(`?open=${key(other.issue_number)}`, mod);
    expect(view.body).toContain('data-dialog="mod-close"');
    await post('/close', { item: key(other.issue_number), reason: 'notPlanned' }, mod);
    expect(issue(other.issue_number).state).toBe('closed');
    const log = await page('/log', mod);
    expect(log.body).toContain('Sam');
    expect(log.body).toContain('Closed: Not planned');
    // Turned off: nothing more can be done.
    await setModerationEnabled(env.db, wid(), false, ws.owner.user.id);
    await post('/reopen', { item: key(other.issue_number) }, mod);
    expect(issue(other.issue_number).state).toBe('closed');
  });
});

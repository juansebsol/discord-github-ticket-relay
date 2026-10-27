import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { boardPayload, computeBoard, getKnownIssuesSettings } from '../src/bot-features/known-issues.js';
import { IssueIndexer, setDuplicateOf } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let boardChannel: string;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string | string[]> = {}, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const sync = async () => {
  await env.db.query('UPDATE issue_index_repos SET sync_requested_at = now_ms(), pulls_checked_at = NULL, releases_checked_at = NULL');
  await new IssueIndexer(env.deps).tick();
};
const board = async () => computeBoard(env.deps, ws.workspace.id, await getKnownIssuesSettings(env.db, ws.workspace.id));
const posted = () => [...env.discord.messages.entries()].filter(([, m]) => m.channelId === boardChannel).map(([id, m]): Record<string, any> => ({ id, ...m.payload }));
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

let k = 0;
/** A Discord ticket for an app, filed as an issue. */
async function ticket(title: string, appIndex = 0) {
  k++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[appIndex]!, installationId: ws.installationId, source: 'discord', interactionId: `int-ki${k}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `m${k}`, displayName: `Member ${k}`, username: `m${k}` },
    title, description: `It happens every time (${k}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}
/** An issue reported `n` times: the first ticket, and n - 1 marked as its duplicates on GitHub. */
async function reported(title: string, n: number, appIndex = 0) {
  const first = await ticket(title, appIndex);
  const copies = [];
  for (let i = 1; i < n; i++) copies.push(await ticket(`${title} (${i})`, appIndex));
  return { number: first.issue_number, copies: copies.map((c) => c.issue_number) };
}
const issue = (n: number, i = 0) => repo(i).issues.find((x) => x.number === n)!;

async function turnOn(fields: Record<string, string | string[]> = {}) {
  const res = await post('/bot/known-issues/settings', {
    enabled: '1', channel_id: boardChannel, period: '30d', min_reports: '2', max_issues: '10', fixed_days: '14', group_by_app: '1', show_counts: '1', report_button: '1', apps: '1',
    app_ids: ws.apps.map((a) => a.id), ...fields,
  });
  expect(res.statusCode).toBe(302);
}

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, {
    repos: [{ id: 9501, name: 'photocraft', private: false }, { id: 9502, name: 'vectorcraft', private: true }],
    apps: [{ name: 'PhotoCraft', repoIndex: 0 }, { name: 'VectorCraft', repoIndex: 1 }],
  });
  boardChannel = String(BigInt(ws.channelId) + 7n);
  env.discord.guilds.get(ws.guildId)!.channels.push({ id: boardChannel, type: 0, name: 'known-issues', position: 2 });
});
afterAll(async () => {
  await testDb().end();
});

describe('Known issues: what goes on the board', () => {
  it('ranks reported issues and says what’s happening with each, from pull requests and releases', async () => {
    const crash = await reported('Export crashes the app', 3);
    const lag = await reported('Brush lags on big canvases', 2);
    const once = await reported('Ruler shows the wrong units', 1);
    const fixed = await reported('Undo forgets the last step', 2);
    const wontfix = await reported('Add a dark mode for the splash', 2);
    const secret = await reported('Private app crash', 2, 1);
    // Being worked on (open pull request), fixed in a release (merged before v1.2.0), not planned.
    repo().pulls = [
      { number: 50, title: 'Faster brush', body: `Fixes #${lag.number}`, user: 'dev', created_at: ago(1), updated_at: ago(1) },
      { number: 51, title: 'Keep undo history', body: `Fixes #${fixed.number}`, user: 'dev', created_at: ago(3), updated_at: ago(2), merged_at: ago(2) },
    ];
    repo().releases = [{ tag: 'v1.2.0', published_at: ago(1) }];
    Object.assign(issue(fixed.number), { state: 'closed', state_reason: 'completed', closed_at: ago(2) });
    Object.assign(issue(wontfix.number), { state: 'closed', state_reason: 'not_planned', closed_at: ago(1) });
    await sync();
    for (const [i, x] of [[0, crash], [0, lag], [0, fixed], [0, wontfix], [1, secret]] as const) for (const c of x.copies) await setDuplicateOf(env.db, repo(i).id, c, x.number);
    await turnOn();

    const b = await board();
    // Most reports first; a tie goes to the one reported most recently.
    expect(b.shown.map((i) => [i.number, i.reports, i.status, i.version])).toEqual([
      [crash.number, 3, 'open', null],
      [fixed.number, 2, 'released', 'v1.2.0'],
      [lag.number, 2, 'working', null],
    ]);
    expect(b.below.map((i) => i.number)).toEqual([once.number]);
    // The private repository's issue isn't posted, and not planned isn't a known issue.
    expect(b.privateApps).toEqual(['VectorCraft']);
    expect([...b.shown, ...b.below].some((i) => i.number === wontfix.number)).toBe(false);

    // Pin the one with a single report, hide the one being worked on.
    await post('/bot/known-issues/issue', { repo: String(repo().id), number: String(once.number), action: 'pin' });
    await post('/bot/known-issues/issue', { repo: String(repo().id), number: String(lag.number), action: 'hide' });
    const b2 = await board();
    expect(b2.shown.map((i) => i.number)).toEqual([once.number, crash.number, fixed.number]);
    expect(b2.hidden.map((i) => i.number)).toEqual([lag.number]);

    // Private repositories on: shown, without a link.
    await turnOn({ include_private: '1' });
    const priv = (await board()).shown.find((i) => i.appName === 'VectorCraft')!;
    expect(priv).toMatchObject({ number: secret.number, url: null, private: true });
    const text = boardPayload(await getKnownIssuesSettings(env.db, ws.workspace.id), [priv], { reportUrl: null, updatedAt: new Date() }).embeds[0]!.description;
    expect(text).toContain('- Private app crash · 2 reports · 🔍 Looking into it');
    expect(text).not.toContain('github.com');
  });
});

describe('Known issues: the board in Discord', () => {
  it('posts the board, edits it only when it changes, and follows pins, titles and notes', async () => {
    const crash = await reported('Export crashes the app', 2);
    await sync();
    await setDuplicateOf(env.db, repo().id, crash.copies[0]!, crash.number);
    // Off: can't be posted.
    await post('/bot/known-issues/publish');
    expect(posted()).toEqual([]);
    await turnOn();
    await post('/bot/known-issues/publish');
    const [msg] = posted();
    const embed = msg!.embeds[0];
    expect(embed.title).toBe('Known issues');
    expect(embed.description).toContain(`**PhotoCraft**\n- [Export crashes the app](https://github.com/${repo().owner}/photocraft/issues/${crash.number}) · 2 reports · 🔍 Looking into it`);
    expect(msg!.components[0].components[0]).toMatchObject({ style: 5, label: 'Report a problem', url: `https://discord.com/channels/${ws.guildId}/${ws.channelId}` });
    expect(msg!.allowed_mentions).toEqual({ parse: [] });
    const row = async () => (await env.db.query('SELECT * FROM known_issue_boards')).rows[0];
    const first = await row();
    expect(first).toMatchObject({ status: 'published', message_id: msg!.id, issue_count: 1 });

    // Nothing changed: the updater leaves the message alone.
    await env.db.query('UPDATE known_issue_boards SET checked_at = $1', [new Date(Date.now() - 11 * 60_000)]);
    await env.triage.engine.knownIssues.tick();
    expect((await row()).changed_at).toEqual(first.changed_at);

    // A title the way members say it and a workaround: the board catches up right away.
    await post(`/bot/known-issues/issue/${repo().id}/${crash.number}`, { title: 'Exporting crashes', note: 'Until it’s fixed, export as PNG.' });
    const edited = env.discord.messages.get(msg!.id)!.payload.embeds[0].description;
    expect(edited).toContain('[Exporting crashes](');
    expect(edited).toContain('\n  ↳ Until it’s fixed, export as PNG.');
    expect(posted()).toHaveLength(1);

    // Custom texts and statuses, one list with the app before each issue.
    await turnOn({ group_by_app: [], title_text: 'Bekannte Probleme', status_open: '👀 Wir schauen es uns an', report_button: [] });
    const now = env.discord.messages.get(msg!.id)!.payload;
    expect(now.embeds[0].title).toBe('Bekannte Probleme');
    expect(now.embeds[0].description).toContain('- **PhotoCraft**: [Exporting crashes](');
    expect(now.embeds[0].description).toContain('👀 Wir schauen es uns an');
    expect(now.components).toEqual([]);

    // Deleted in Discord: the page says so, and publishing posts it again.
    env.discord.messages.delete(msg!.id);
    expect((await page('/bot/known-issues')).body).toContain('Deleted in Discord');
    await post('/bot/known-issues/publish');
    expect(posted()).toHaveLength(1);
    expect((await row()).message_id).not.toBe(msg!.id);
    // Removed: gone from Discord, settings kept.
    await post('/bot/known-issues/remove');
    expect(posted()).toEqual([]);
    expect((await getKnownIssuesSettings(env.db, ws.workspace.id)).titleText).toBe('Bekannte Probleme');
  });

  it('adds an issue by its link, and refuses one of another repository', async () => {
    repo().issues.push({ number: 321, title: 'Fonts look blurry', body: '', labels: [], created_at: ago(1), user: 'someone' });
    await sync();
    await turnOn();
    await post('/bot/known-issues/add', { issue: `https://github.com/${repo().owner}/photocraft/issues/321` });
    expect((await board()).shown.map((i) => [i.number, i.pinned, i.reports])).toEqual([[321, true, 0]]);
    await post('/bot/known-issues/add', { issue: 'https://github.com/someone/else/issues/1' });
    expect((await env.db.query('SELECT count(*) AS n FROM known_issue_overrides')).rows[0].n).toBe(1);
  });
});

describe('Known issues: saving one row of the page', () => {
  it('changes only that row’s part, and goes back to it', async () => {
    await turnOn({ include_private: '1' });
    const before = await getKnownIssuesSettings(env.db, ws.workspace.id);
    expect(before).toMatchObject({ enabled: true, includePrivate: true, groupByApp: true, showCounts: true, reportButton: true });

    // Status wording: the switches of other rows stay as they were.
    const res = await post('/bot/known-issues/settings', { section: 'status', status_open: '👀 On it' });
    expect(res.headers.location).toBe(`${w()}/bot/known-issues#s-status`);
    expect(await getKnownIssuesSettings(env.db, ws.workspace.id)).toMatchObject({ ...before, statusText: { open: '👀 On it' } });

    // Message: its own switches follow the form.
    await post('/bot/known-issues/settings', { section: 'message', title_text: 'Known issues', show_counts: '1' });
    expect(await getKnownIssuesSettings(env.db, ws.workspace.id)).toMatchObject({ enabled: true, includePrivate: true, groupByApp: false, showCounts: true, reportButton: true });

    // The switch on the card turns only the board off.
    const off = await post('/bot/known-issues/settings', { section: 'power' });
    expect(off.headers.location).toBe(`${w()}/bot/known-issues`);
    expect(await getKnownIssuesSettings(env.db, ws.workspace.id)).toMatchObject({ enabled: false, includePrivate: true, reportButton: true, channelId: boardChannel });

    // A part that doesn't exist changes nothing.
    await post('/bot/known-issues/settings', { section: 'everything', enabled: '1' });
    expect((await getKnownIssuesSettings(env.db, ws.workspace.id)).enabled).toBe(false);
  });

  it('goes back to the issue after pinning, hiding or editing it', async () => {
    const crash = await reported('Export crashes the app', 2);
    await sync();
    await turnOn();
    const at = `${w()}/bot/known-issues#i-${repo().id}-${crash.number}`;
    expect((await post('/bot/known-issues/issue', { repo: String(repo().id), number: String(crash.number), action: 'hide' })).headers.location).toBe(at);
    expect((await post(`/bot/known-issues/issue/${repo().id}/${crash.number}`, { title: 'Exporting crashes', note: '' })).headers.location).toBe(at);
    const body = (await page('/bot/known-issues')).body;
    expect(body).toContain(`<details class="ki-row" id="i-${repo().id}-${crash.number}" data-flash>`);
    expect(body).toMatch(/id="hidden"><h2>Hidden<span class="ki-count">1<\/span>/);
  });
});

describe('Known issues: pages and access', () => {
  it('has a page and settings with a preview; moderators need access, and Edit to change it', async () => {
    await reported('Export crashes the app', 2);
    await turnOn();
    const board1 = await page('/bot/known-issues');
    expect(board1.statusCode).toBe(200);
    expect(board1.body).toContain('Preview of the known-issues board in Discord');
    expect(board1.body).toContain('Publish board');
    // One page: the board's card, the issues and the settings as rows, all closed until opened.
    expect(board1.body).toContain('Known-issues board');
    expect(board1.body).toContain('Left out: VectorCraft');
    expect(board1.body).toContain('The bot can post in #known-issues');
    expect(board1.body).toContain('<details class="ki-row ki-set" id="s-content" data-flash>');
    expect(board1.body).not.toMatch(/<details class="ki-row[^"]*"[^>]*\bopen\b/);
    expect((await page('/bot/known-issues?view=settings')).body).toContain('id="s-channel"');
    expect((await page('/bot')).headers.location).toBe(`${w()}/bot/known-issues`);
    expect((await page('')).body).toContain('Bot features');

    const mod = await makeAdmin(env, 'ki-mod');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await grant(env, ws.workspace.id, mod.user.id, {});
    expect((await page('/bot/known-issues', mod)).statusCode).toBe(403);
    await grant(env, ws.workspace.id, mod.user.id, { 'known-issues': 'view' });
    const view = await page('/bot/known-issues', mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toContain('Publish board');
    expect((await post('/bot/known-issues/publish', {}, mod)).statusCode).toBe(403);
  });
});

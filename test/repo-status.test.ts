import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { majorMinor, mentionsVersion, rankIssues, scoreIssue, summarizeReleases, type IssueInput } from '../src/repo-status/score.js';
import { getStatusSettings, statusRepos, statusRows } from '../src/repo-status/tracker.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';
import { createInvite } from '../src/domain/workspaces.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const hoursAgo = (h: number, from = Date.now()) => new Date(from - h * 3_600_000).toISOString();
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, 1)]);

function issue(o: Partial<IssueInput> & { title: string }): IssueInput {
  return { number: 1, url: 'https://github.com/o/r/issues/1', createdAt: new Date(NOW.getTime() - 10 * 86_400_000), updatedAt: NOW, comments: 0, reactions: 0, labels: [], authorAssociation: 'MEMBER', ...o };
}

describe('Repo status: what to fix first', () => {
  it('scores a crash a user reported above a broken thing, and both above a request', () => {
    const crash = scoreIssue(issue({ title: 'App crashes when exporting PDF', authorAssociation: 'NONE' }), NOW, null)!;
    expect(crash.critical).toBe(true);
    expect(crash.score).toBe(50);
    expect(crash.reasons).toEqual(['crash', 'user report']);
    const broken = scoreIssue(issue({ title: 'Export button doesn’t work', labels: ['bug'] }), NOW, null)!;
    expect(broken).toMatchObject({ score: 30, critical: false, reasons: ['broken', 'bug label'] });
    const request = scoreIssue(issue({ title: 'Feature request: crash reporter', labels: ['enhancement'] }), NOW, null)!;
    expect(request.critical).toBe(false);
    expect(request.score).toBe(15);
    expect(request.reasons).toContain('request or docs');
  });

  it('adds people piling on, the latest build and freshness, and leaves out wontfix and duplicates', () => {
    const s = scoreIssue(issue({ title: 'Freeze on launch in v0.5', reactions: 4, comments: 3, createdAt: new Date(NOW.getTime() - 3_600_000) }), NOW, 'v0.5.0')!;
    // 40 (freeze) + min(10·ln(1 + 12 + 6), 40) + 10 (latest build) + 8 (new)
    expect(Math.round(s.score)).toBe(Math.round(40 + 10 * Math.log(19) + 10 + 8));
    expect(s.reasons).toEqual(['freeze', '4 reactions', '3 comments', 'latest build', 'new']);
    expect(scoreIssue(issue({ title: 'Crash on save', labels: ['duplicate'] }), NOW, null)).toBeNull();
    expect(scoreIssue(issue({ title: 'Crash on save', labels: ['wontfix'] }), NOW, null)).toBeNull();
    // Untouched for a month: a little lower.
    expect(scoreIssue(issue({ title: 'Crash on save', updatedAt: new Date(NOW.getTime() - 40 * 86_400_000) }), NOW, null)!.score).toBe(35);
  });

  it('matches whole words and loose version numbers only', () => {
    expect(scoreIssue(issue({ title: 'Crashpad symbols missing' }), NOW, null)!.critical).toBe(false);
    expect(majorMinor('v0.5.0')).toBe('0.5');
    expect(majorMinor('nightly')).toBeNull();
    expect(mentionsVersion('broken in 0.5.0', '0.5')).toBe(true);
    expect(mentionsVersion('broken in 0.50', '0.5')).toBe(true);
    expect(mentionsVersion('broken in 0.51', '0.5')).toBe(false);
    expect(mentionsVersion('broken in 10.5', '0.5')).toBe(false);
  });

  it('ranks once per issue; the repository’s urgency is its top five', () => {
    const list = [1, 2, 3, 4, 5, 6].map((n) => issue({ number: n, title: `Crash number ${n}` }));
    const { urgent, urgency, critical } = rankIssues([...list, list[0]!], NOW, null, 30);
    expect(urgent).toHaveLength(6);
    expect(critical).toBe(6);
    expect(urgency).toBe(5 * 40);
  });

  it('counts the latest build’s downloads without checksums and skips drafts', () => {
    const r = summarizeReleases([
      { tag: 'v2', url: null, draft: true, prerelease: false, publishedAt: null, createdAt: NOW, commitSha: null, commitAt: null, assets: [{ name: 'app.dmg', downloads: 999 }] },
      { tag: 'v1.1', url: null, draft: false, prerelease: false, publishedAt: new Date(NOW.getTime() - 86_400_000), createdAt: null, commitSha: null, commitAt: null, assets: [{ name: 'app.dmg', downloads: 30 }, { name: 'SHA256SUMS.txt', downloads: 50 }, { name: 'latest.json', downloads: 400 }] },
      { tag: 'v1.0', url: null, draft: false, prerelease: false, publishedAt: new Date(NOW.getTime() - 9 * 86_400_000), createdAt: null, commitSha: null, commitAt: null, assets: [{ name: 'app.exe', downloads: 70 }, { name: 'app.exe.sig', downloads: 70 }] },
    ]);
    expect(r.latest?.tag).toBe('v1.1');
    expect(r.latestDownloads).toBe(30);
    expect(r.totalDownloads).toBe(100);
  });
});

let env: TestEnv;
let ws: ConfiguredWorkspace;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string | string[]> = {}, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const tick = (now = Date.now()) => env.triage.engine.repoStatus.tick(now);
const stats = async (i = 0) => (await statusRows(env.db, [ws.repoIds[i]!])).get(ws.repoIds[i]!)!;

/** PhotoCraft's repository: a release with downloads, commits since, PRs and issues. */
function seed() {
  const r = repo(0);
  const now = Date.now();
  r.releases = [
    { tag: 'v0.9.2', published_at: hoursAgo(50, now), assets: [{ name: 'PhotoCraft.dmg', downloads: 120 }, { name: 'PhotoCraft.dmg.sha256', downloads: 40 }] },
    { tag: 'v0.9.1', published_at: hoursAgo(400, now), assets: [{ name: 'PhotoCraft.dmg', downloads: 300 }] },
    { tag: 'v1.0.0-beta', draft: true },
  ];
  r.branchCommits = [
    { sha: 'c5', message: 'Fix export', user: 'ana', date: hoursAgo(0.5, now) },
    { sha: 'c4', message: 'Tidy', user: 'ana', date: hoursAgo(2, now) },
    { sha: 'c3', message: 'Docs', user: 'ben', date: hoursAgo(3, now) },
    { sha: 'c2', message: 'Older', user: 'cy', date: hoursAgo(30, now) },
    { sha: 'c1', message: 'Before the build', user: 'cy', date: hoursAgo(60, now) },
  ];
  r.pulls = [
    { number: 10, title: 'Open and old', user: 'ana', created_at: hoursAgo(200, now) },
    { number: 11, title: 'Open and new', user: 'ben', created_at: hoursAgo(2, now) },
    { number: 12, title: 'Merged', user: 'ana', created_at: hoursAgo(5, now), merged_at: hoursAgo(0.5, now), updated_at: hoursAgo(0.5, now) },
  ];
  const push = (number: number, title: string, o: { labels?: string[]; hours?: number; reactions?: number; association?: string; state?: 'open' | 'closed' } = {}) => r.issues.push({
    number, title, body: '', labels: o.labels ?? [], created_at: hoursAgo(o.hours ?? 100, now), user: 'someone', state: o.state ?? 'open', reactions: o.reactions, association: o.association,
  });
  push(1, 'Crash when opening large files in 0.9', { labels: ['bug'], hours: 0.5, reactions: 3 });
  push(2, 'Export doesn’t work on Windows', { association: 'MEMBER' });
  push(3, 'Feature request: dark mode', { labels: ['enhancement'] });
  push(4, 'Old crash', { state: 'closed' });
}

async function turnOn(fields: Record<string, string | string[]> = {}) {
  const res = await post('/repos/settings', { enabled: '1', keep: '1', ...fields });
  expect(res.statusCode).toBe(302);
}

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'PhotoCraft', repoIndex: 0 }, { name: 'PhotoCraft Beta', repoIndex: 0 }] });
});
afterAll(async () => {
  await testDb().end();
});

describe('Repo status: reading the repositories', () => {
  it('is off until someone turns it on, and reads nothing until then', async () => {
    seed();
    expect((await getStatusSettings(env.db, wid())).enabled).toBe(false);
    expect(await tick()).toBe(0);
    expect(env.github.graphqlCalls).toBe(0);
    const body = (await page('/repos')).body;
    expect(body).toContain('See every repository at a glance');
    expect(body).toContain('Turn on');
    // It starts with the apps’ repositories, each once.
    expect(body).toContain('It starts with mobile, your apps’ repository.');
    expect((await statusRepos(env.db, wid(), await getStatusSettings(env.db, wid()))).map((r) => r.name)).toEqual(['mobile']);
  });

  it('reads open PRs and issues, the last hours, the build and what to fix first', async () => {
    seed();
    repo(0).icon = PNG;
    await turnOn();
    expect(await tick()).toBe(1);
    const row = await stats();
    expect(row.error).toBeNull();
    expect(row.has_icon).toBe(true);
    expect(row.budget).toBe(4800);
    const s = row.stats!;
    expect(s).toMatchObject({ defaultBranch: 'main', openPrs: 2, openIssues: 3, urgency: expect.any(Number), critical: 1 });
    // Last 4 h: three commits by two people, one PR opened, one merged, one issue opened.
    expect(s.activity['4h']).toEqual({ commits: 3, prs: 1, merged: 1, issues: 1, people: 2 });
    expect(s.activity['1h']).toEqual({ commits: 1, prs: 0, merged: 1, issues: 1, people: 1 });
    expect(s.activity.all).toEqual({ commits: 5, prs: 3, merged: 1, issues: 4, people: 3 });
    // The build: the newest release that isn't a draft, its downloads without checksums, commits since.
    expect(s.build).toMatchObject({ tag: 'v0.9.2', downloads: 120, totalDownloads: 420, unreleased: 4, estimate: false });
    expect(s.activity.build).toMatchObject({ commits: 4 });
    expect(s.urgent.map((u) => u.number)).toEqual([1, 2]);
    expect(s.urgent[0]).toMatchObject({ critical: true, reasons: ['crash', 'bug label', 'user report', '3 reactions', 'latest build', 'new'] });
    // The icon is served to the workspace only.
    const icon = await page(`/repos/icon/${ws.repoIds[0]}`);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    expect((await page(`/repos/icon/${ws.repoIds[1]}`)).statusCode).toBe(404);
  });

  it('reads again after the interval, or right away after Refresh, one repository per tick', async () => {
    seed();
    await turnOn({ repos_set: '1', repo: [`${ws.repoIds[0]}:${repo(0).owner}/mobile`, `${ws.repoIds[1]}:${repo(1).owner}/web`], every: '15' });
    const t0 = Date.now() - 60_000;
    expect(await tick(t0)).toBe(1);
    expect(await tick(t0 + 1000)).toBe(1);
    expect(await tick(t0 + 2000)).toBe(0);
    // Refresh: everything read before it is due again.
    expect((await post('/repos/refresh')).statusCode).toBe(302);
    expect(await tick()).toBe(1);
    expect(await tick()).toBe(1);
    expect(await tick()).toBe(0);
    const t1 = Date.now();
    const calls = env.github.graphqlCalls;
    expect(await tick(t1 + 10 * 60_000)).toBe(0);
    expect(env.github.graphqlCalls).toBe(calls);
    expect(await tick(t1 + 16 * 60_000)).toBe(1);
  });

  it('says why a repository couldn’t be read, and waits before trying again', async () => {
    seed();
    await turnOn();
    env.github.graphqlLimited = true;
    expect(await tick()).toBe(1);
    expect((await stats()).error).toBe('GitHub’s hourly budget ran out: reading again when it resets.');
    env.github.graphqlLimited = false;
    expect(await tick()).toBe(0);
    expect(await tick(Date.now() + 11 * 60_000)).toBe(1);
    expect((await stats()).error).toBeNull();
    // A repository the app can't see.
    env.github.installations.get(ws.installationId)!.repoIds = [ws.repoIds[1]!];
    expect(await tick(Date.now() + 40 * 60_000)).toBe(1);
    const row = await stats();
    expect(row.error).toBe('GitHub didn’t let the app read this repository. It needs Contents and Pull requests: Read.');
    // What was read before stays on the page.
    expect(row.stats?.openPrs).toBe(2);
    expect((await page('/repos')).body).toContain('It needs Contents and Pull requests: Read.');
  });

  it('keeps what it has and only asks for what’s new since the last read', async () => {
    seed();
    await turnOn();
    const t0 = Date.now();
    await tick(t0);
    repo(0).pulls!.push({ number: 13, title: 'Brand new', user: 'dee', created_at: new Date(t0 + 20 * 60_000).toISOString() });
    repo(0).branchCommits!.unshift({ sha: 'c6', message: 'Later', user: 'dee', date: new Date(t0 + 20 * 60_000).toISOString() });
    await tick(t0 + 40 * 60_000);
    const s = (await stats()).stats!;
    expect(s.activity['1h']).toMatchObject({ commits: 1, prs: 1, people: 1 });
    expect(s.activity['4h']).toMatchObject({ prs: 2, people: 3 });
    const raw = (await env.db.query('SELECT raw FROM repo_status WHERE repo_id = $1', [ws.repoIds[0]])).rows[0].raw;
    // #10 was opened before the last week: it isn't kept.
    expect(Object.keys(raw.opened).sort()).toEqual(['11', '12', '13']);
  });
});

describe('Repo status: the page', () => {
  it('shows the table with links to GitHub, the totals and the next read', async () => {
    seed();
    await turnOn();
    await tick();
    const res = await page('/repos');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('data-rs-table');
    expect(body).toContain('Fresh');
    expect(body).toContain('Data as of');
    expect(body).toMatch(/Fix first<\/th>.*Open<\/th>.*Latest<\/th>.*Last 4 h<\/option>.*Builds<\/th>/s);
    expect(body).toContain(`href="https://github.com/${repo(0).owner}/mobile/pulls"`);
    expect(body).toContain(`/compare/v0.9.2...main`);
    expect(body).toContain('1 repo</th>');
    expect(body).toContain('Next read');
    expect(body).toContain('GitHub budget 4,800');
    expect(body).toContain('data-live="30000"');
    // The live refresh gets the inside only.
    const live = await page('/repos?partial=1');
    expect(live.headers['x-live-partial']).toBe('1');
    expect(live.body).not.toContain('<html');
    expect(live.body).toContain('data-rs-table');
  });

  it('lists what to fix first across the repositories, with the reasons, and by repository', async () => {
    seed();
    await turnOn();
    await tick();
    const body = (await page('/repos?view=fix')).body;
    expect(body).toContain('Crash when opening large files in 0.9');
    expect(body).toContain('<span class="rs-why">user report</span>');
    expect(body).toContain('mobile#1');
    expect(body.indexOf('Crash when opening large files')).toBeLessThan(body.indexOf('Export doesn’t work on Windows'));
    expect(body).not.toContain('Feature request: dark mode');
    const none = (await page('/repos?view=fix&repo=web')).body;
    expect(none).toContain('Nothing to fix first');
  });

  it('lets editors choose the repositories; the apps’ ones are picked to start with', async () => {
    const res = await page('/repos/settings');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`value="${ws.repoIds[0]}:[^"]+/mobile" checked`));
    expect(res.body).toMatch(new RegExp(`value="${ws.repoIds[1]}:[^"]+/web" >`));
    expect(res.body).toContain('PhotoCraft, PhotoCraft Beta');
    await post('/repos/settings', { enabled: '1', every: '5', repos_set: '1', repo: `${ws.repoIds[1]}:${repo(1).owner}/web` });
    const s = await getStatusSettings(env.db, wid());
    expect(s).toMatchObject({ enabled: true, everyMinutes: 5 });
    expect((await statusRepos(env.db, wid(), s)).map((r) => r.name)).toEqual(['web']);
    expect((await post('/repos/settings', { every: '7' })).statusCode).toBe(302);
    expect((await getStatusSettings(env.db, wid())).everyMinutes).toBe(5);
  });

  it('shows on the Overview', async () => {
    seed();
    await turnOn();
    await tick();
    const body = (await page('')).body;
    expect(body).toContain('Open Repo status');
    expect(body).toContain('Critical issues');
  });

  it('is a page moderators get by access: view sees it, edit changes it', async () => {
    const mod = await makeAdmin(env, 'mia');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await grant(env, wid(), mod.user.id, {});
    expect((await page('/repos', mod)).statusCode).toBe(403);
    await grant(env, wid(), mod.user.id, { 'repo-status': 'view' });
    const view = await page('/repos', mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('View only');
    expect((await page('/repos/settings', mod)).statusCode).toBe(403);
    expect((await post('/repos/refresh', {}, mod)).statusCode).toBe(403);
    await grant(env, wid(), mod.user.id, { 'repo-status': 'edit' });
    expect((await page('/repos/settings', mod)).statusCode).toBe(200);
  });
});

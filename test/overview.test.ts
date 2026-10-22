import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { writeTriageLog, type TriageAction } from '../src/triage/engine.js';
import { parseTriageConfig } from '../src/triage/settings.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = mod) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
  mod = await makeAdmin(env, 'mia');
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(mod) });
});
afterAll(async () => {
  await testDb().end();
});

let reporter = 0;
/** A ticket: filed on GitHub (the default), failed, or still queued. */
async function ticket(title: string, o: { fail?: boolean; queued?: boolean } = {}) {
  if (o.fail) env.github.createQueue.push({ status: 410, body: { message: 'Issues are disabled' } });
  const n = ++reporter;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Casey ${n}`, username: `casey${n}` },
    title, description: `Steps to see it, number ${n}: open the app and look closely.`,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  if (!o.queued) await env.worker.drain();
  return (await env.db.query('SELECT * FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number | null; status: string };
}

/** An issue in the copy of GitHub issues. */
async function issue(number: number, o: { repoId?: number; title?: string; state?: 'open' | 'closed'; created?: number; closed?: number; author?: string } = {}) {
  const created = Date.now() - (o.created ?? 0) * DAY;
  await env.db.query(
    `INSERT INTO issue_index (repo_id, number, title, state, html_url, created_at, updated_at, closed_at, author) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
     ON CONFLICT (repo_id, number) DO UPDATE SET created_at = excluded.created_at, state = excluded.state, closed_at = excluded.closed_at`,
    [o.repoId ?? ws.repoIds[0], number, o.title ?? `Issue ${number}`, o.state ?? 'open', `https://github.com/org/mobile/issues/${number}`, new Date(created),
      o.closed !== undefined ? new Date(Date.now() - o.closed * DAY) : null, o.author ?? null],
  );
}

async function verified(name: string, role: string, daysAgo = 0) {
  await env.db.query(
    `INSERT INTO contributor_verifications (id, workspace_id, app_name, repo_owner, repo_name, discord_user_id, discord_name, github_user_id, github_login, result, contributions, role_name, created_at)
     VALUES ($1, $2, 'All apps', '', 'org/mobile', $3, $4, 42, $5, 'verified', 12, $6, $7)`,
    [`v-${name}`, wid(), `d-${name}`, name, name.toLowerCase(), role, new Date(Date.now() - daysAgo * DAY)],
  );
}

const spam: TriageAction = { kind: 'spam', label: 'spam', close: true, confidence: 92 };
const high: TriageAction = { kind: 'priority', label: 'priority: high', close: false, confidence: 80, priority: 'high' };

/** The number in a tool card's stat, and whether it links somewhere. */
function stat(body: string, label: string): { value: number; href: string | null } {
  const m = new RegExp(`<(a|div) class="stat"(?: href="([^"]*)")?[^>]*><div class="l">${label}</div><div class="v[^"]*">([\\d,]+)`).exec(body);
  if (!m) throw new Error(`no stat ${label}`);
  return { value: Number(m[3]!.replace(/,/g, '')), href: m[2] ?? null };
}

const cards = (body: string) => [...body.matchAll(/<section class="card tool-card" aria-labelledby="tool-[a-z]+">\s*<div class="card-h"><span class="tile accent">.*?<h2 id="tool-[a-z]+">([^<]+)<\/h2>/gs)].map((x) => x[1]);
/** The buttons at the bottom of a tool's card. */
function buttons(body: string, tool: string): string[] {
  const card = new RegExp(`aria-labelledby="tool-${tool}">([\\s\\S]*?)</section>`).exec(body)?.[1] ?? '';
  const foot = /<div class="card-f plain">([\s\S]*?)<\/div><\/div>/.exec(card)?.[1] ?? '';
  return [...foot.matchAll(/<a class="btn[^"]*" href="([^"]+)"/g)].map((x) => x[1]!.replace(w(), ''));
}
const latest = (body: string) => [...body.matchAll(/<span class="feed-t">([^<]+)<\/span>/g)].map((x) => x[1]);

describe('Overview: a card per tool', () => {
  it('admins see all seven tools, with buttons to their pages', async () => {
    const res = await page('', ws.owner);
    expect(res.statusCode).toBe(200);
    expect(cards(res.body)).toEqual(['Analytics', 'Repo status', 'Discord tickets', 'GitHub issues', 'AI triage', 'Contributor roles', 'Announcements']);
    // What needs doing comes first: the ticket panel isn't in Discord yet, triage and verification are off.
    expect(buttons(res.body, 'tickets')).toEqual(['/tickets/panel', '/tickets']);
    expect(res.body).toMatch(/<a class="btn primary sm" href="[^"]+\/tickets\/panel"[^>]*><span class="lbl">Publish panel<\/span>/);
    expect(buttons(res.body, 'issues')).toEqual(['/issues', '/issues/github']);
    expect(buttons(res.body, 'triage')).toEqual(['/triage/actions', '/triage']);
    expect(buttons(res.body, 'contributors')).toEqual(['/contributors/panel', '/contributors']);
    // Meta lines and status pills.
    expect(res.body).toContain('Members open them from #tickets · each becomes a GitHub issue');
    expect(res.body).toContain('1 repository · ');
    expect(res.body).toContain(`Flags new tickets and issues once it’s on · ${parseTriageConfig({}).model}`);
    expect(res.body).toMatch(/<h2 id="tool-triage">AI triage<\/h2>.*?<\/div><span class="pill neutral">Off<\/span>/s);
    // Every stat is a link for admins.
    expect(stat(res.body, 'Filed this week').href).toBe(`${w()}/tickets?status=filed`);
    expect(stat(res.body, 'Opened on GitHub this week').href).toBe(`${w()}/issues/github?show=all`);
    expect(stat(res.body, 'This month').href).toBe(`${w()}/triage/actions#limits`);
    expect(stat(res.body, 'Conflicts').href).toBe(`${w()}/contributors?result=conflict`);
    expect(res.body).not.toMatch(/style="/);
  });

  it('a moderator with only the inbox sees Discord tickets, and nothing they can’t open', async () => {
    await grant(env, wid(), mod.user.id, {});
    const res = await page('');
    expect(res.statusCode).toBe(200);
    expect(cards(res.body)).toEqual(['Discord tickets']);
    expect(buttons(res.body, 'tickets')).toEqual(['/tickets']);
    expect(res.body).not.toContain(`href="${w()}/tickets/panel"`);
    expect(res.body).not.toContain(`href="${w()}/issues`);
    expect(res.body).not.toContain(`href="${w()}/triage`);
    expect(res.body).not.toContain(`href="${w()}/contributors`);
    expect(stat(res.body, 'Need attention').href).toBe(`${w()}/tickets?status=attention`);
    expect(res.body).toContain('Your access');
    expect(res.body).toContain('From the tools you can open, newest first');
    expect(res.body).not.toMatch(/style="/);
  });

  it('View on Review adds the AI triage card; numbers link only to pages they can open', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.review': 'view' });
    const res = await page('');
    expect(cards(res.body)).toEqual(['Discord tickets', 'AI triage']);
    expect(buttons(res.body, 'triage')).toEqual(['/triage']);
    expect(stat(res.body, 'To review').href).toBe(`${w()}/triage`);
    expect(stat(res.body, 'Applied this week').href).toBeNull();
    expect(stat(res.body, 'This month').href).toBeNull();
    expect(res.body).not.toContain(`${w()}/triage/actions`);
    expect(res.body).not.toContain(`${w()}/triage/activity`);

    // A tool appears with any of its pages, and its buttons follow the pages they can open.
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view', 'issues-sync': 'edit', verifications: 'view' });
    const more = await page('');
    expect(cards(more.body)).toEqual(['Discord tickets', 'GitHub issues', 'AI triage', 'Contributor roles']);
    expect(buttons(more.body, 'issues')).toEqual(['/issues/sync']);
    expect(buttons(more.body, 'triage')).toEqual(['/triage/activity']);
    expect(buttons(more.body, 'contributors')).toEqual(['/contributors']);
    expect(stat(more.body, 'Open issues').href).toBeNull();
    expect(stat(more.body, 'Applied this week').href).toBe(`${w()}/triage/activity`);
    expect(stat(more.body, 'Verified').href).toBe(`${w()}/contributors?result=verified`);
  });

  it('shows real numbers from each tool', async () => {
    const repo = ws.repoIds[0]!;
    await ticket('Export fails', { fail: true });
    const a = await ticket('Login loops');
    const b = await ticket('Crash on start');
    await ticket('Slow sync', { queued: true });
    expect([a.status, b.status]).toEqual(['created', 'created']);

    await issue(a.issue_number!, { title: 'Login loops' }); // filed by a ticket: not "opened on GitHub"
    await issue(9001, { created: 2, author: 'lena' });
    await issue(9002, { created: 20 });
    await issue(9003, { state: 'closed', created: 40, closed: 1 });
    await issue(9004, { state: 'closed', created: 40, closed: 10 });
    await issue(9005, { repoId: 999_999, created: 1 }); // another workspace's repository
    await env.db.query(`INSERT INTO issue_index_repos (repo_id, owner, name, installation_id, status, last_synced_at) VALUES ($1, 'org', 'mobile', $2, 'ready', $3)`, [repo, ws.installationId, new Date()]);

    // Triage: one ticket waiting for review (counted this month), two applied this week, one long ago.
    await env.db.query(
      `INSERT INTO triage_results (submission_id, workspace_id, status, suggestions, suggestion_count, input_tokens, output_tokens, completed_at) VALUES ($1, $2, 'done', $3, 1, 100, 20, $4)`,
      [b.id, wid(), [spam], new Date()],
    );
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'ticket', result: 'ok', submissionId: a.id, detail: { applied: [high], suggested: [] } });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'review', result: 'ok', submissionId: b.id, by: ws.owner.user.id, detail: { applied: [spam] } });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'ticket', result: 'ok', submissionId: b.id, detail: { applied: [], suggested: [spam] } });
    await env.db.query(`INSERT INTO triage_log (workspace_id, source, result, submission_id, detail, at) VALUES ($1, 'ticket', 'ok', $2, $3, $4)`, [wid(), a.id, { applied: [high] }, new Date(Date.now() - 9 * DAY)]);

    await verified('Jordan', 'Contributor');
    await verified('Sam', 'Contributor', 10);
    await env.db.query(
      `INSERT INTO contributor_verifications (id, workspace_id, app_name, repo_owner, repo_name, discord_user_id, discord_name, result) VALUES ('c1', $1, 'All apps', '', 'org/mobile', 'd-x', 'Alex', 'conflict')`,
      [wid()],
    );

    const body = (await page('', ws.owner)).body;
    expect(stat(body, 'Filed this week').value).toBe(2);
    expect(stat(body, 'Need attention').value).toBe(1);
    expect(stat(body, 'Queued').value).toBe(1);
    expect(stat(body, 'Open issues').value).toBe(3);
    expect(stat(body, 'Opened on GitHub this week').value).toBe(1);
    expect(stat(body, 'Closed this week').value).toBe(1);
    expect(stat(body, 'To review').value).toBe(1);
    expect(stat(body, 'Applied this week').value).toBe(2);
    expect(stat(body, 'This month').value).toBe(1);
    expect(body).toContain(`<span class="of">of ${parseTriageConfig({}).monthlyLimit.toLocaleString('en-US')}</span>`);
    expect(stat(body, 'Verified').value).toBe(2);
    expect(stat(body, 'This week').value).toBe(2);
    expect(stat(body, 'Conflicts').value).toBe(1);
    // Waiting suggestions stand out, and so does what needs attention.
    expect(body).toMatch(/<div class="l">To review<\/div><div class="v accent">1/);
    expect(body).toMatch(/<div class="l">Need attention<\/div><div class="v warn">1/);
    expect(body).toMatch(/<h2 id="tool-issues">GitHub issues<\/h2><div class="desc">1 repository · synced just now<\/div><\/div><span class="pill ok">Up to date<\/span>/);
    expect(body).toMatch(/<a class="btn primary sm" href="[^"]+\/triage"/);
    expect(body).not.toMatch(/style="/);
  });

  it('says when GitHub issues stopped syncing', async () => {
    await env.db.query(`INSERT INTO issue_index_repos (repo_id, owner, name, installation_id, status, last_synced_at) VALUES ($1, 'org', 'mobile', $2, 'ready', $3)`, [ws.repoIds[0], ws.installationId, new Date(Date.now() - 2 * 3_600_000)]);
    expect((await page('', ws.owner)).body).toMatch(/<div class="desc">1 repository · synced 2 h ago<\/div><\/div><span class="pill warn">Behind<\/span>/);
  });
});

describe('Overview: Latest', () => {
  async function seed() {
    const t = await ticket('Login loops');
    await issue(9001, { title: 'Dark mode resets after update', created: 0.01, author: 'lena-dev' });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'ticket', result: 'ok', submissionId: t.id, detail: { applied: [], suggested: [high, { kind: 'duplicate', label: 'duplicate', close: true, confidence: 90, duplicateOf: 188 }] } });
    // Bulk applies stay on Activity.
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'review', result: 'ok', submissionId: t.id, by: ws.owner.user.id, detail: { applied: [spam], bulk: true } });
    await verified('Jordan', 'Contributor');
    return t;
  }

  it('admins see the newest events from every tool', async () => {
    const t = await seed();
    const body = (await page('', ws.owner)).body;
    expect(latest(body)).toEqual(expect.arrayContaining(['Login loops', 'Dark mode resets after update', 'Suggested High priority, Duplicate of #188', 'Jordan verified as Contributor']));
    expect(latest(body)).toHaveLength(4);
    expect(body).toContain('From every tool, newest first');
    expect(body).toContain(`<span class="feed-d">Discord ticket from Casey ${reporter}, filed as mobile#${t.issue_number}</span>`);
    expect(body).toContain('<span class="feed-d">opened on GitHub by @lena-dev in mobile</span>');
    expect(body).toContain(`<span class="feed-d">AI triage on mobile#${t.issue_number}</span>`);
    expect(body).toContain('<span class="feed-d">@jordan · 12 contributions</span>');
    // Each one opens where it's listed.
    expect(body).toContain(`<a class="feed-row" href="${w()}/tickets/${t.id}">`);
    expect(body).toContain(`<a class="feed-row" href="${w()}/issues/${ws.repoIds[0]}/9001">`);
    expect(body).toContain(`<a class="feed-row" href="${w()}/contributors?result=verified">`);
  });

  it('moderators only see events from pages they can open', async () => {
    await seed();
    await grant(env, wid(), mod.user.id, {});
    expect(latest((await page('')).body)).toEqual(['Login loops']);

    await grant(env, wid(), mod.user.id, { verifications: 'view', 'triage.activity': 'view' });
    const some = latest((await page('')).body);
    expect(some).toEqual(expect.arrayContaining(['Login loops', 'Suggested High priority, Duplicate of #188', 'Jordan verified as Contributor']));
    expect(some).not.toContain('Dark mode resets after update');

    // Sync alone doesn't show issues, so the issue isn't listed.
    await grant(env, wid(), mod.user.id, { 'issues-sync': 'view' });
    expect(latest((await page('')).body)).toEqual(['Login loops']);
    await grant(env, wid(), mod.user.id, { 'issues-github': 'view' });
    expect(latest((await page('')).body)).toContain('Dark mode resets after update');
  });

  it('says what will show up when nothing has happened yet', async () => {
    await grant(env, wid(), mod.user.id, { verifications: 'view' });
    expect((await page('')).body).toContain('New tickets and verifications show up here as they happen.');
    expect((await page('', ws.owner)).body).toContain('New tickets, issues opened on GitHub, triage suggestions and verifications show up here as they happen.');
  });
});

describe('Overview: moderators', () => {
  it('lists their access per tool, naming the pages when it’s only some of them', async () => {
    await grant(env, wid(), mod.user.id, { inbox: 'edit', files: 'view', 'issues': 'view', 'issues-github': 'view', 'issues-sync': 'view', apps: 'edit' });
    const body = (await page('')).body;
    expect(body).toMatch(/Discord tickets<\/span><span class="locked">.*?2 of 5 pages · 1 editable<\/span><span class="ma-pages">Inbox: edit · Files: view<\/span>/);
    expect(body).toMatch(/GitHub issues<\/span><span class="locked">.*?View<\/span><\/div>/);
    expect(body).toMatch(/Contributor roles<\/span><span class="locked">.*?No access<\/span>/);
    expect(body).toMatch(/Apps &amp; repositories<\/span><span class="locked">.*?Edit<\/span>/);

    // The inbox alone (always at least View).
    await grant(env, wid(), mod.user.id, {});
    expect((await page('')).body).toMatch(/Discord tickets<\/span><span class="locked">.*?1 of 5 pages<\/span><span class="ma-pages">Inbox: view<\/span>/);
  });

  it('get a plain “no access” page that names the page, or says it’s for admins', async () => {
    await grant(env, wid(), mod.user.id, {});
    const area = await page('/triage/prompt');
    expect(area.statusCode).toBe(403);
    expect(area.body).toContain('You don’t have access to AI triage › Prompt. Ask an admin if you need it.');
    const admins = await page('/settings');
    expect(admins.statusCode).toBe(403);
    expect(admins.body).toContain('This page is for admins. Ask an admin or the owner if you need access.');
    expect(admins.body).not.toContain('inbox');
  });
});

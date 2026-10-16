import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepos } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { parseTriageConfig, saveTriageConfig, setApiKey, setGitHubTriageEnabled, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = mod) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });

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

describe('old addresses', () => {
  it('move for good on GET and HEAD, keeping the query string', async () => {
    const cases: [string, string][] = [
      ['/tickets/triage', '/triage/actions'],
      ['/tickets/triage?x=1', '/triage/actions?x=1'],
      ['/tickets/triage/labels', '/triage/labels'],
      ['/tickets/triage/prompt/full', '/triage/prompt/full'],
      ['/tickets/triage/runs/0b7e5d2c-1111-4222-8333-444455556666?show=changed', '/triage/runs/0b7e5d2c-1111-4222-8333-444455556666?show=changed'],
      ['/tickets/triage/activity?source=review', '/triage/activity?source=review'],
      ['/tickets/triage/bulk/status', '/triage/bulk/status'],
      ['/tickets/issues', '/issues'],
      ['/tickets/issues?state=closed&q=crash', '/issues?state=closed&q=crash'],
      ['/tickets/issues/triage?show=all', '/issues/github?show=all'],
      ['/tickets/issues/sync', '/issues/sync'],
      ['/tickets/issues/123/45', '/issues/123/45'],
      ['/tickets/triage/', '/triage/actions'],
      ['/tickets/issues/', '/issues'],
    ];
    for (const [from, to] of cases) {
      const res = await page(from, ws.owner);
      expect(res.statusCode, from).toBe(301);
      expect(res.headers.location, from).toBe(w() + to);
    }
    const head = await env.server.inject({ method: 'HEAD', url: `${w()}/tickets/issues/triage`, ...get(ws.owner) });
    expect(head.statusCode).toBe(301);
    expect(head.headers.location).toBe(`${w()}/issues/github`);
    // The new pages are there.
    for (const url of ['/triage', '/triage/actions', '/issues', '/issues/github', '/issues/sync']) expect((await page(url, ws.owner)).statusCode, url).toBe(200);
  });

  it('send forms on with 307, so the body is posted again to the new address', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    const cases: [string, string][] = [
      ['/tickets/triage', '/triage/actions'],
      ['/tickets/triage/enabled', '/triage/enabled'],
      ['/tickets/triage/runs/abc/apply', '/triage/runs/abc/apply'],
      ['/tickets/issues/sync', '/issues/sync'],
      ['/tickets/issues/123/45/triage/apply', '/issues/123/45/triage/apply'],
    ];
    for (const [from, to] of cases) {
      const res = await env.server.inject({ method: 'POST', url: `${w()}${from}`, ...form(ws.owner, { set: '1', enabled: '1' }) });
      expect(res.statusCode, from).toBe(307);
      expect(res.headers.location, from).toBe(w() + to);
    }
    // Following it does what the old address did.
    const moved = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/enabled`, ...form(ws.owner, { set: '1', enabled: '1' }) });
    const res = await env.server.inject({ method: 'POST', url: moved.headers.location as string, ...form(ws.owner, { set: '1', enabled: '1' }) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${w()}/triage/actions`);
    expect((await env.db.query('SELECT enabled FROM triage_settings WHERE workspace_id = $1', [wid()])).rows[0].enabled).toBe(true);
    // A form without its token is still refused first.
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/enabled`, headers: get(ws.owner).headers, payload: {} })).statusCode).toBe(403);
  });

  it('stay inside the workspace, whatever the rest of the address is', async () => {
    const res = await page('/tickets/triage/%2F%2Fexample.com', ws.owner);
    expect(res.statusCode).toBe(301);
    expect(res.headers.location?.startsWith(`${w()}/triage/`)).toBe(true);
  });
});

describe('sidebar', () => {
  it('groups pages into Setup, Tools and Workspace, and highlights the tool of the page', async () => {
    const overview = (await page('', ws.owner)).body;
    const labels = [...overview.matchAll(/<div class="nav-label">([^<]+)<\/div>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Setup', 'Tools', 'Workspace']);
    const tools = [...overview.matchAll(/class="nav-item"[^>]*>.*?<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(tools).toEqual(['Overview', 'GitHub', 'Discord', 'Apps &amp; repositories', 'Discord tickets', 'GitHub issues', 'AI triage', 'Contributor roles', 'Members &amp; permissions', 'Settings', 'Deployment', 'Server health']);
    const active: [string, string][] = [
      ['/tickets', '/tickets'], ['/tickets/files', '/tickets'], ['/tickets/settings', '/tickets'],
      ['/issues/sync', '/issues'], ['/issues/github', '/issues'],
      ['/triage', '/triage'], ['/triage/labels', '/triage'], ['/triage/prompt/full', '/triage'], ['/triage/activity', '/triage'],
      ['/contributors/roles', '/contributors'], ['/apps', '/apps'], ['/members', '/members'],
    ];
    for (const [url, item] of active) {
      const body = (await page(url, ws.owner)).body;
      expect(body, url).toContain(`href="${w()}${item}" class="nav-item" aria-current="page"`);
      expect(body.match(/aria-current="page"/g)?.length, url).toBeGreaterThanOrEqual(1);
      expect(body.match(/class="nav-item" aria-current="page"/g), url).toHaveLength(1);
    }
  });

  it('opens each tool on the first page the person can see, and locks tools they can’t', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view', 'issues-sync': 'view' });
    const body = (await page('/tickets')).body;
    expect(body).toContain(`href="${w()}/tickets" class="nav-item" aria-current="page"`);
    expect(body).toContain(`href="${w()}/issues/sync" class="nav-item"`);
    expect(body).toContain(`href="${w()}/triage/activity" class="nav-item"`);
    expect(body).toContain('<span class="nav-item locked" aria-disabled="true" title="You don’t have access to Contributor roles. Ask an admin if you need it.">');
    expect(body).toContain('title="Only admins can open Members &amp; permissions. Ask an admin if you need access."');

    // A tool's own address lands on that page too.
    for (const [url, to] of [['/triage', '/triage/activity'], ['/issues', '/issues/sync']]) {
      const res = await page(url!);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(w() + to);
    }
    expect((await page('/contributors')).statusCode).toBe(403);
    expect((await page('/triage/actions')).statusCode).toBe(403);
  });
});

describe('tool headers', () => {
  it('show every page as a tab, locked when the person can’t open it, and say View only', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view', 'triage.prompt': 'view', files: 'edit' });
    const activity = (await page('/triage/activity')).body;
    expect(activity).toContain('<h1>AI triage</h1>');
    expect(activity).toContain('<nav class="tabs" aria-label="AI triage">');
    for (const name of ['Review', 'Actions', 'Label groups', 'Re-run']) {
      expect(activity, name).toContain(`<span class="tab locked" aria-disabled="true" title="You don’t have access to ${name}. Ask an admin if you need it.">`);
    }
    expect(activity).toContain(`<a class="tab" href="${w()}/triage/prompt" >Prompt</a>`);
    expect(activity).toContain(`<a class="tab" href="${w()}/triage/activity" aria-current="page">Activity</a>`);
    // Activity is a log, so there's nothing to change: no View only tag.
    expect(activity).not.toContain('View only');
    expect((await page('/triage/prompt')).body).toContain('<span class="tag" title="You can see the prompt. Ask an admin if you need to change it.">');

    const inbox = (await page('/tickets')).body;
    expect(inbox).toContain('<h1>Discord tickets</h1>');
    expect(inbox).toContain('Members open tickets from #tickets in Discord. Each one is filed as a GitHub issue in the app’s repository.');
    expect(inbox).toContain('title="You can read tickets.');
    expect(inbox).toContain('<span class="tab locked" aria-disabled="true" title="You don’t have access to Panel. Ask an admin if you need it.">');
    expect(inbox).toContain(`<a class="tab" href="${w()}/tickets/files" >Files</a>`);
    // Files: Edit, so no tag, and Scan for cleanup is there.
    const files = (await page('/tickets/files')).body;
    expect(files).not.toContain('title="You can see the stored files.');
    expect(files).toContain('Scan for cleanup');

    // Owners and admins never see locked tabs or View only.
    for (const url of ['/tickets', '/issues', '/triage', '/contributors']) {
      const body = (await page(url, ws.owner)).body;
      expect(body, url).not.toContain('tab locked');
      expect(body, url).not.toContain('View only');
    }
    const issues = (await page('/issues', ws.owner)).body;
    expect(issues).toContain('<h1>GitHub issues</h1>');
    expect(issues).toContain('Every issue in your connected repositories, open and closed, wherever it was opened.');
    expect(issues).toContain('1 repository');
    const contributors = (await page('/contributors', ws.owner)).body;
    expect(contributors).toContain('<h1>Contributor roles</h1>');
    expect(contributors).toContain(`<a class="tab" href="${w()}/contributors/panel" >Panel</a>`);
  });
});

describe('Contributor roles › Verifications', () => {
  it('View shows the list; Edit lets moderators revoke roles', async () => {
    await env.db.query(
      `INSERT INTO contributor_verifications (id, workspace_id, app_name, repo_owner, repo_name, discord_user_id, discord_name, github_user_id, github_login, result)
       VALUES ('v1', $1, 'Mobile App', 'org', 'mobile', '555', 'Casey', 42, 'casey', 'verified')`,
      [wid()],
    );
    const view = (await page('/contributors')).body;
    expect(view).toContain('Casey');
    expect(view).toContain('title="You can see verifications. Ask an admin if you need to revoke roles."');
    expect(view).not.toContain('/revoke');
    expect((await env.server.inject({ method: 'POST', url: `${w()}/contributors/verifications/v1/revoke`, ...form(mod) })).statusCode).toBe(403);

    await grant(env, wid(), mod.user.id, { verifications: 'edit' });
    const edit = (await page('/contributors')).body;
    expect(edit).not.toContain('View only');
    expect(edit).toContain(`${w()}/contributors/verifications/v1/revoke`);
    expect((await env.server.inject({ method: 'POST', url: `${w()}/contributors/verifications/v1/revoke`, ...form(mod) })).statusCode).toBe(302);
    expect((await env.db.query(`SELECT revoked_by FROM contributor_verifications WHERE id = 'v1'`)).rows[0].revoked_by).toBe(mod.user.id);
  });
});

describe('AI triage › Review', () => {
  async function suggestions() {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ spam: { mode: 'suggest' }, githubModes: { spam: 'suggest' } }));
    await setTriageEnabled(env.db, wid(), true);
    await setGitHubTriageEnabled(env.db, wid(), true);
    await new Promise((r) => setTimeout(r, 5));
    const r = await acceptSubmission(env.deps, {
      workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: 'int-rv1', interactionToken: null,
      guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: 'r1', displayName: 'Casey', username: 'casey' },
      title: 'Buy followers', description: 'Cheap followers here, click.', ticketType: null,
    });
    if (r.kind !== 'accepted') throw new Error(r.kind);
    await env.worker.drain();
    env.github.repos.get(ws.repoIds[0]!)!.issues.push({ number: 700, title: 'Win a prize', body: 'Click here.', labels: [], created_at: new Date().toISOString(), user: 'someone' });
    await ensureRepos(env.db);
    await env.triage.engine.indexer.sync(ws.repoIds[0]!, { pages: 5, fullCheck: false });
    env.anthropic.queue.push({ ...env.anthropic.verdict, spam: true, spam_confidence: 85 }, { ...env.anthropic.verdict, spam: true, spam_confidence: 70 });
    await env.triage.drain();
    return r.submission;
  }

  it('lists every ticket and issue with suggestions waiting, and counts them in the sidebar', async () => {
    const ticket = await suggestions();
    const res = await page('/triage', ws.owner);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>AI triage</h1>');
    expect(res.body).toContain('<div class="page full">');
    expect(res.body).toContain(`<a class="rv-title" href="${w()}/tickets/${ticket.id}" >Buy followers</a>`);
    expect(res.body).toContain('Discord ticket');
    expect(res.body).toContain(`href="${w()}/issues/${ws.repoIds[0]}/700"`);
    expect(res.body).toContain('Win a prize');
    expect(res.body).toContain('Opened on GitHub');
    expect(res.body).toContain('Spam');
    expect(res.body).toContain('85%');
    expect(res.body).toContain('All sources<span class="n">2</span>');
    expect(res.body).not.toMatch(/style="/);
    // The sidebar and the Review tab count them.
    expect(res.body).toContain('<span class="badge accent" title="2 to review">2</span>');
    expect(res.body).toContain(`aria-current="page">Review<span class="badge accent">2</span></a>`);

    // A moderator who can't see Review doesn't get the count.
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view' });
    expect((await page('/tickets')).body).not.toContain('badge accent');
    // With View on Review: the list, and View only.
    await grant(env, wid(), mod.user.id, { 'triage.review': 'view' });
    const view = await page('/triage');
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('<span class="tag" title="You can see the suggestions. Applying and dismissing them needs Edit on Review.');
    expect(view.body).not.toContain('/triage/apply"');
    // Without a GitHub issues page, the issue opens on GitHub.
    expect(view.body).not.toContain(`href="${w()}/issues/${ws.repoIds[0]}/700"`);
    expect(view.body).toContain('target="_blank"');
  });

  it('says when there is nothing to review', async () => {
    const res = await page('/triage', ws.owner);
    expect(res.body).toContain('Nothing to review');
    expect(res.body).toContain('AI triage is off.');
    expect(res.body).not.toContain('badge accent');
  });
});

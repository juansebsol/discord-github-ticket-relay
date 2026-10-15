import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepos } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { getTriageSettings, monthlyUsage, parseTriageConfig, saveTriageConfig, setApiKey, setGitHubTriageEnabled, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
let nextNumber = 900;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const result = async (num: number) => (await env.db.query('SELECT * FROM issue_triage WHERE workspace_id = $1 AND repo_id = $2 AND number = $3', [wid(), ws.repoIds[0], num])).rows[0];
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

/** An issue someone opens directly on GitHub. */
function openOnGitHub(title: string, o: { user?: string; body?: string; created?: string } = {}): number {
  const number = nextNumber++;
  repo().issues.push({ number, title, body: o.body ?? `${title}. It happens every time I try.`, labels: [], created_at: o.created ?? new Date().toISOString(), user: o.user ?? 'someone' });
  return number;
}

/** What the issue sync does every couple of minutes. */
async function syncIssues() {
  await ensureRepos(env.db);
  await env.triage.engine.indexer.sync(ws.repoIds[0]!, { pages: 5, fullCheck: false });
}

async function enableGitHub(config: Record<string, unknown>, o: { tickets?: boolean } = {}) {
  await new Promise((r) => setTimeout(r, 5));
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig(config));
  if (o.tickets) await setTriageEnabled(env.db, wid(), true);
  await setGitHubTriageEnabled(env.db, wid(), true);
  await new Promise((r) => setTimeout(r, 5));
}

async function fileTicket(title = 'Export crashes the app') {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-g${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `Click export and the app closes (${n}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

async function joinAs(role: 'moderator', name: string): Promise<Admin> {
  const person = await makeAdmin(env, name);
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, role)}`, ...form(person) });
  return person;
}

describe('triage of issues opened on GitHub', () => {
  it('triages new issues with their own modes, separate from Discord tickets', async () => {
    // Priority is off for Discord tickets and automatic for GitHub issues.
    await enableGitHub({ priority: { mode: 'off' }, githubModes: { priority: 'auto' } }, { tickets: true });
    const num = openOnGitHub('Login fails on Windows');
    await syncIssues();
    env.anthropic.queue.push({ ...env.anthropic.verdict, priority: 'high', priority_confidence: 96 });
    await env.triage.drain();
    expect(issue(num).labels).toEqual(['priority: high']);
    expect(await result(num)).toMatchObject({ status: 'done', priority: 'high', suggestion_count: 0 });
    // Claude got the issue as data, with the app from its repository.
    expect(env.anthropic.requests.at(-1)!.body.messages[0].content).toContain('"title": "Login fails on Windows"');
    expect(env.anthropic.requests.at(-1)!.body.messages[0].content).toContain(`"app": "${ws.apps[0]!.name}"`);
    const events = (await env.db.query('SELECT kind FROM issue_triage_events')).rows.map((r) => r.kind);
    expect(events).toEqual(['triage_done']);

    // A Discord ticket uses the ticket modes: priority is off there, so nothing is triaged.
    const t = await fileTicket();
    const calls = env.anthropic.requests.length;
    await env.triage.drain();
    expect(env.anthropic.requests.length).toBe(calls);
    expect((await env.db.query('SELECT status, skip_reason FROM triage_results WHERE submission_id = $1', [t.id])).rows[0]).toMatchObject({ status: 'skipped' });
    expect(await result(t.issue_number)).toBeUndefined();
    expect((await monthlyUsage(env.db, wid())).triaged).toBe(1);
  });

  it('leaves out issues opened before it was on, issues opened by bots, and tickets from Discord', async () => {
    const old = openOnGitHub('Old problem', { created: ago(3600_000) });
    await enableGitHub({ githubModes: { spam: 'suggest' } });
    const bot = openOnGitHub('Bump dependency', { user: 'dependabot[bot]' });
    const t = await fileTicket('Sync is slow');
    await syncIssues();
    await env.triage.drain();
    expect(await result(old)).toBeUndefined();
    expect(await result(t.issue_number)).toBeUndefined();
    expect(await result(bot)).toMatchObject({ status: 'skipped', skip_reason: 'Opened by a bot' });
    expect(env.anthropic.requests).toHaveLength(0);
  });

  it('does nothing while its switch is off, even with actions on for GitHub issues', async () => {
    await enableGitHub({ githubModes: { priority: 'auto' } });
    await setGitHubTriageEnabled(env.db, wid(), false);
    openOnGitHub('Login fails');
    await syncIssues();
    await env.triage.drain();
    expect(env.anthropic.requests).toHaveLength(0);
    expect((await env.db.query('SELECT count(*) AS n FROM issue_triage')).rows[0].n).toBe(0);
  });

  it('shows suggestions on the issue page, where people who can act apply or dismiss them', async () => {
    await enableGitHub({ githubModes: { priority: 'suggest', spam: 'suggest' } });
    const num = openOnGitHub('Buy followers cheap');
    await syncIssues();
    env.anthropic.queue.push({ ...env.anthropic.verdict, spam: true, spam_confidence: 70 });
    await env.triage.drain();
    expect(issue(num).labels).toEqual([]);

    const list = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues/triage`, ...get(ws.owner) });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(`/tickets/issues/${ws.repoIds[0]}/${num}`);
    expect(list.body).toContain('To review');

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues/${ws.repoIds[0]}/${num}`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Buy followers cheap');
    expect(page.body).toContain('What Apply does');
    expect(page.body).toContain(`/tickets/issues/${ws.repoIds[0]}/${num}/triage/apply`);

    const mod = await joinAs('moderator', 'mia');
    const denied = await env.server.inject({ method: 'POST', url: `${w()}/tickets/issues/${ws.repoIds[0]}/${num}/triage/apply`, ...form(mod, { kind: 'spam' }) });
    expect(denied.statusCode).toBe(403);

    await env.server.inject({ method: 'POST', url: `${w()}/tickets/issues/${ws.repoIds[0]}/${num}/triage/apply`, ...form(ws.owner, { kind: 'spam' }) });
    expect(issue(num).labels).toEqual(['spam']);
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/issues/${ws.repoIds[0]}/${num}/triage/dismiss`, ...form(ws.owner, { kind: 'priority' }) });
    expect(await result(num)).toMatchObject({ suggestion_count: 0 });
    const kinds = (await env.db.query('SELECT kind FROM issue_triage_events ORDER BY id')).rows.map((r) => r.kind);
    expect(kinds).toEqual(['triage_done', 'triage_applied', 'triage_dismissed']);

    // An issue that's a Discord ticket goes to its ticket page.
    const t = await fileTicket();
    const redirect = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues/${ws.repoIds[0]}/${t.issue_number}`, ...get(ws.owner) });
    expect(redirect.headers.location).toBe(`${w()}/tickets/${t.id}`);
  });
});

describe('settings for issues opened on GitHub', () => {
  const base = { model: 'claude-haiku-5-5', threshold: '90', monthly_limit: '500', priority_label_critical: 'a', priority_label_high: 'b', priority_label_medium: 'c', priority_label_low: 'd' };

  it('saves each action’s GitHub mode separately, and keeps it when the form leaves it out', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await env.server.inject({
      method: 'POST', url: `${w()}/tickets/triage`,
      ...form(ws.owner, { ...base, app_ids: ws.apps[0]!.id, priority_mode: 'auto', priority_gh_mode: 'suggest', duplicate_mode: 'off', duplicate_gh_mode: 'auto', duplicate_label: 'duplicate' }),
    });
    let c = (await getTriageSettings(env.db, wid())).config;
    expect(c.priority.mode).toBe('auto');
    expect(c.duplicate.mode).toBe('off');
    expect(c.githubModes).toMatchObject({ priority: 'suggest', duplicate: 'auto', spam: 'off' });

    await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage`, ...form(ws.owner, { ...base, app_ids: ws.apps[0]!.id, priority_mode: 'auto', duplicate_label: 'duplicate' }) });
    c = (await getTriageSettings(env.db, wid())).config;
    expect(c.githubModes).toMatchObject({ priority: 'suggest', duplicate: 'auto' });

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage`, ...get(ws.owner) });
    expect(page.body).toContain('name="priority_gh_mode"');
    expect(page.body).toContain('Issues opened on GitHub');
    expect(page.body).toContain('Copy Discord settings to GitHub');
  });

  it('needs a key to switch on, and starts from now', async () => {
    const toggle = (enabled: boolean) => env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/github-enabled`, ...form(ws.owner, enabled ? { set: '1', enabled: '1' } : { set: '1' }), headers: { ...form(ws.owner).headers, accept: 'application/json' } });
    expect((await toggle(true)).json()).toMatchObject({ ok: false });
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    expect((await toggle(true)).json()).toMatchObject({ ok: true });
    const s = await getTriageSettings(env.db, wid());
    expect(s.githubEnabled).toBe(true);
    expect(s.githubEnabledAt).toBeInstanceOf(Date);
    expect(s.enabled).toBe(false); // Discord tickets have their own switch
    // The Issues tab now opens on the GitHub triage view.
    const inbox = await env.server.inject({ method: 'GET', url: `${w()}/tickets`, ...get(ws.owner) });
    expect(inbox.body).toContain(`href="${w()}/tickets/issues/triage"`);
  });
});

describe('re-runs with GitHub issues', () => {
  it('can pick Discord tickets, issues opened on GitHub, or both', async () => {
    const t = await fileTicket('Login fails');
    const gh = openOnGitHub('Dark mode resets', { created: ago(60_000) });
    await enableGitHub({ priority: { mode: 'suggest' }, githubModes: { priority: 'suggest' } }, { tickets: true });
    await syncIssues();
    await env.triage.drain(); // both were opened before triage was on: nothing happens
    expect(env.anthropic.requests).toHaveLength(0);

    const start = (source: string) => env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { source, never: '1', untouched: '1', count: 'all', mode: 'preview' }) });
    const subjects = async () => (await env.db.query('SELECT subject FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id ORDER BY r.created_at DESC, i.position')).rows.map((r) => r.subject);

    const est = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/estimate?source=github&untouched=1&never=1&count=all`, ...get(ws.owner) });
    expect(est.json()).toMatchObject({ allLabel: 'All matching (1)', never: 'Never triaged (1)' });

    const gRun = await start('github');
    expect(await subjects()).toEqual([`gh:${ws.repoIds[0]}:${gh}`]);
    await env.triage.drain();
    const page = await env.server.inject({ method: 'GET', url: gRun.headers.location as string, ...get(ws.owner) });
    expect(page.body).toContain(`/tickets/issues/${ws.repoIds[0]}/${gh}`);
    expect(page.body).toContain('opened on GitHub');

    // Updating the inbox only: the GitHub issue gets its suggestions in Issues › Triage.
    await env.server.inject({ method: 'POST', url: `${gRun.headers.location}/apply`, ...form(ws.owner, { scope: 'filter', show: 'all', include: 'inbox' }) });
    await env.triage.drain();
    expect(await result(gh)).toMatchObject({ status: 'done', suggestion_count: 1, applied_actions: [] });
    expect(issue(gh).labels).toEqual([]);

    // Both kinds in one run (the GitHub issue now has suggestions: still nothing applied).
    await start('all');
    const both = await subjects();
    expect(both.slice(0, 2).sort()).toEqual([`gh:${ws.repoIds[0]}:${gh}`, `sub:${t.id}`].sort());
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IssueIndexer, setDuplicateOf } from '../src/domain/issue-index.js';
import { mentionedIssues, releaseOf } from '../src/domain/pull-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { getTriageSettings, parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, makeApp, makeWorkspace, resetDb, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

/**
 * Pull requests: kept from the issue sync, compared with tickets by AI triage (Being worked on,
 * Already fixed), and listed in Repo status › Pull requests.
 */

const KEY = 'sk-ant-test-key-0123456789abcdef';
let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const result = async (id: string) => (await env.db.query('SELECT * FROM triage_results WHERE submission_id = $1', [id])).rows[0];
const lastSystem = () => env.anthropic.requests.at(-1)!.body.system[0].text as string;
const lastUser = () => env.anthropic.requests.at(-1)!.body.messages[0].content as string;
const pulls = async () => (await env.db.query('SELECT * FROM pull_index WHERE repo_id = $1 ORDER BY number', [repo().id])).rows;
const sync = async () => {
  await env.db.query('UPDATE issue_index_repos SET sync_requested_at = now_ms()');
  await new IssueIndexer(env.deps).tick();
};

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'PhotoCraft', repoIndex: 0 }] });
});
afterAll(async () => {
  await testDb().end();
});

async function file(title: string, description: string) {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-pr${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `${description} (${n})`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

async function enable(config: Record<string, unknown>) {
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig(config));
  await setTriageEnabled(env.db, wid(), true);
}

/** The issue #3592 asked for it, PR #3597 builds it; #3601 fixed a crash after the latest release; #3500 before it. */
function seed() {
  const r = repo();
  r.issues.push({ number: 3592, title: 'Free Transform across several selected layers', body: 'Let me transform several layers at once.', labels: ['enhancement'], created_at: ago(30), user: 'someone' });
  r.issues.push({ number: 3590, title: 'Crash when exporting a spread to PDF', body: 'The app closes.', labels: ['bug'], created_at: ago(40), user: 'someone', state: 'closed', state_reason: 'completed', closed_at: ago(2) });
  r.pulls = [
    { number: 3597, title: 'Free Transform for several layers', body: 'Implements the request in #3592.', user: 'FredApps', created_at: ago(5), updated_at: ago(2) },
    { number: 3598, title: 'WIP: faster brush engine', body: 'Not ready.', user: 'ana', created_at: ago(3), updated_at: ago(1), draft: true },
    { number: 3601, title: 'Fix the crash when exporting spreads to PDF', body: 'Fixes #3590', user: 'ben', created_at: ago(4), merged_at: ago(2), updated_at: ago(2) },
    { number: 3500, title: 'Fix ruler units in preferences', body: 'Closes #3400', user: 'cy', created_at: ago(20), merged_at: ago(15), updated_at: ago(15) },
    { number: 3599, title: 'Bump lodash from 4.17.20 to 4.17.21', body: '', user: 'dependabot[bot]', created_at: ago(2), updated_at: ago(2) },
    { number: 3200, title: 'Old merged change', body: '', user: 'cy', created_at: ago(200), merged_at: ago(150), updated_at: ago(150) },
  ];
  r.releases = [{ tag: 'v1.4.3', published_at: ago(10) }, { tag: 'v1.4.2', published_at: ago(30) }];
}

describe('Pull requests: kept from the issue sync', () => {
  it('keeps open and recently merged pull requests, what they’re for, and the releases', async () => {
    seed();
    await sync();
    const got = await pulls();
    expect(got.map((p) => p.number)).toEqual([3500, 3597, 3598, 3599, 3601]);
    const p = Object.fromEntries(got.map((x) => [x.number, x]));
    expect(p[3597]).toMatchObject({ state: 'open', draft: false, author: 'FredApps', closes: [], mentions: [3592], noise: null });
    expect(p[3598]).toMatchObject({ draft: true });
    expect(p[3601]).toMatchObject({ state: 'closed', closes: [3590], merged_at: expect.any(Date) });
    expect(p[3599]!.noise).toBe('Bot');
    // The issues stay issues only.
    const issues = (await env.db.query('SELECT number FROM issue_index WHERE repo_id = $1', [repo().id])).rows.map((r) => r.number);
    expect(issues).not.toContain(3597);
    const releases = JSON.parse((await env.db.query('SELECT releases FROM issue_index_repos WHERE repo_id = $1', [repo().id])).rows[0].releases);
    expect(releases.map((x: { tag: string }) => x.tag)).toEqual(['v1.4.3', 'v1.4.2']);
  });

  it('reads a repository’s pull requests once when it was indexed before they were kept', async () => {
    await sync();
    seed();
    // As if indexed before: the regular sync only sees what changed since.
    await env.db.query('UPDATE issue_index_repos SET pulls_loaded_at = NULL, synced_until = $2 WHERE repo_id = $1', [repo().id, Date.now()]);
    await env.db.query('DELETE FROM pull_index');
    repo().pulls!.find((x) => x.number === 3597)!.updated_at = ago(40);
    await sync();
    expect((await pulls()).map((p) => p.number)).toContain(3597);
    expect((await env.db.query('SELECT pulls_loaded_at FROM issue_index_repos WHERE repo_id = $1', [repo().id])).rows[0].pulls_loaded_at).toBeInstanceOf(Date);
  });

  it('reads which issues a pull request names, and which release shipped a fix', () => {
    expect(mentionedIssues('Free Transform for several layers\nImplements #3592, see also owner/repo#9 and x.com/a#5', 3597, [])).toEqual([3592]);
    const releases = [{ tag: 'v3', at: '2026-10-15T00:00:00Z' }, { tag: 'v2', at: '2026-10-12T00:00:00Z' }];
    expect(releaseOf(new Date('2026-10-10'), releases)?.tag).toBe('v2');
    expect(releaseOf(new Date('2026-10-16'), releases)).toBeNull();
  });
});

describe('AI triage: Being worked on and Already fixed', () => {
  it('is off until turned on: Claude isn’t shown pull requests', async () => {
    seed();
    await sync();
    await enable({ duplicate: { mode: 'suggest' } });
    await file('Free transform on many layers', 'I want to transform several layers at once.');
    await env.triage.drain();
    expect(lastUser()).not.toContain('Pull requests and commits');
    expect(lastSystem()).not.toContain('in_progress:');
    expect(JSON.stringify(env.anthropic.requests.at(-1)!.body.output_config)).not.toContain('in_progress');
  });

  it('a duplicate whose issue a pull request is for: labels both and says which pull request', async () => {
    seed();
    await sync();
    await enable({ duplicate: { mode: 'auto' }, inProgress: { mode: 'auto' }, fixed: { mode: 'suggest' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, duplicates: [{ number: 3592, confidence: 95 }], in_progress: '#3597', in_progress_confidence: 93 });
    const t = await file('Free transform on many layers', 'I want to transform several selected layers at once.');
    await env.triage.drain();
    // Claude saw the pull request, with the issue it's for, and was told the rules.
    expect(lastUser()).toContain('"ref": "#3597"');
    expect(lastUser()).toContain('"for": [\n      3592\n    ]');
    expect(lastUser()).not.toContain('#3599');
    expect(lastSystem()).toContain('in_progress: the ref');
    const i = issue(t.issue_number);
    expect(i.labels.sort()).toEqual(['duplicate', 'in progress']);
    expect(i.comments?.[0]).toContain('Possible duplicate of #3592.');
    expect(i.comments?.[0]).toContain('This is being worked on in #3597.');
    expect((await result(t.id)).verdict.in_progress_work).toMatchObject({ ref: '#3597', kind: 'pull', number: 3597 });
    // The ticket page says so.
    const page = (await env.server.inject({ method: 'GET', url: `${w()}/tickets/${t.id}`, ...get(ws.owner) })).body;
    expect(page).toContain('Being worked on in <a href="https://github.com/');
  });

  it('a fix merged after the latest release: “it will be in the next release”, and no asking for details', async () => {
    seed();
    await sync();
    await enable({ fixed: { mode: 'auto' }, needsInfo: { mode: 'auto' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, fixed_by: '#3601', fixed_confidence: 94, needs_info: true, needs_info_confidence: 95, missing: ['steps'], duplicates: [{ number: 3590, confidence: 90 }] });
    const t = await file('PDF export of a spread crashes', 'The app closes when I export a spread to PDF.');
    await env.triage.drain();
    const i = issue(t.issue_number);
    expect(i.labels).toEqual(['fixed']);
    expect(i.comments?.[0]).toBe('This was already fixed in #3601: it will be in the next release.');
    expect(lastUser()).toContain('"release": "not released yet"');
  });

  it('a fix in a release names it; Claude can only pick what it was shown, in the right state', async () => {
    seed();
    repo().issues.push({ number: 3400, title: 'Ruler units reset after restart', body: 'Units go back to inches.', labels: ['bug'], created_at: ago(30), user: 'someone', state: 'closed', state_reason: 'completed', closed_at: ago(15) });
    await sync();
    await enable({ fixed: { mode: 'auto' }, inProgress: { mode: 'auto' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, fixed_by: '3500', fixed_confidence: 92, duplicates: [{ number: 3400, confidence: 90 }] });
    const t = await file('Ruler units reset after restart', 'Units go back to inches after restarting.');
    await env.triage.drain();
    expect(issue(t.issue_number).comments?.[0]).toBe('This was already fixed in #3500: it’s in v1.4.3.');
    // An open pull request isn't a fix, a merged one isn't in progress, and one it wasn't shown is nothing.
    env.anthropic.queue.push({ ...env.anthropic.verdict, fixed_by: '#3597', fixed_confidence: 95, in_progress: '#3601', in_progress_confidence: 95 });
    const u = await file('Free transform on many layers', 'I want to transform several layers.');
    await env.triage.drain();
    env.anthropic.queue.push({ ...env.anthropic.verdict, in_progress: '#9999', in_progress_confidence: 95 });
    const v = await file('Something else entirely', 'Unrelated.');
    await env.triage.drain();
    for (const x of [u, v]) {
      expect(issue(x.issue_number).labels).toEqual([]);
      expect((await result(x.id)).verdict).toMatchObject({ in_progress: null, fixed_by: null });
    }
  });

  it('a regression is never “already fixed”', async () => {
    seed();
    await sync();
    await enable({ fixed: { mode: 'auto' }, regression: { mode: 'auto' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, regression_of: 3590, regression_confidence: 95, fixed_by: '#3601', fixed_confidence: 95, duplicates: [{ number: 3590, confidence: 90 }] });
    const t = await file('PDF export still crashes after updating', 'Still closes on export in the latest build.');
    await env.triage.drain();
    expect(issue(t.issue_number).labels).toEqual(['regression']);
  });

  it('is on the Actions page, off, with its placeholders', async () => {
    const body = (await env.server.inject({ method: 'GET', url: `${w()}/triage/actions`, ...get(ws.owner) })).body;
    expect(body).toContain('Being worked on');
    expect(body).toContain('Already fixed');
    expect(body).toContain('{fix}, {release}, {app}');
    expect((await getTriageSettings(env.db, wid())).config).toMatchObject({ inProgress: { mode: 'off', label: 'in progress' }, fixed: { mode: 'off', label: 'fixed' } });
    // Saving turns it on, with its own label and comment.
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    const res = await env.server.inject({
      method: 'POST', url: `${w()}/triage/actions`,
      ...form(ws.owner, {
        model: 'claude-haiku-5-5', threshold: '90', monthly_limit: '500', priority_label_critical: 'a', priority_label_high: 'b', priority_label_medium: 'c', priority_label_low: 'd',
        app_ids: ws.apps[0]!.id, inProgress_mode: 'suggest', inProgress_label: 'wip', inProgress_comment: 'Someone is on it: {pull}.', fixed_mode: 'off',
      }),
    });
    expect(res.statusCode).toBe(302);
    expect((await getTriageSettings(env.db, wid())).config.inProgress).toMatchObject({ mode: 'suggest', label: 'wip', comment: 'Someone is on it: {pull}.', close: false });
  });
});

describe('Repo status › Pull requests', () => {
  async function turnOn() {
    expect((await env.server.inject({ method: 'POST', url: `${w()}/repos/settings`, ...form(ws.owner, { enabled: '1', keep: '1' }) })).statusCode).toBe(302);
  }

  it('lists open ones (most reported first), merged ones waiting for a release, and merged ones', async () => {
    seed();
    await sync();
    // Two Discord tickets about #3592: its own, and a duplicate.
    const a = await file('Free transform for several layers please', 'Several layers at once.');
    const b = await file('Transform multiple layers', 'Select many layers and transform them.');
    await sync();
    await setDuplicateOf(env.db, repo().id, a.issue_number, 3592);
    await setDuplicateOf(env.db, repo().id, b.issue_number, 3592);
    await turnOn();
    const page = (url: string) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(ws.owner) }).then((r) => r.body);
    const open = await page('/repos?view=pulls');
    expect(open).toMatch(/Pull requests<span class="n">2<\/span>/);
    expect(open).toContain('Free Transform for several layers');
    expect(open).toContain('Draft');
    expect(open).not.toContain('Bump lodash');
    expect(open).toMatch(/For<\/span> <a href="[^"]+\/issues\/3592"[^>]*>#3592<\/a> <span class="rs-pr-it">Free Transform across several selected layers<\/span>/);
    expect(open).toContain('2 Discord reports</span>');
    expect(open.indexOf('Free Transform for several layers')).toBeLessThan(open.indexOf('faster brush engine'));
    const waiting = await page('/repos?view=pulls&list=waiting');
    expect(waiting).toContain('Fix the crash when exporting spreads to PDF');
    expect(waiting).toContain('not released yet');
    expect(waiting).not.toContain('Fix ruler units');
    const merged = await page('/repos?view=pulls&list=merged');
    expect(merged).toContain('Fix ruler units in preferences');
    expect(merged).toContain('in <span class="mono">v1.4.3</span>');
    // Most reported shows that someone's on it.
    expect(await page('/repos?view=reported')).toContain('Open PR #3597');
  });
});

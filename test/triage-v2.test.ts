import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IssueIndexer } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { DEFAULT_CHECK_RULES } from '../src/triage/prompt.js';
import { getTriageSettings, LABEL_GROUP_PRESETS, monthlyUsage, parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, makeApp, makeWorkspace, resetDb, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  // Two apps in two repositories.
  ws = await makeWorkspace(env, { apps: [{ name: 'PhotoCraft', repoIndex: 0 }, { name: 'VectorCraft', repoIndex: 1 }] });
});
afterAll(async () => {
  await testDb().end();
});

const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const result = async (id: string) => (await env.db.query('SELECT * FROM triage_results WHERE submission_id = $1', [id])).rows[0];
const lastSystem = () => env.anthropic.requests.at(-1)!.body.system[0].text as string;
const lastUser = () => env.anthropic.requests.at(-1)!.body.messages[0].content as string;

function addIssue(i: number, number: number, title: string, o: { state?: 'open' | 'closed'; reason?: string } = {}) {
  repo(i).issues.push({ number, title, body: `${title}. Happens every time.`, labels: [], created_at: daysAgo(100), user: 'someone', state: o.state ?? 'open', state_reason: o.reason ?? null, closed_at: o.state === 'closed' ? daysAgo(10) : null });
}

async function file(title = 'Export crashes the app', description = 'Click export and the app closes right away.') {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-v${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `${description} (${n})`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

async function enable(config: Record<string, unknown>) {
  await new Promise((r) => setTimeout(r, 2));
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig(config));
  await setTriageEnabled(env.db, wid(), true);
}

describe('new triage actions', () => {
  it('flags a regression of a fixed issue without closing, and never calls it a duplicate', async () => {
    addIssue(0, 1, 'PNG export of a spread renders a blank right page', { state: 'closed', reason: 'completed' });
    await enable({ regression: { mode: 'auto', close: true }, duplicate: { mode: 'auto', close: true } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, regression_of: 1, regression_confidence: 95, duplicates: [{ number: 1, confidence: 95 }] });
    const t = await file('PNG export of a spread still blank after updating', 'The right page is blank in 0.9.');
    await env.triage.drain();
    const i = issue(t.issue_number);
    expect(i.labels).toEqual(['regression']);
    expect(i.state ?? 'open').toBe('open');
    expect(i.comments?.[0]).toContain('This looks like #1 coming back');
    expect((await result(t.id)).verdict.regression_of).toBe(1);
    expect(lastUser()).toContain('"closed_as": "completed"');
  });

  it('lists several problems in the comment with Claude’s titles stripped of links and mentions', async () => {
    await enable({ multiple: { mode: 'auto' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, parts: ['Right-click does nothing [see](https://evil.example) @everyone', 'The eyedropper picks the wrong colour'], parts_confidence: 92 });
    const t = await file('Two problems', 'Right-click does nothing, and the eyedropper is off.');
    await env.triage.drain();
    const comment = issue(t.issue_number).comments?.[0] ?? '';
    expect(issue(t.issue_number).labels).toEqual(['multiple issues']);
    expect(comment).toContain('- Right-click does nothing see');
    expect(comment).toContain('- The eyedropper picks the wrong colour');
    expect(comment).not.toContain('evil.example');
    expect(comment).not.toContain('@everyone');
  });

  it('links related issues in other repositories and comments on the wrong repository without moving or closing', async () => {
    addIssue(1, 7, 'Installer fails on Windows');
    await new IssueIndexer(env.deps).tick();
    await enable({ related: { mode: 'auto' }, wrongRepo: { mode: 'auto' } });
    const other = `${repo(1).owner}/${repo(1).name}`;
    env.anthropic.queue.push({ ...env.anthropic.verdict, related: [`${other}#7`, 'someone/else#3'], related_confidence: 91, right_app: 'VectorCraft', right_app_confidence: 93 });
    const t = await file('Installer fails on Windows', 'The VectorCraft installer stops halfway.');
    await env.triage.drain();
    expect(lastUser()).toContain(`"ref": "${other}#7"`);
    expect(lastSystem()).toContain(`- VectorCraft (${other})`);
    const i = issue(t.issue_number);
    expect(i.labels).toEqual([]);
    expect(i.state ?? 'open').toBe('open');
    expect(i.comments?.[0]).toContain(`Possibly related: ${other}#7.`);
    expect(i.comments?.[0]).not.toContain('someone/else');
    expect(i.comments?.[0]).toContain(`it should be tracked in [${other}](https://github.com/${other})`);
  });

  it('ignores a wrong-repository call for the app the ticket is already in', async () => {
    await enable({ wrongRepo: { mode: 'auto' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, right_app: 'PhotoCraft', right_app_confidence: 99 });
    const t = await file();
    await env.triage.drain();
    expect(issue(t.issue_number).comments ?? []).toEqual([]);
    expect((await result(t.id)).suggestion_count).toBe(0);
  });
});

describe('label groups', () => {
  it('adds only the defined options, as many as the group allows, and starts new groups off', async () => {
    const type = { id: 'type1', mode: 'auto', ...LABEL_GROUP_PRESETS.type };
    const area = { id: 'area1', mode: 'suggest', ...LABEL_GROUP_PRESETS.area };
    const platform = { id: 'plat1', mode: 'off', ...LABEL_GROUP_PRESETS.platform };
    await enable({ labelGroups: [type, area, platform] });
    env.anthropic.queue.push({ ...env.anthropic.verdict, labels: { type1: { options: ['crash', 'bug'], confidence: 95 }, area1: { options: ['file', 'render', 'ui'], confidence: 80 } } });
    const t = await file();
    await env.triage.drain();
    // The answer format only offers the groups that are on, with their options.
    const schema = JSON.stringify(env.anthropic.requests.at(-1)!.body.output_config.format.schema);
    expect(schema).toContain('One of: crash, bug, perf');
    expect(schema).not.toContain('plat1');
    expect(lastSystem()).toContain('### Type (id: type1)');
    expect(lastSystem()).not.toContain('### Platform');
    expect(issue(t.issue_number).labels).toEqual(['crash']); // one option for Type
    const r = await result(t.id);
    expect(r.suggestions).toEqual([expect.objectContaining({ kind: 'group:area1', labels: ['file', 'render'] })]); // up to two for Area

    // Adding a group from a preset in the console: it starts off.
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/labels/add`, ...form(ws.owner, { preset: 'platform' }) });
    const groups = (await getTriageSettings(env.db, wid())).config.labelGroups;
    expect(groups.at(-1)).toMatchObject({ name: 'Platform', mode: 'off' });
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/labels`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('macos: macOS only.');
  });

  it('saves a group from “label: description” lines and rejects duplicates', async () => {
    await enable({ labelGroups: [{ id: 'grp1', mode: 'off', name: 'Kind', instruction: '', pick: 'one', options: [{ label: 'x', description: '' }] }] });
    const save = (options: string) => env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/labels/grp1`, ...form(ws.owner, { name: 'Kind', mode: 'suggest', pick: 'any', instruction: 'What it is.', options }) });
    await save('bug: Wrong behaviour.\nfeature: Something new.\n\n');
    expect((await getTriageSettings(env.db, wid())).config.labelGroups[0]).toMatchObject({ mode: 'suggest', pick: 'any', options: [{ label: 'bug', description: 'Wrong behaviour.' }, { label: 'feature', description: 'Something new.' }] });
    await save('bug: one\nBug: two');
    expect((await getTriageSettings(env.db, wid())).config.labelGroups[0]!.options).toHaveLength(2);
  });
});

describe('what Apply does', () => {
  it('shows the exact comment, labels and closing for a suggestion before anyone applies it', async () => {
    await enable({ support: { mode: 'suggest', label: 'question', close: true } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, not_dev_issue: true, not_dev_issue_confidence: 70 });
    const t = await file('How do I change units?');
    await env.triage.drain();
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/${t.id}`, ...get(ws.owner) });
    expect(page.body).toContain('What Apply does');
    expect(page.body).toContain('Posts this comment on GitHub');
    expect(page.body).toContain('This looks like a question about using PhotoCraft rather than a bug');
    expect(page.body).toContain('Closes the issue as not planned');
    expect(page.body).toMatch(/Adds the label .*question/s);
    const inbox = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all`, ...get(ws.owner) });
    expect(inbox.body).toContain('Suggested: not a development issue (closed) (adds “question” · comments · closes the issue · tells the member)');
  });
});

describe('prompt settings', () => {
  it('saves products, check wording and examples, and the actions form keeps them', async () => {
    await enable({ duplicate: { mode: 'suggest' } });
    await env.server.inject({
      method: 'POST', url: `${w()}/tickets/triage/prompt`,
      ...form(ws.owner, { products: 'PhotoCraft and VectorCraft share an installer.', rule_duplicate: 'duplicates: only exact copies.', rule_spam: DEFAULT_CHECK_RULES.spam, examples: '', instructions: 'Payments are always high.' }),
    });
    let c = (await getTriageSettings(env.db, wid())).config;
    expect(c).toMatchObject({ products: 'PhotoCraft and VectorCraft share an installer.', examples: '', instructions: 'Payments are always high.', checkRules: { duplicate: 'duplicates: only exact copies.' } });
    expect(c.checkRules.spam).toBeUndefined(); // the built-in wording isn't stored

    await env.server.inject({
      method: 'POST', url: `${w()}/tickets/triage`,
      ...form(ws.owner, { model: 'claude-haiku-5-5', threshold: '90', monthly_limit: '500', app_ids: ws.apps.map((a) => a.id), priority_mode: 'off', priority_label_critical: 'a', priority_label_high: 'b', priority_label_medium: 'c', priority_label_low: 'd', duplicate_mode: 'suggest', duplicate_label: 'duplicate' }),
    });
    c = (await getTriageSettings(env.db, wid())).config;
    expect(c.products).toContain('share an installer');
    expect(c.instructions).toBe('Payments are always high.');

    const full = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/prompt/full`, ...get(ws.owner) });
    expect(full.body).toContain('duplicates: only exact copies.');
    expect(full.body).toContain('PhotoCraft and VectorCraft share an installer.');
    expect(full.body).not.toContain('## Examples');
  });

  it('won’t save an action that is on but would change nothing', async () => {
    await enable({});
    const res = await env.server.inject({
      method: 'POST', url: `${w()}/tickets/triage`,
      ...form(ws.owner, { model: 'claude-haiku-5-5', threshold: '90', monthly_limit: '500', app_ids: ws.apps.map((a) => a.id), priority_mode: 'off', priority_label_critical: 'a', priority_label_high: 'b', priority_label_medium: 'c', priority_label_low: 'd', related_mode: 'auto', related_label: '', related_comment: '' }),
    });
    expect(res.statusCode).toBe(302);
    expect((await getTriageSettings(env.db, wid())).config.related.mode).toBe('off');
  });
});

describe('re-running triage', () => {
  async function untriaged() {
    // Filed before triage was on: never triaged.
    const a = await file('Login fails', 'It just spins.');
    const b = await file('Export crashes');
    return [a, b] as const;
  }

  it('previews without touching GitHub, compares with before, then applies the chosen results', async () => {
    const [a, b] = await untriaged();
    await enable({ spam: { mode: 'auto', close: true } });
    await env.triage.drain();
    expect(env.anthropic.requests).toHaveLength(0);

    await saveTriageConfig(env.db, wid(), parseTriageConfig({ ...(await getTriageSettings(env.db, wid())).config, priority: { mode: 'auto' } }));
    const start = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { never: '1', untouched: '1', limit: '10', mode: 'preview', name: 'Priority test' }) });
    expect(start.statusCode).toBe(302);
    const runUrl = start.headers.location as string;
    env.anthropic.queue.push({ ...env.anthropic.verdict, priority: 'high', priority_confidence: 95 });
    await env.triage.drain();
    expect(env.anthropic.requests).toHaveLength(2);
    expect(issue(a.issue_number).labels).toEqual([]);
    expect(issue(b.issue_number).labels).toEqual([]);
    expect(await result(a.id)).toBeUndefined();
    expect((await monthlyUsage(env.db, wid())).triaged).toBe(2);

    const page = await env.server.inject({ method: 'GET', url: runUrl, ...get(ws.owner) });
    expect(page.body).toContain('Priority test');
    expect(page.body).toContain('Never triaged');
    expect(page.body).toContain('New (not triaged before)');
    expect(page.body).toContain('Automatic:');

    // Apply one ticket's result.
    await env.server.inject({ method: 'POST', url: `${runUrl}/apply`, ...form(ws.owner, { ticket: b.id }) });
    await env.triage.drain();
    expect(issue(b.issue_number).labels).toEqual(['priority: high']);
    expect(issue(a.issue_number).labels).toEqual([]);
    expect(await result(b.id)).toMatchObject({ status: 'done', priority: 'high', input_tokens: null });
    expect(await result(a.id)).toBeUndefined();
    expect((await monthlyUsage(env.db, wid())).triaged).toBe(2); // applying doesn't count again
    const kinds = (await env.db.query('SELECT kind FROM submission_events WHERE submission_id = $1 AND kind LIKE $2', [b.id, 'triage_%'])).rows.map((r) => r.kind);
    expect(kinds).toEqual(['triage_rerun']);
  });

  it('applies right away in an apply run, skips tickets with actions applied, and replaces old suggestions', async () => {
    await enable({ spam: { mode: 'suggest' }, priority: { mode: 'auto' } });
    env.anthropic.queue.push(
      { ...env.anthropic.verdict, spam: true, spam_confidence: 60, priority_confidence: 50 },
      { ...env.anthropic.verdict, priority_confidence: 95 },
    );
    const t = await file('Maybe spam');
    const done = await file('Already labelled');
    await env.triage.drain();
    expect((await result(t.id)).suggestions.map((a: { kind: string }) => a.kind)).toEqual(['spam', 'priority']);
    expect(issue(done.issue_number).labels).toEqual(['priority: medium']);

    const calls = env.anthropic.requests.length;
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { untouched: '1', limit: '10', mode: 'apply' }) });
    env.anthropic.queue.push({ ...env.anthropic.verdict, priority: 'high', priority_confidence: 95 });
    await env.triage.drain();
    // Only the ticket with nothing applied was picked.
    expect(env.anthropic.requests.length - calls).toBe(1);
    expect(issue(t.issue_number).labels).toEqual(['priority: high']);
    expect(await result(t.id)).toMatchObject({ suggestions: [], suggestion_count: 0, priority: 'high' });
    expect((await result(t.id)).applied_actions).toEqual([expect.objectContaining({ kind: 'priority', priority: 'high' })]);
    expect(issue(done.issue_number).labels).toEqual(['priority: medium']);
  });

  it('runs tickets that only have suggestions, one run at a time, and can be stopped', async () => {
    await enable({ spam: { mode: 'suggest' } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, spam: true, spam_confidence: 60 });
    const t = await file('Maybe spam');
    await env.triage.drain();
    expect((await result(t.id)).suggestion_count).toBe(1);

    const first = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { untouched: '1', limit: '10', mode: 'apply' }) });
    const second = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { untouched: '1', limit: '10', mode: 'preview' }) });
    expect(second.headers.location).toBe(`${w()}/tickets/triage/runs`); // refused: one at a time
    await env.triage.drain();
    expect(await result(t.id)).toMatchObject({ status: 'done', suggestion_count: 0 });
    const run = (await env.db.query('SELECT * FROM triage_runs WHERE workspace_id = $1', [wid()])).rows[0];
    expect(run.status).toBe('done');
    expect(first.headers.location).toBe(`${w()}/tickets/triage/runs/${run.id}`);
    const item = (await env.db.query('SELECT * FROM triage_run_items WHERE run_id = $1', [run.id])).rows[0];
    expect(item).toMatchObject({ status: 'done', apply_status: 'done' });
    expect(item.before.suggestions).toEqual([expect.objectContaining({ kind: 'spam' })]);

    // A new run that's stopped before the worker gets to it.
    const third = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { never: '1', untouched: '1', limit: '10', mode: 'preview' }) });
    await env.server.inject({ method: 'POST', url: `${third.headers.location}/cancel`, ...form(ws.owner) });
    const calls = env.anthropic.requests.length;
    await env.triage.drain();
    expect(env.anthropic.requests.length).toBe(calls);
    const list = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs`, ...get(ws.owner) });
    expect(list.body).toContain('Stopped');
  });
});

describe('re-running at scale', () => {
  /** Copies a filed ticket many times (their GitHub issues don't exist, so triage skips them). */
  async function clones(srcId: string, count: number) {
    const src = (await env.db.query('SELECT * FROM submissions WHERE id = $1', [srcId])).rows[0];
    for (let i = 0; i < count; i++) {
      const row = { ...src, id: randomUUID(), ref: `TR-CLONE${String(i).padStart(4, '0')}`, discord_interaction_id: `clone-${i}`, issue_number: 5000 + i, completed_at: new Date(Date.now() - (i + 1) * 1000) };
      const cols = Object.keys(row);
      await env.db.query(`INSERT INTO submissions (${cols.join(', ')}) VALUES (${cols.map((_, j) => `$${j + 1}`).join(', ')})`, cols.map((c) => row[c]));
    }
  }
  const start = (fields: Record<string, string>) => env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { never: '1', untouched: '1', mode: 'preview', ...fields }) });
  const latestRun = async () => (await env.db.query('SELECT * FROM triage_runs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1', [wid()])).rows[0];
  const items = async (runId: string) => (await env.db.query('SELECT * FROM triage_run_items WHERE run_id = $1 ORDER BY position', [runId])).rows;

  it('queues every matching ticket, well past 200, up to what’s left of the monthly limit, and pages the results', async () => {
    const t = await file();
    await clones(t.id, 229);
    await enable({ priority: { mode: 'suggest' }, monthlyLimit: 5000 });
    const est = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/estimate?untouched=1&never=1&count=all`, ...get(ws.owner) });
    expect(est.json()).toMatchObject({ allLabel: 'All matching tickets (230)' });
    expect(est.json().text).toContain('230 tickets');
    await start({ count: 'all' });
    const run = await latestRun();
    expect(await items(run.id)).toHaveLength(230);
    expect(run.scope).toMatchObject({ matched: 230 });
    await env.triage.drain();
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/${run.id}`, ...get(ws.owner) });
    expect(page.body).toContain('Page 1 of 5');
    expect(page.body).toContain('page=2');

    // The monthly limit caps a run: the newest tickets go first.
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ ...(await getTriageSettings(env.db, wid())).config, monthlyLimit: 1 + 10 }));
    const est2 = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/estimate?untouched=1&never=1&count=all`, ...get(ws.owner) });
    expect(est2.json().text).toContain('The newest 10 of');
    expect(est2.json().warn).toContain('Raise the monthly limit');
  });

  it('applies every result in a filter at once, with or without the suggestions, one ticket at a time', async () => {
    const a = await file('Login fails');
    const b = await file('Export crashes');
    const c = await file('Sync is slow');
    await enable({ priority: { mode: 'suggest' } });
    // One ticket was triaged before with the same result, so it's "same"; the others are new.
    await env.db.query(`INSERT INTO triage_results (submission_id, workspace_id, status, suggestions, verdict, completed_at) VALUES ($1, $2, 'done', $3, $4, now_ms())`, [c.id, wid(), JSON.stringify([{ kind: 'priority', label: 'priority: medium', close: false, confidence: 80, priority: 'medium' }]), JSON.stringify({ reason: 'x' })]);
    await start({ count: 'all' });
    await env.triage.drain();
    const run = await latestRun();
    expect((await items(run.id)).map((i: { change: string }) => i.change).sort()).toEqual(['new', 'new', 'same']);

    // "Apply all changed results", approving the suggestions too.
    await env.server.inject({ method: 'POST', url: `/w/${wid()}/tickets/triage/runs/${run.id}/apply`, ...form(ws.owner, { scope: 'filter', show: 'changed', include: 'all' }) });
    expect((await items(run.id)).filter((i: { apply_status: string }) => i.apply_status === 'pending')).toHaveLength(2);
    await env.triage.drain();
    expect(issue(a.issue_number).labels).toEqual(['priority: medium']);
    expect(issue(b.issue_number).labels).toEqual(['priority: medium']);
    expect(issue(c.issue_number).labels).toEqual([]);
    expect(await result(a.id)).toMatchObject({ suggestions: [], applied_actions: [expect.objectContaining({ kind: 'priority' })] });

    // Without suggestions, applying the rest only replaces its suggestions.
    await env.server.inject({ method: 'POST', url: `/w/${wid()}/tickets/triage/runs/${run.id}/apply`, ...form(ws.owner, { scope: 'filter', show: 'all', include: 'auto' }) });
    await env.triage.drain();
    expect(issue(c.issue_number).labels).toEqual([]);
    expect((await result(c.id)).suggestions).toEqual([expect.objectContaining({ kind: 'priority' })]);
    expect((await items(run.id)).every((i: { apply_status: string }) => i.apply_status === 'done')).toBe(true);
  });

  it('can stop applying, and the rest can be applied later', async () => {
    const a = await file('Login fails');
    await file('Export crashes');
    await enable({ priority: { mode: 'suggest' } });
    await start({ count: 'all' });
    await env.triage.drain();
    const run = await latestRun();
    await env.server.inject({ method: 'POST', url: `/w/${wid()}/tickets/triage/runs/${run.id}/apply`, ...form(ws.owner, { scope: 'filter', show: 'all', include: 'all' }) });
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/${run.id}`, ...get(ws.owner) });
    expect(page.body).toContain('Stop applying');
    expect(page.body).toContain('Applying on GitHub');
    await env.server.inject({ method: 'POST', url: `/w/${wid()}/tickets/triage/runs/${run.id}/stop-applying`, ...form(ws.owner) });
    await env.triage.drain();
    expect(issue(a.issue_number).labels).toEqual([]);
    expect((await items(run.id)).every((i: { apply_status: string | null }) => i.apply_status === null)).toBe(true);
  });

  it('waits instead of using up GitHub’s hourly budget, so filing keeps working', async () => {
    await file('Login fails');
    await enable({ priority: { mode: 'suggest' } });
    const github = env.triage.engine.deps.github!;
    github.rateLimits.set(ws.installationId, { limit: 5000, remaining: 300, resetAt: new Date(Date.now() + 30 * 60_000), at: new Date() });
    await start({ count: 'all' });
    await env.triage.drain();
    expect(env.anthropic.requests).toHaveLength(0);
    const run = await latestRun();
    expect(run.waiting_reason).toBe('github');
    expect((await items(run.id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/${run.id}`, ...get(ws.owner) });
    expect(page.body).toContain('Waiting for GitHub’s hourly limit to reset');

    // A new ticket is still filed and triaged meanwhile.
    const t = await file('Export crashes');
    await env.triage.drain();
    expect((await result(t.id)).status).toBe('done');

    // Once the budget resets, the run carries on.
    github.rateLimits.delete(ws.installationId);
    await env.db.query('UPDATE triage_runs SET waiting_until_at = now_ms() - 1000 WHERE id = $1', [run.id]);
    await env.triage.drain();
    expect(await latestRun()).toMatchObject({ status: 'done', waiting_reason: null });
  });
});

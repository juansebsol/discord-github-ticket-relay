import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IssueIndexer } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { getTriageSettings, monthlyUsage, parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled, tokenCost } from '../src/triage/settings.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;

const KIND = {
  id: 'kind1', mode: 'auto', name: 'Kind', instruction: 'What kind of work this is.', pick: 'one',
  options: [{ label: 'bug', description: 'Something broken.' }, { label: 'parity', description: 'The target app has it and this one doesn’t.' }, { label: 'plugins', description: 'Better as a plug-in.' }],
};
const TOPIC = { id: 'topic1', mode: 'off', name: 'Topic', instruction: '', pick: 'two', options: [{ label: 'i18n', description: 'Translations.' }, { label: 'performance', description: 'Slow.' }] };

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'PhotoCraft', repoIndex: 0 }] });
});
afterAll(async () => {
  await testDb().end();
});

const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const result = async (id: string) => (await env.db.query('SELECT * FROM triage_results WHERE submission_id = $1', [id])).rows[0];
const page = (path: string) => env.server.inject({ method: 'GET', url: `${w()}${path}`, ...get(ws.owner) });
const lastBody = () => env.anthropic.requests.at(-1)!.body;
const pick = (options: string[], confidence: number, reason = 'Fits.') => ({ reason, labels: { kind1: { options, confidence } } });

async function file(title: string) {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-cl${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `${title}, every time. (${n})`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

async function enable(config: Record<string, unknown>) {
  await new Promise((r) => setTimeout(r, 2));
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig({ threshold: 60, ...config }));
  await setTriageEnabled(env.db, wid(), true);
}

/** Three tickets triage already acted on (a priority each), the third labelled parity by someone on GitHub. */
async function triaged() {
  await enable({ priority: { mode: 'auto' }, labelGroups: [KIND, TOPIC] });
  // Kind is on, so normal triage answers it too (nothing fits yet).
  const none = { kind1: { options: [], confidence: 30 } };
  env.anthropic.queue.push({ ...env.anthropic.verdict, summary: 'Wants content-aware fill', labels: none }, { ...env.anthropic.verdict, labels: none }, { ...env.anthropic.verdict, labels: none });
  const a = await file('Add content-aware fill like Photoshop has');
  const b = await file('Export crashes the app');
  const c = await file('Missing the Liquify filter');
  await env.triage.drain();
  issue(c.issue_number).labels.push('parity');
  await new IssueIndexer(env.deps).tick();
  return { a, b, c };
}

const startRun = (fields: Record<string, string | string[]>) => env.server.inject({ method: 'POST', url: `${w()}/triage/runs`, ...form(ws.owner, { what: 'labels', labels_form: '1', group: 'kind1', count: 'all', ...fields }) });

describe('backfilling custom labels', () => {
  it('asks only about the chosen categories on tickets triage already acted on, and adds labels and nothing else', async () => {
    const { a, b, c } = await triaged();
    expect(issue(a.issue_number).labels).toEqual(['priority: medium']);
    const calls = env.anthropic.requests.length;

    // The form offers it, with the categories, their labels and what the open issues have.
    const runs = await page('/triage/runs');
    expect(runs.body).toContain('Custom labels only');
    expect(runs.body).toContain('name="group" value="kind1" checked');
    expect(runs.body).toContain('name="only" value="parity" checked');
    expect(runs.body).toContain('2 of 3 open issues have none yet');

    // Missing these labels: the one labelled parity is left out.
    const start = await startRun({ only: ['bug', 'parity', 'plugins'], which: 'missing', mode: 'preview', name: 'Backfill Kind' });
    expect(start.statusCode).toBe(302);
    const runUrl = start.headers.location as string;
    expect(runUrl).toMatch(/\/triage\/runs\/[0-9a-f-]{36}$/);
    // Newest first: the crash, then content-aware fill.
    env.anthropic.queue.push(pick(['bug'], 55), pick(['parity'], 92, 'Photoshop has content-aware fill.'));
    await env.triage.drain();
    expect(env.anthropic.requests.length - calls).toBe(2);
    // A short prompt about Kind only, with what triage found before and the labels it has now.
    const system = lastBody().system.map((s: { text: string }) => s.text).join('\n');
    expect(system).toContain('You sort GitHub issues into the team’s own labels');
    expect(system).toContain('### Kind (id: kind1)');
    expect(system).toContain('- parity: The target app has it and this one doesn’t.');
    expect(system).not.toContain('### Topic');
    expect(system).not.toContain('duplicates');
    const user = lastBody().messages[0].content as string;
    expect(user).toContain('What triage found when it read this ticket before');
    expect(user).toContain('Labels it has on GitHub now: priority: medium.');
    expect(Object.keys(lastBody().output_config.format.schema.properties)).toEqual(['reason', 'labels']);
    // A preview changes nothing on GitHub, and counts toward the monthly limit.
    expect(issue(a.issue_number).labels).toEqual(['priority: medium']);
    expect((await monthlyUsage(env.db, wid())).triaged).toBe(5);

    const run = await env.server.inject({ method: 'GET', url: runUrl, ...get(ws.owner) });
    expect(run.body).toContain('What this run adds');
    expect(run.body).toContain('Claude picked');
    expect(run.body).toContain('Add the labels Claude is at least 60% sure of');
    expect(run.body).toContain('Photoshop has content-aware fill.');
    expect(run.body).not.toContain('Update the inbox only');

    // Add the sure ones: parity on the first; the crash (55%) stays as it is.
    await env.server.inject({ method: 'POST', url: `${runUrl}/apply`, ...form(ws.owner, { scope: 'filter', show: 'all', include: 'auto' }) });
    await env.triage.drain();
    expect(issue(a.issue_number).labels).toEqual(['priority: medium', 'parity']);
    expect(issue(b.issue_number).labels).toEqual(['priority: medium']);
    expect(issue(c.issue_number).labels).toEqual(['priority: medium', 'parity']);
    // Labels only: no comment, nothing closed, and the ticket's triage stays as it was.
    expect(issue(a.issue_number).comments ?? []).toEqual([]);
    expect(issue(a.issue_number).state ?? 'open').toBe('open');
    expect((await result(a.id)).applied_actions.map((x: { kind: string }) => x.kind)).toEqual(['priority']);
    const events = (await env.db.query('SELECT kind, detail FROM submission_events WHERE submission_id = $1 AND kind = $2', [a.id, 'triage_labels'])).rows;
    expect(events).toEqual([{ kind: 'triage_labels', detail: { by: ws.owner.user.id, labels: ['parity'] } }]);
    // Our copy of the issue has it right away.
    const indexed = (await env.db.query('SELECT labels FROM issue_index WHERE repo_id = $1 AND number = $2', [ws.repoIds[0], a.issue_number])).rows[0];
    expect(indexed.labels).toContain('parity');
    const ticket = await page(`/tickets/${a.id}`);
    expect(ticket.body).toContain('Custom labels added: parity');

    // Then every label Claude picked: the crash gets bug too.
    await env.server.inject({ method: 'POST', url: `${runUrl}/apply`, ...form(ws.owner, { scope: 'filter', show: 'all', include: 'all' }) });
    await env.triage.drain();
    expect(issue(b.issue_number).labels).toEqual(['priority: medium', 'bug']);
    // Overview counts them with what triage added: three priorities, parity and bug.
    expect((await page('/triage/overview')).body).toMatch(/Labels added<\/div><div class="an-kv">5</);
  });

  it('can add just one label to every open ticket, in a run that applies right away', async () => {
    const { a, b, c } = await triaged();
    // Every open one, even those with a Kind label; only plugins is added.
    await startRun({ only: 'plugins', which: 'all', mode: 'apply' });
    env.anthropic.queue.push(pick(['plugins'], 95), pick(['bug'], 95), pick(['plugins'], 91));
    await env.triage.drain();
    expect(issue(a.issue_number).labels).toEqual(['priority: medium', 'plugins']);
    expect(issue(b.issue_number).labels).toEqual(['priority: medium']);
    expect(issue(c.issue_number).labels).toEqual(['priority: medium', 'parity', 'plugins']);
    const runs = await page('/triage/runs');
    expect(runs.body).toContain('Custom labels');
  });

  it('refuses a backfill with no category or no label to add', async () => {
    await triaged();
    const none = await startRun({ group: [], only: [] });
    expect(none.headers.location).toBe(`${w()}/triage/runs`);
    const noLabel = await startRun({ group: 'kind1', only: [] });
    expect(noLabel.headers.location).toBe(`${w()}/triage/runs`);
    expect((await env.db.query('SELECT count(*) AS n FROM triage_runs')).rows[0].n).toBe(0);
    const estimate = await env.server.inject({ method: 'GET', url: `${w()}/triage/runs/estimate?what=labels&labels_form=1&group=kind1&which=missing`, ...get(ws.owner) });
    expect(estimate.json()).toMatchObject({ text: 'Choose at least one label to add.' });
    const ok = await env.server.inject({ method: 'GET', url: `${w()}/triage/runs/estimate?what=labels&labels_form=1&group=kind1&only=bug&only=parity&only=plugins&which=missing`, ...get(ws.owner) });
    expect(ok.json()).toMatchObject({ missing: 'Missing these labels (2)', open: 'Every open one (3)' });
  });
});

describe('what a backfill costs', () => {
  it('prices the cache at its own rate, says it before Start, and shows what it cost so far and when done', async () => {
    // Haiku 5.5: $0.10 per million input, $0.50 output, a cache read a tenth of the input price.
    expect(tokenCost('claude-haiku-5-5', 3000, 300, { read: 2500 })).toBeCloseTo((500 * 0.1 + 2500 * 0.01 + 300 * 0.5) / 1e6, 12);
    expect(tokenCost('claude-haiku-5-5', 3000, 300)).toBeCloseTo((3000 * 0.1 + 300 * 0.5) / 1e6, 12);
    await triaged();
    // Before any backfill: an estimate that says it is one, and the confirmation Start shows.
    const est = await env.server.inject({ method: 'GET', url: `${w()}/triage/runs/estimate?what=labels&labels_form=1&group=kind1&only=bug&only=parity&only=plugins&which=all`, ...get(ws.owner) });
    expect(est.json()).toMatchObject({ cost: 'under $0.01', basis: expect.stringContaining('estimated until a run has measured it'), confirm: expect.stringContaining('Claude reads 3 tickets and issues and picks custom labels for them: under $0.01 with claude-haiku-5-5') });
    expect((await page('/triage/runs?what=labels')).body).toContain('data-confirm-title="Start this run?"');

    // Each read keeps what came from the cache.
    env.anthropic.usage = { input_tokens: 400, cache_read_input_tokens: 2600, cache_creation_input_tokens: 0, output_tokens: 200 };
    const start = await startRun({ only: ['bug', 'parity', 'plugins'], which: 'all', mode: 'preview' });
    env.anthropic.queue.push(pick(['bug'], 90), pick(['bug'], 90), pick(['parity'], 90));
    await env.triage.drain();
    const items = (await env.db.query('SELECT input_tokens, cache_read_tokens, cache_write_tokens FROM triage_run_items')).rows;
    expect(items).toEqual(Array(3).fill({ input_tokens: 3000, cache_read_tokens: 2600, cache_write_tokens: 0 }));
    // 3 × (400 × $0.10 + 2,600 × $0.01 + 200 × $0.50) per million ≈ $0.0005
    const runUrl = start.headers.location as string;
    expect((await env.server.inject({ method: 'GET', url: runUrl, ...get(ws.owner) })).body).toContain('just now · $0.0005</p>');
    expect((await page('/triage/runs')).body).toContain('$0.0005');

    // Partway through: so far, and the same average for the rest.
    await env.db.query(`UPDATE triage_runs SET status = 'running', finished_at = NULL`);
    await env.db.query(`UPDATE triage_run_items SET status = 'pending', input_tokens = NULL, cache_read_tokens = NULL, output_tokens = NULL WHERE position = 2`);
    const running = (await env.server.inject({ method: 'GET', url: runUrl, ...get(ws.owner) })).body;
    expect(running).toContain('<strong>$0.0003</strong> so far · about <strong>$0.0005</strong> when done');
    // Measured now, the next estimate says what it's based on.
    await env.db.query(`UPDATE triage_runs SET status = 'cancelled'`);
    for (let i = 0; i < 20; i++) await env.db.query(`INSERT INTO triage_run_items (run_id, subject, submission_id, position, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) SELECT run_id, 'x' || $1, submission_id, 10 + $1, 'done', 3000, 200, 2600, 0 FROM triage_run_items LIMIT 1`, [i]);
    const measured = await env.server.inject({ method: 'GET', url: `${w()}/triage/runs/estimate?what=labels&labels_form=1&group=kind1&only=bug&only=parity&only=plugins&which=all`, ...get(ws.owner) });
    expect(measured.json().basis).toContain('About $0.0002 a ticket with claude-haiku-5-5, from your last 22 custom-label passes');
  });
});

describe('Custom labels page', () => {
  it('shows each category with the open issues that have each label, and saves a row per label', async () => {
    await triaged();
    const res = await page('/triage/labels');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Custom labels · AI triage');
    // Every category starts closed: its name, how many Claude picks and its labels with their counts show; the editor opens on click.
    expect(res.body).toContain('<details class="cl-cat" id="g-kind1" data-flash>');
    expect(res.body).not.toMatch(/<details class="cl-cat"[^>]*\bopen\b/);
    expect(res.body).toContain('One label per ticket');
    expect(res.body).toMatch(/parity<\/span><span class="n">1<\/span>/);
    expect(res.body).toContain('<b>1</b> of 3 open issues have a Kind label');
    expect(res.body).toContain('value="parity"');
    expect(res.body).toContain(`/triage/runs?what=labels&amp;group=kind1&amp;only=parity`);

    const save = (fields: Record<string, string | string[]>) => env.server.inject({ method: 'POST', url: `${w()}/triage/labels/kind1`, ...form(ws.owner, { name: 'Kind', mode: 'auto', pick: 'one', instruction: 'What kind.', ...fields }) });
    await save({ opt_label: ['bug', 'parity', 'backlog', ''], opt_desc: ['Something broken.', 'The target app has it.', 'Worth doing, later.', ''] });
    expect((await getTriageSettings(env.db, wid())).config.labelGroups[0]!.options).toEqual([
      { label: 'bug', description: 'Something broken.' }, { label: 'parity', description: 'The target app has it.' }, { label: 'backlog', description: 'Worth doing, later.' },
    ]);
    // A sentence without a label isn't saved.
    const bad = await save({ opt_label: ['bug', ''], opt_desc: ['Broken.', 'Orphan sentence.'] });
    expect(bad.statusCode).toBe(302);
    expect((await getTriageSettings(env.db, wid())).config.labelGroups[0]!.options).toHaveLength(3);
  });
});

describe('AI triage › Overview', () => {
  it('shows what triage did and every label on the open issues, linked to GitHub', async () => {
    await triaged();
    const res = await page('/triage/overview?range=7d');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<a class="tab" href="' + `${w()}/triage/overview` + '" aria-current="page">Overview</a>');
    expect(res.body).toContain('Labels on open issues');
    expect(res.body).toContain('3 open issues');
    // Priority, the custom categories with what still has none, and a backfill for them.
    expect(res.body).toMatch(/medium<\/a><b>3<\/b>/);
    expect(res.body).toContain('<h3 id="ov-g-kind1">Kind</h3>');
    expect(res.body).toContain('None yet');
    expect(res.body).toContain('/triage/runs?what=labels&amp;group=kind1');
    expect(res.body).toContain(encodeURIComponent('label:"parity"'));
    expect(res.body).toContain('What triage did');
    expect(res.body).toContain('Read per day');
    // The sidebar goes here first.
    expect(res.body).toContain(`href="${w()}/triage/overview" class="nav-item" aria-current="page"`);
  });

  it('opens for moderators who can see Review (the migration gives them it), and not for others', async () => {
    const mod = await makeAdmin(env, 'mo');
    await env.db.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [wid(), mod.user.id, 'moderator']);
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view' });
    const locked = await env.server.inject({ method: 'GET', url: `${w()}/triage/overview`, ...get(mod) });
    expect(locked.statusCode).toBe(403);
    await grant(env, wid(), mod.user.id, { 'triage.overview': 'view' });
    const open = await env.server.inject({ method: 'GET', url: `${w()}/triage/overview`, ...get(mod) });
    expect(open.statusCode).toBe(200);
    expect(open.body).not.toContain('Backfill');
  });
});

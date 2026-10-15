import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepos } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite, setModeratorPermissions } from '../src/domain/workspaces.js';
import { parseTriageConfig, saveTriageConfig, setApiKey, setGitHubTriageEnabled, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const result = async (id: string) => (await env.db.query('SELECT * FROM triage_results WHERE submission_id = $1', [id])).rows[0];

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

async function file(title: string) {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-b${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `Something happens (${n}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

/** Three tickets: spam suggested at 85% and 70%, and one that isn't spam; each also has a priority suggestion. */
async function setup() {
  await new Promise((r) => setTimeout(r, 3));
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'suggest' }, spam: { mode: 'suggest', close: true } }));
  await setTriageEnabled(env.db, wid(), true);
  env.anthropic.queue.push(
    { ...env.anthropic.verdict, spam: true, spam_confidence: 85 },
    { ...env.anthropic.verdict, spam: true, spam_confidence: 70 },
    { ...env.anthropic.verdict },
  );
  const sure = await file('Buy followers');
  const unsure = await file('Cheap stuff maybe');
  const real = await file('Export crashes');
  await env.triage.drain();
  return { sure, unsure, real };
}

const bulk = (fields: Record<string, string | string[]>, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/bulk`, ...form(who, { from: 'inbox', back: `${w()}/tickets`, ...fields }) });

describe('bulk Apply and Dismiss in the inbox', () => {
  it('applies only the filtered suggestions (spam at 80%+), on everything in the list, one at a time', async () => {
    const { sure, unsure, real } = await setup();
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all&triage=f:spam&conf=80`, ...get(ws.owner) });
    expect(page.body).toContain(`value="sub:${sure.id}" form="bulk-triage"`);
    expect(page.body).not.toContain(`value="sub:${unsure.id}" form="bulk-triage"`);
    expect(page.body).toContain('data-confirm-title="Apply “Spam” suggestions at 80%+ confidence?"');
    expect(page.body).toContain('adds “spam” · posts your comment · closes the issue');

    await bulk({ op: 'apply', all: '1', status: 'all', triage: 'f:spam', conf: '80' });
    const job = (await env.db.query('SELECT * FROM triage_bulk')).rows[0];
    expect(job).toMatchObject({ status: 'running', description: '“Spam” suggestions at 80%+ confidence' });
    expect((await env.db.query('SELECT subject FROM triage_bulk_items')).rows.map((r) => r.subject)).toEqual([`sub:${sure.id}`]);
    const inbox = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all`, ...get(ws.owner) });
    expect(inbox.body).toContain('Applying “Spam” suggestions at 80%+ confidence');

    await env.triage.drain();
    expect(issue(sure.issue_number).labels).toEqual(['spam']);
    expect(issue(sure.issue_number).state).toBe('closed');
    expect(issue(unsure.issue_number).labels).toEqual([]);
    expect(issue(real.issue_number).labels).toEqual([]);
    // The priority suggestion stays: the ticket is Partly applied.
    expect((await result(sure.id)).suggestions.map((a: { kind: string }) => a.kind)).toEqual(['priority']);
    expect((await env.db.query('SELECT status FROM triage_bulk')).rows[0].status).toBe('done');
    const log = (await env.db.query('SELECT result, message, submission_id FROM triage_log WHERE bulk_id = $1 ORDER BY id', [job.id])).rows;
    expect(log.map((l) => l.result)).toEqual(['info', 'ok', 'info']);
    expect(log[2].message).toBe('Bulk apply finished: 1 applied');
    const activity = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/activity?bulk=${job.id}`, ...get(ws.owner) });
    expect(activity.body).toContain('Bulk by');
  });

  it('dismisses the filtered suggestions right away, on the tickets picked', async () => {
    const { sure, unsure, real } = await setup();
    await bulk({ op: 'dismiss', triage: 'p:medium', ticket: [`sub:${sure.id}`, `sub:${real.id}`] });
    expect((await result(sure.id)).suggestions.map((a: { kind: string }) => a.kind)).toEqual(['spam']);
    expect(await result(real.id)).toMatchObject({ suggestion_count: 0, dismissed_count: 1 });
    expect((await result(unsure.id)).suggestion_count).toBe(2);
    expect(issue(real.issue_number).labels).toEqual([]);
    expect((await env.db.query(`SELECT count(*) AS n FROM triage_log WHERE source = 'review' AND result = 'ok'`)).rows[0].n).toBe(2);
  });

  it('can be stopped, and needs permission to act on tickets', async () => {
    const { sure, unsure } = await setup();
    await bulk({ op: 'apply', triage: 'f:spam', ticket: [`sub:${sure.id}`, `sub:${unsure.id}`] });
    const job = (await env.db.query('SELECT * FROM triage_bulk')).rows[0];
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/bulk/${job.id}/stop`, ...form(ws.owner) });
    await env.triage.drain();
    expect(issue(sure.issue_number).labels).toEqual([]);
    expect((await env.db.query(`SELECT status FROM triage_bulk_items`)).rows.every((r) => r.status === 'skipped')).toBe(true);

    const mod = await makeAdmin(env, 'mia');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await setModeratorPermissions(env.db, wid(), mod.user.id, { canActTickets: false, canViewContributors: false });
    expect((await bulk({ op: 'apply', triage: 'f:spam', ticket: [`sub:${sure.id}`] }, mod)).statusCode).toBe(403);
    const modInbox = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all`, ...get(mod) });
    expect(modInbox.body).not.toContain('form="bulk-triage"');
    // Moderators see the pages they can't open, locked, and can't follow them.
    expect(modInbox.body).toContain('class="nav-item locked"');
    expect(modInbox.body).toContain('Only admins can open Settings.');
    expect(modInbox.body).not.toContain(`href="${w()}/settings"`);
    const ownerInbox = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all`, ...get(ws.owner) });
    expect(ownerInbox.body).not.toContain('nav-item locked');
  });
});

describe('bulk Apply in Issues › Triage', () => {
  it('applies the filtered suggestions on issues opened on GitHub', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ githubModes: { spam: 'suggest', priority: 'suggest' } }));
    await setGitHubTriageEnabled(env.db, wid(), true);
    await new Promise((r) => setTimeout(r, 5));
    repo().issues.push({ number: 700, title: 'Win a prize', body: 'Click here.', labels: [], created_at: new Date().toISOString(), user: 'someone' });
    await ensureRepos(env.db);
    await env.triage.engine.indexer.sync(ws.repoIds[0]!, { pages: 5, fullCheck: false });
    env.anthropic.queue.push({ ...env.anthropic.verdict, spam: true, spam_confidence: 85 });
    await env.triage.drain();

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues/triage?f=f:spam`, ...get(ws.owner) });
    expect(page.body).toContain(`value="gh:${ws.repoIds[0]}:700" form="bulk-triage"`);
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/bulk`, ...form(ws.owner, { from: 'issues', back: `${w()}/tickets/issues/triage`, op: 'apply', all: '1', show: 'review', f: 'f:spam' }) });
    await env.triage.drain();
    expect(issue(700).labels).toEqual(['spam']);
    const r = (await env.db.query('SELECT suggestions FROM issue_triage WHERE number = 700')).rows[0];
    expect(r.suggestions.map((a: { kind: string }) => a.kind)).toEqual(['priority']);
  });
});

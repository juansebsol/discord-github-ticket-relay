import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { getGitHubConnection, updateApp } from '../src/domain/store.js';
import { acceptSubmission, getSubmission } from '../src/domain/submissions.js';
import type { AppRow, SubmissionRow } from '../src/domain/types.js';
import { runMaintenance } from '../src/domain/worker.js';
import { submissionMarker } from '../src/github/issue-content.js';
import { makeApp, makeWorkspace, resetDb, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';
import { TEST_DATABASE_PATH } from './global-setup.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let counter = 0;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App', labels: ['bug'] }] });
});
afterAll(async () => {
  await testDb().end();
});

async function submit(app: AppRow = ws.apps[0]!, e: TestEnv = env): Promise<SubmissionRow> {
  const n = ++counter;
  const result = await acceptSubmission(e.deps, {
    workspace: ws.workspace,
    app,
    installationId: ws.installationId,
    source: 'discord',
    interactionId: `int-${n}`,
    interactionToken: `tok-${n}`,
    guildId: ws.guildId,
    guildName: 'Guild',
    channelId: ws.channelId,
    reporter: { id: `reporter-${n}`, displayName: `Reporter ${n}`, username: `reporter${n}` },
    title: `Problem number ${n}`,
    description: `Detailed description of problem ${n}.`,
  });
  if (result.kind !== 'accepted') throw new Error(result.kind);
  return result.submission;
}

async function reload(sub: SubmissionRow): Promise<SubmissionRow> {
  return (await getSubmission(env.db, ws.workspace.id, sub.id))!;
}

async function makeDue(sub: SubmissionRow) {
  await env.db.query('UPDATE submissions SET next_attempt_at = now_ms() WHERE id = $1', [sub.id]);
}

function lastEditTitle(token: string) {
  return env.discord.interactionEdits.filter((e) => e.token === token).at(-1)?.payload.embeds[0].title;
}

describe('GitHub failure handling', () => {
  it('fails clearly on missing permissions and disabled Issues, without retrying', async () => {
    env.github.createQueue.push({ status: 403, body: { message: 'Resource not accessible by integration' } });
    const a = await submit();
    await env.worker.drain();
    expect(await reload(a)).toMatchObject({ status: 'failed', error_code: 'missing_permission' });
    expect((await reload(a)).error_message).toMatch(/Issues: Read and write/);
    expect(lastEditTitle('tok-' + counter)).toBe('Ticket could not be filed yet');

    env.github.createQueue.push({ status: 410, body: { message: 'Issues are disabled for this repo' } });
    const b = await submit();
    await env.worker.drain();
    expect(await reload(b)).toMatchObject({ status: 'failed', error_code: 'issues_disabled' });
    await env.worker.drain();
    expect(env.github.createCalls).toBe(2);
  });

  it('waits out rate limits and then files the ticket', async () => {
    env.github.createQueue.push({ status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '30' } });
    const sub = await submit();
    await env.worker.drain();
    const queued = await reload(sub);
    expect(queued.status).toBe('pending');
    expect(queued.github_request_started_at).toBeNull();
    expect(queued.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(lastEditTitle(`tok-${counter}`)).toBe('Ticket received, still being filed');
    await env.worker.drain();
    expect(env.github.createCalls).toBe(1); // not due yet
    await makeDue(sub);
    await env.worker.drain();
    expect(await reload(sub)).toMatchObject({ status: 'created' });
    expect(lastEditTitle(`tok-${counter}`)).toBe('Ticket submitted');
  });

  it('refreshes the installation token after an authentication failure', async () => {
    const sub = await submit();
    await env.deps.github!.installationToken(ws.installationId);
    env.github.invalidToken = `ghs_${ws.installationId}_1`;
    await env.worker.drain();
    expect((await reload(sub)).status).toBe('pending');
    await makeDue(sub);
    await env.worker.drain();
    expect((await reload(sub)).status).toBe('created');
    expect(env.github.tokenCalls).toBe(2);
  });

  it('skips labels that were deleted, and retries without labels if GitHub rejects them', async () => {
    const repo = env.github.repos.get(ws.repoIds[0]!)!;
    repo.labels = ['support'];
    const a = await submit();
    await env.worker.drain();
    const created = await reload(a);
    expect(created.status).toBe('created');
    expect(created.warnings.join()).toMatch(/Skipped missing labels: bug/);
    expect(env.github.allIssues()[0]!.labels).toEqual([]);
    expect(repo.labels).toEqual(['support']); // not silently re-created

    repo.labels = ['bug'];
    env.github.createQueue.push({ status: 422, body: { message: 'Validation Failed' } });
    const b = await submit();
    await env.deps.github!.installationToken(ws.installationId);
    await env.worker.drain();
    await new Promise((r) => setTimeout(r, 50));
    await env.worker.drain();
    const retried = await reload(b);
    expect(retried.status).toBe('created');
    expect(retried.warnings.join()).toMatch(/filed without labels/);
  });

  it('marks the connection as broken when the GitHub App was uninstalled', async () => {
    env.github.installations.delete(ws.installationId);
    const sub = await submit();
    await env.worker.drain();
    expect(await reload(sub)).toMatchObject({ status: 'failed', error_code: 'installation_missing' });
    expect((await getGitHubConnection(env.db, ws.workspace.id))!.status).toBe('error');
  });

  it('retries automatically when GitHub could not be reached at all', async () => {
    env.github.createQueue.push('refused');
    const sub = await submit();
    await env.worker.drain();
    expect(await reload(sub)).toMatchObject({ status: 'pending', error_code: 'github_unreachable' });
  });
});

describe('uncertain outcomes', () => {
  it('does not retry after a timeout; reconciles and finds the issue GitHub created', async () => {
    env.github.createQueue.push('timeout_after_create');
    const sub = await submit();
    const token = `tok-${counter}`;
    await env.worker.drain();
    const uncertain = await reload(sub);
    expect(uncertain).toMatchObject({ status: 'uncertain', error_code: 'github_timeout' });
    expect(lastEditTitle(token)).toBe('Ticket received, confirmation pending');
    expect(env.github.createCalls).toBe(1);

    await makeDue(sub);
    await env.worker.drain();
    const resolved = await reload(sub);
    expect(resolved.status).toBe('created');
    expect(resolved.issue_number).toBe(env.github.allIssues()[0]!.number);
    expect(env.github.createCalls).toBe(1);
    expect(env.github.allIssues()).toHaveLength(1);
    expect(lastEditTitle(token)).toBe('Ticket submitted');
  });

  it('treats dropped connections and 5xx responses as uncertain', async () => {
    env.github.createQueue.push('reset_after_create', { status: 502, body: { message: 'Bad Gateway' } });
    const a = await submit();
    const b = await submit();
    await env.worker.drain();
    expect((await reload(a)).status).toBe('uncertain');
    expect((await reload(b)).status).toBe('uncertain');
  });

  it('keeps checking, stops after the schedule, and leaves the decision to an admin', async () => {
    env.github.createQueue.push('timeout_before_create');
    const sub = await submit();
    await env.worker.drain();
    for (let i = 0; i < 4; i++) {
      await makeDue(sub);
      await env.worker.drain();
    }
    const stuck = await reload(sub);
    expect(stuck.status).toBe('uncertain');
    expect(stuck.reconcile_attempts).toBe(4);
    expect(stuck.next_attempt_at).toBeNull();
    expect(env.github.createCalls).toBe(1);

    const result = await env.processor.retry(ws.workspace.id, sub.id, ws.owner.user.id);
    expect(result).toBe('created');
    expect(env.github.allIssues()).toHaveLength(1);
    expect(env.github.createCalls).toBe(2);
  });

  it('admin retry checks GitHub first and never files the ticket twice', async () => {
    env.github.createQueue.push('timeout_after_create');
    const sub = await submit();
    await env.worker.drain();
    const result = await env.processor.retry(ws.workspace.id, sub.id, ws.owner.user.id);
    expect(result).toBe('found_existing');
    expect(env.github.createCalls).toBe(1);
    expect((await reload(sub)).status).toBe('created');
  });

  it('lets an admin link an issue or close the submission', async () => {
    env.github.createQueue.push('timeout_before_create', 'timeout_before_create');
    const a = await submit();
    const b = await submit();
    await env.worker.drain();
    const repo = env.github.repos.get(ws.repoIds[0]!)!;
    repo.issues.push({ number: 7, title: 'manual', body: 'filed by hand', labels: [], created_at: '', user: 'x' });
    await expect(env.processor.linkIssue(ws.workspace.id, a.id, 999, ws.owner.user.id)).rejects.toThrow(/not found/);
    await env.processor.linkIssue(ws.workspace.id, a.id, 7, ws.owner.user.id);
    expect(await reload(a)).toMatchObject({ status: 'created', issue_number: 7 });
    await env.processor.dismiss(ws.workspace.id, b.id, 'spam', ws.owner.user.id);
    expect(await reload(b)).toMatchObject({ status: 'dismissed', resolution_note: 'spam' });
  });

  it('reconciles instead of re-creating when a worker died mid-request', async () => {
    const sub = await submit();
    // Simulate a crash: the request was sent (and GitHub created the issue), then the worker vanished.
    const repo = env.github.repos.get(ws.repoIds[0]!)!;
    repo.issues.push({ number: 55, title: 't', body: `body\n${submissionMarker(sub.ref)}`, labels: [], created_at: '', user: 'ticket-relay[bot]' });
    await env.db.query(
      `UPDATE submissions SET status = 'processing', lease_owner = 'dead-worker', lease_until_at = now_ms() - 1000, github_request_started_at = now_ms() WHERE id = $1`,
      [sub.id],
    );
    await env.worker.drain();
    expect(await reload(sub)).toMatchObject({ status: 'created', issue_number: 55 });
    expect(env.github.createCalls).toBe(0);
  });
});

describe('persistence, concurrency and routing snapshots', () => {
  it('survives a restart: a new process picks up queued work', async () => {
    const sub = await submit();
    // "Restart": a brand-new app instance with its own connection and identity, same database file.
    const db2 = openDatabase(TEST_DATABASE_PATH);
    const env2 = await makeApp({ db: db2, github: env.github, discord: env.discord, instanceId: 'restarted' });
    await env2.worker.drain();
    expect(await reload(sub)).toMatchObject({ status: 'created' });
    await db2.end();
  });

  it('never processes a submission twice with several workers running', async () => {
    const subs = [];
    for (let i = 0; i < 12; i++) subs.push(await submit());
    const db2 = openDatabase(TEST_DATABASE_PATH);
    const env2 = await makeApp({ db: db2, github: env.github, discord: env.discord, instanceId: 'worker-b' });
    await Promise.all([env.worker.drain(), env.worker.drain(), env2.worker.drain(), env2.worker.drain()]);
    await db2.end();
    expect(env.github.createCalls).toBe(12);
    const refs = env.github.allIssues().map((i) => /submission=(TR-\w+)/.exec(i.body)![1]);
    expect(new Set(refs).size).toBe(12);
    const { rows } = await env.db.query(`SELECT count(*) AS n FROM submissions WHERE status = 'created'`);
    expect(rows[0].n).toBe(12);
  });

  it('does not redirect an accepted ticket when the app is remapped', async () => {
    const sub = await submit();
    const other = env.github.repos.get(ws.repoIds[1]!)!;
    await updateApp(env.db, ws.workspace.id, ws.apps[0]!.id, { name: 'Mobile App', description: null, repo: { id: other.id, owner: other.owner, name: other.name, private: other.private }, labels: [], enabled: true });
    await env.worker.drain();
    expect((await reload(sub)).repo_name).toBe('mobile');
    expect(env.github.allIssues()[0]!.repo).toMatch(/\/mobile$/);
  });

  it('keeps only the title after creation and purges stored text after the retention period', async () => {
    const sub = await submit();
    await env.worker.drain();
    const created = await reload(sub);
    expect(env.deps.box.decryptJson(created.payload_enc!)).toEqual({ title: `Problem number ${counter}` });
    await env.db.query(`UPDATE submissions SET updated_at = now_ms() - 31 * 86400000 WHERE id = $1`, [sub.id]);
    await runMaintenance(env.deps);
    const purged = await reload(sub);
    expect(purged.payload_enc).toBeNull();
    expect(purged.payload_purged_at).not.toBeNull();
  });

  it('never files a ticket twice with several worker processes on one database file', async () => {
    const total = 60;
    for (let i = 0; i < total; i++) await submit();
    const repo = env.github.repos.get(ws.repoIds[0]!)!;
    const script = path.join(__dirname, 'fixtures', 'worker-process.ts');
    const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
    const startAt = String(Date.now() + 2500);
    const outputs = await Promise.all(
      [1, 2, 3].map(() =>
        promisify(execFile)(tsx, [script, TEST_DATABASE_PATH, String(ws.installationId), JSON.stringify({ ...repo, issues: [] }), startAt], { timeout: 30_000 }),
      ),
    );
    const perProcess = outputs.map((o) => JSON.parse(o.stdout) as string[]);
    const all = perProcess.flat();
    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total);
    expect(perProcess.filter((refs) => refs.length > 0).length).toBeGreaterThan(1);
    const { rows } = await env.db.query(`SELECT count(*) AS n FROM submissions WHERE status = 'created'`);
    expect(rows[0].n).toBe(total);
  }, 40_000);
});

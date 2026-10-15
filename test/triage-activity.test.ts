import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptSubmission } from '../src/domain/submissions.js';
import { LABEL_GROUP_PRESETS, parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled } from '../src/triage/settings.js';
import { triageState } from '../src/triage/state.js';
import { form, get, makeApp, makeWorkspace, resetDb, testDb, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const issue = (num: number) => env.github.repos.get(ws.repoIds[0]!)!.issues.find((i) => i.number === num)!;
const result = async (id: string) => (await env.db.query('SELECT * FROM triage_results WHERE submission_id = $1', [id])).rows[0];
const log = async () => (await env.db.query('SELECT * FROM triage_log WHERE workspace_id = $1 ORDER BY id', [wid()])).rows;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

async function file(title = 'Export crashes the app') {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-a${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `Click export and the app closes (${n}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

async function enable(config: Record<string, unknown>) {
  await new Promise((r) => setTimeout(r, 3));
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig(config));
  await setTriageEnabled(env.db, wid(), true);
}

const inbox = (triage: string) => env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all&triage=${encodeURIComponent(triage)}`, ...get(ws.owner) });

describe('triage status', () => {
  it('tells apart applied, to review, reviewed and nothing to do', () => {
    expect(triageState({ status: 'pending', suggestion_count: 0 })).toBe('queued');
    expect(triageState({ status: 'done', suggestion_count: 1, applied_actions: [] })).toBe('review');
    expect(triageState({ status: 'done', suggestion_count: 1, applied_actions: [{}] })).toBe('partial');
    expect(triageState({ status: 'done', suggestion_count: 0, applied_actions: [{}] })).toBe('applied');
    expect(triageState({ status: 'done', suggestion_count: 0, applied_actions: [], dismissed_count: 2 })).toBe('reviewed');
    expect(triageState({ status: 'done', suggestion_count: 0, applied_actions: [] })).toBe('nothing');
    expect(triageState({ status: 'skipped', suggestion_count: 0 })).toBe('skipped');
  });

  it('shows the status in the inbox and filters by status, priority, what was flagged and labels', async () => {
    const type = { id: 'type1', mode: 'suggest', ...LABEL_GROUP_PRESETS.type };
    await enable({ threshold: 90, priority: { mode: 'auto' }, regression: { mode: 'suggest' }, spam: { mode: 'suggest' }, labelGroups: [type] });
    env.anthropic.queue.push(
      { ...env.anthropic.verdict, priority: 'high', priority_confidence: 95, labels: { type1: { options: [], confidence: 0 } } },
      { ...env.anthropic.verdict, priority: 'low', priority_confidence: 50, spam: true, spam_confidence: 60, labels: { type1: { options: ['crash'], confidence: 80 } } },
      { ...env.anthropic.verdict, priority_confidence: 50, labels: { type1: { options: [], confidence: 0 } } },
    );
    const applied = await file('Login fails');
    const review = await file('Buy followers');
    const dismissed = await file('Sync is slow');
    await env.triage.drain();
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/${dismissed.id}/triage/dismiss`, ...form(ws.owner, { kind: 'priority' }) });
    expect(await result(dismissed.id)).toMatchObject({ dismissed_count: 1, suggestion_count: 0 });

    const has = (body: string, id: string) => body.includes(`/tickets/${id}"`);
    const all = await inbox('');
    expect(all.body).toContain('Applied');
    expect(all.body).toContain('To review');
    expect(all.body).toContain('Reviewed');
    expect(all.body).toContain('<optgroup label="Flagged as">');
    expect(all.body).toContain('value="l:type1:crash"');

    // "applied" got priority automatically, and nothing else: Applied.
    const appliedList = await inbox('s:applied');
    expect(has(appliedList.body, applied.id) && !has(appliedList.body, review.id)).toBe(true);
    // Applying one of two suggestions makes it Partly applied.
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/${review.id}/triage/apply`, ...form(ws.owner, { kind: 'priority' }) });
    const partial = await inbox('s:partial');
    expect(has(partial.body, review.id) && !has(partial.body, applied.id)).toBe(true);
    expect(partial.body).toContain('Partly applied');
    // Confidence: at least one action at 90%+ (only "applied" has one, at 95%).
    const sure = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all&conf=90`, ...get(ws.owner) });
    expect(has(sure.body, applied.id) && !has(sure.body, review.id)).toBe(true);
    const leaning = await env.server.inject({ method: 'GET', url: `${w()}/tickets?status=all&conf=60&triage=s:partial`, ...get(ws.owner) });
    expect(has(leaning.body, review.id) && !has(leaning.body, applied.id)).toBe(true);
    const reviewList = await inbox('s:review');
    expect(!has(reviewList.body, review.id) && !has(reviewList.body, applied.id)).toBe(true);
    const reviewedList = await inbox('s:reviewed');
    expect(has(reviewedList.body, dismissed.id) && !has(reviewedList.body, review.id)).toBe(true);
    expect(has((await inbox('p:high')).body, applied.id)).toBe(true);
    expect(has((await inbox('f:spam')).body, review.id) && !has((await inbox('f:spam')).body, applied.id)).toBe(true);
    expect(has((await inbox('l:type1:crash')).body, review.id) && !has((await inbox('l:type1:crash')).body, dismissed.id)).toBe(true);
    // Old links still work.
    expect(has((await inbox('high')).body, applied.id)).toBe(true);

    // Tickets filed before triage was on have no result: "Not triaged".
    await setTriageEnabled(env.db, wid(), false);
    const later = await file('Later ticket');
    expect(has((await inbox('s:untriaged')).body, later.id) && !has((await inbox('s:untriaged')).body, applied.id)).toBe(true);
  });
});

describe('activity log', () => {
  it('logs what triage applied and suggested, what people applied or dismissed, and failures', async () => {
    await enable({ threshold: 90, priority: { mode: 'auto' }, spam: { mode: 'suggest', close: true } });
    env.anthropic.queue.push({ ...env.anthropic.verdict, priority: 'high', priority_confidence: 95, spam: true, spam_confidence: 60 });
    const t = await file('Buy followers');
    await env.triage.drain();
    let entries = await log();
    expect(entries).toEqual([expect.objectContaining({ source: 'ticket', result: 'ok', submission_id: t.id })]);
    expect(entries[0].detail.applied).toEqual([expect.objectContaining({ kind: 'priority' })]);
    expect(entries[0].detail.suggested).toEqual([expect.objectContaining({ kind: 'spam' })]);

    // GitHub refuses the first try.
    env.github.failRequests.push({ match: /^POST .*\/issues\/\d+\/labels$/, status: 502, message: 'Bad gateway' });
    const res = await env.server.inject({ method: 'POST', url: `${w()}/tickets/${t.id}/triage/apply`, ...form(ws.owner, { kind: 'spam' }) });
    expect(res.statusCode).toBe(302);
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/${t.id}/triage/apply`, ...form(ws.owner, { kind: 'spam' }) });
    expect(issue(t.issue_number).labels).toEqual(['priority: high', 'spam']);
    entries = await log();
    expect(entries.slice(1).map((e) => [e.source, e.result, e.by_user])).toEqual([['review', 'failed', ws.owner.user.id], ['review', 'ok', ws.owner.user.id]]);
    expect(entries[1].message).toContain('Bad gateway');

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/activity`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Right now');
    expect(page.body).toContain('Applied on GitHub:');
    expect(page.body).toContain('Bad gateway');
    const failed = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/activity?result=failed`, ...get(ws.owner) });
    expect(failed.body).toContain('Bad gateway');
    expect(failed.body).not.toContain('Applied on GitHub:');
    const partial = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/activity?partial=1`, ...get(ws.owner) });
    expect(partial.headers['x-live-partial']).toBe('1');
  });

  it('logs a re-run from start to applied, with its own filter', async () => {
    const t = await file('Login fails');
    await enable({ priority: { mode: 'suggest' } });
    const start = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { never: '1', untouched: '1', count: 'all', mode: 'preview', name: 'Try' }) });
    const runId = String(start.headers.location).split('/').pop()!;
    await env.triage.drain();
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs/${runId}/apply`, ...form(ws.owner, { scope: 'filter', show: 'all', include: 'inbox' }) });
    await env.triage.drain();
    const entries = (await log()).filter((e) => e.run_id === runId);
    expect(entries.map((e) => [e.source, e.result])).toEqual([['preview', 'info'], ['preview', 'ok'], ['rerun', 'info'], ['rerun', 'ok']]);
    expect(entries[0].message).toContain('Re-run started (preview): 1 queued');
    expect(entries[2].message).toContain('to the inbox only');
    expect(entries[3]).toMatchObject({ submission_id: t.id });
    expect(entries[3].detail.inbox).toBe(true);

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/activity?run=${runId}`, ...get(ws.owner) });
    expect(page.body).toContain('Showing <a');
    expect(page.body).toContain('Added to the inbox as suggestions:');
    const run = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/${runId}`, ...get(ws.owner) });
    expect(run.body).toContain(`/tickets/triage/activity?run=${runId}`);
  });
});

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepos } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { writeTriageLog, type TriageAction } from '../src/triage/engine.js';
import { parseTriageConfig, pauseTriage, saveTriageConfig, setApiKey, setGitHubTriageEnabled, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let mod: Admin;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
const page = (url: string, who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string | string[]>, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const kinds = async (submissionId: string) => ((await env.db.query('SELECT suggestions FROM triage_results WHERE submission_id = $1', [submissionId])).rows[0].suggestions ?? []).map((a: { kind: string }) => a.kind);
const issueKinds = async (number: number) => ((await env.db.query('SELECT suggestions FROM issue_triage WHERE number = $1', [number])).rows[0].suggestions ?? []).map((a: { kind: string }) => a.kind);
/** The message a POST leaves for the next page. */
function flash(res: LightMyRequestResponse): string {
  const cookie = [res.headers['set-cookie']].flat().find((c) => String(c).startsWith('tr_flash='));
  return cookie ? JSON.parse(Buffer.from(String(cookie).slice('tr_flash='.length).split(';')[0]!, 'base64url').toString('utf8')).message : '';
}
/** Every link on a page to this workspace. */
const workspaceLinks = (body: string) => [...new Set([...body.matchAll(/href="(\/w\/[^"]+)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&')))];
/** A number in the stats strip. */
const statOf = (body: string, label: string) => new RegExp(`${label}</div><div class="v(?: accent)?">([\\d,]+)</div><div class="sub">([^<]*)</div>`).exec(body)?.slice(1);

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

async function file(title: string) {
  n++;
  const r = await acceptSubmission(env.deps, {
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-rv${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `Something happens (${n}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return (await env.db.query('SELECT id, issue_number FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
}

/**
 * Three tickets (spam suggested at 85% and 70%, and one that isn't spam) and an issue opened on
 * GitHub (spam at 85%); each also has a medium priority suggestion.
 */
async function setup() {
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'suggest' }, spam: { mode: 'suggest', close: true }, githubModes: { spam: 'suggest', priority: 'suggest' } }));
  await setTriageEnabled(env.db, wid(), true);
  await setGitHubTriageEnabled(env.db, wid(), true);
  await new Promise((r) => setTimeout(r, 5));
  env.anthropic.queue.push(
    { ...env.anthropic.verdict, spam: true, spam_confidence: 85 },
    { ...env.anthropic.verdict, spam: true, spam_confidence: 70 },
    { ...env.anthropic.verdict },
  );
  const sure = await file('Buy followers');
  const unsure = await file('Cheap stuff maybe');
  const real = await file('Export crashes');
  await env.triage.drain();
  repo().issues.push({ number: 700, title: 'Win a prize', body: 'Click here.', labels: [], created_at: new Date().toISOString(), user: 'someone' });
  await ensureRepos(env.db);
  await env.triage.engine.indexer.sync(ws.repoIds[0]!, { pages: 5, fullCheck: false });
  env.anthropic.queue.push({ ...env.anthropic.verdict, spam: true, spam_confidence: 85 });
  await env.triage.drain();
  return { sure, unsure, real };
}

describe('AI triage › Review', () => {
  it('lists every ticket and issue with suggestions waiting, with real numbers', async () => {
    const { sure, unsure, real } = await setup();
    const res = await page('/triage');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div class="page full">');
    expect(res.body).not.toMatch(/style="/);
    // The numbers above the list.
    expect(statOf(res.body, 'To review')).toEqual(['4', 'oldest just now']);
    expect(statOf(res.body, 'Waiting for triage')).toEqual(['0', 'nothing waiting']);
    expect(statOf(res.body, 'Applied this week')).toEqual(['0', '0 automatic · 0 by your team']);
    expect(statOf(res.body, 'Dismissed this week')).toEqual(['0', 'nothing changed on GitHub']);
    // Sources, with how many wait in each.
    expect(res.body).toContain(`<a class="seg-item" href="${w()}/triage" aria-current="true">All sources<span class="n">4</span></a>`);
    expect(res.body).toContain(`href="${w()}/triage?source=discord" >`);
    expect(res.body).toContain('Discord tickets<span class="n">3</span></a>');
    expect(res.body).toContain(`href="${w()}/triage?source=github" >`);
    expect(res.body).toContain('GitHub issues<span class="n">1</span></a>');
    // One row each, linking to the ticket or the issue, with its source.
    for (const t of [sure, unsure, real]) {
      expect(res.body).toContain(`<a class="rv-title" href="${w()}/tickets/${t.id}" >`);
      expect(res.body).toContain(`value="sub:${t.id}" form="bulk-triage" data-match`);
      expect(res.body).toContain(`action="${w()}/tickets/${t.id}/triage/apply"`);
    }
    expect(res.body).toContain(`<a class="rv-title" href="${w()}/issues/${ws.repoIds[0]}/700" >Win a prize</a>`);
    expect(res.body).toContain(`value="gh:${ws.repoIds[0]}:700" form="bulk-triage" data-match`);
    expect(res.body).toContain(`action="${w()}/issues/${ws.repoIds[0]}/700/triage/dismiss"`);
    expect(res.body).toContain('<span class="tag subtle rv-src" >');
    expect(res.body).toContain('Discord ticket</span>');
    expect(res.body).toContain('Opened on GitHub</span>');
    expect(res.body).toContain(`mobile#${sure.issue_number} · Member 1`);
    // Each suggestion: what it is, what Apply does on GitHub, how sure Claude is.
    expect(res.body).toContain('<span class="t">Spam</span><span class="eff" title="What Apply does on GitHub"> · adds “spam”');
    expect(res.body).toMatch(/ · adds “spam”[^<]*closes the issue<\/span><\/span>\s*<span class="rv-conf" title="Claude’s confidence">85%<\/span>/);
    expect(res.body).toContain('<span class="rv-conf" title="Claude’s confidence">70%</span>');
    expect(res.body).toContain('Each suggestion says what applying it does on GitHub.');
    expect(res.body).toContain('4 tickets and issues');
    // Apply and Dismiss come back here.
    expect(res.body).toContain(`<input type="hidden" name="back" value="${w()}/triage">`);
    // Bulk Apply and Dismiss for the whole list.
    expect(res.body).toContain('<input type="hidden" name="from" value="review">');
    expect(res.body).toContain('Select tickets or issues to apply or dismiss every waiting suggestion.');
    expect(res.body).toContain('<span class="bulk-lead"><input type="checkbox" class="rule-check" data-select-all="bulk-triage"');
    expect(res.body).toContain('data-selected-plain');
    expect(res.body).not.toContain('Page 1 of');
  });

  it('filters by source, by what was flagged and by confidence, and says when nothing matches', async () => {
    const { sure, unsure, real } = await setup();
    const spam = await page('/triage?f=f:spam&conf=80');
    expect(spam.body).toContain(sure.id);
    expect(spam.body).toContain('Win a prize');
    expect(spam.body).not.toContain(unsure.id);
    expect(spam.body).not.toContain(real.id);
    expect(spam.body).toContain(`href="${w()}/triage?f=f%3Aspam&amp;conf=80" aria-current="true">All sources<span class="n">2</span>`);
    expect(spam.body).toContain(`href="${w()}/triage?source=github&amp;f=f%3Aspam&amp;conf=80" >`);
    expect(spam.body).toContain('Discord tickets<span class="n">1</span>');
    expect(spam.body).toContain('GitHub issues<span class="n">1</span>');
    expect(spam.body).toContain('<option value="f:spam" selected>Spam</option>');
    expect(spam.body).toContain('<option value="80" selected>Confidence 80%+</option>');
    // The numbers above stay for everything.
    expect(statOf(spam.body, 'To review')?.[0]).toBe('4');
    // The priority suggestions on these rows aren't in the filter: bulk Apply leaves them.
    expect(spam.body).toContain('class="rv-sugg off" title="Not in this filter: bulk Apply and Dismiss leave it."');
    expect(spam.body).toContain('<input type="hidden" name="f" value="f:spam"><input type="hidden" name="conf" value="80">');
    expect(spam.body).toContain('data-confirm-title="Apply “Spam” suggestions at 80%+ confidence?"');
    expect(spam.body).toContain(`<input type="hidden" name="back" value="${w()}/triage?f=f%3Aspam&amp;conf=80">`);
    expect(spam.body).toContain('>Clear</span></a>');

    const github = await page('/triage?source=github');
    expect(github.body).toContain('Win a prize');
    expect(github.body).not.toContain(sure.id);
    expect(github.body).toMatch(/aria-current="true"><span class="ic[^"]*"[^>]*><svg[^]*?<\/svg><\/span>GitHub issues<span class="n">1<\/span>/);
    expect(github.body).toContain('<input type="hidden" name="source" value="github">');

    const none = await page('/triage?source=github&f=f:spam&conf=90');
    expect(none.body).toContain('Nothing matches these filters');
    expect(none.body).toContain('No “Spam” suggestions at 90%+ confidence are waiting in GitHub issues right now.');
    expect(none.body).toMatch(new RegExp(`href="${w()}/triage\\?source=github"\\s*><span class="lbl">Clear filters</span>`));
    expect(none.body).not.toContain('form="bulk-triage"');

    const lowConf = await page('/triage?conf=90');
    expect(lowConf.body).toContain('No suggestions at 90%+ confidence are waiting right now.');

    // Status filters and unknown values don't apply here.
    const ignored = await page('/triage?f=s:review&conf=55&source=elsewhere');
    expect(ignored.body).toContain('All sources<span class="n">4</span>');
    expect(ignored.body).not.toContain('>Clear</span></a>');
  });

  it('applies and dismisses in bulk from Review, on what was picked or everything in the list', async () => {
    const { sure, unsure, real } = await setup();
    const back = `${w()}/triage?f=f%3Aspam&conf=80`;
    const apply = await post('/triage/bulk', { from: 'review', op: 'apply', all: '1', f: 'f:spam', conf: '80', back });
    expect(apply.statusCode).toBe(302);
    expect(apply.headers.location).toBe(back);
    expect(flash(apply)).toBe('Applying “Spam” suggestions at 80%+ confidence on 2 tickets and issues. Progress is shown above the list.');
    // Worked out again from the filters: the 85% ticket and the issue, not the 70% one.
    const items = (await env.db.query('SELECT subject FROM triage_bulk_items ORDER BY position')).rows.map((r) => r.subject);
    expect(items.sort()).toEqual([`gh:${ws.repoIds[0]}:700`, `sub:${sure.id}`].sort());
    await env.triage.drain();
    expect(issue(sure.issue_number).labels).toEqual(['spam']);
    expect(issue(sure.issue_number).state).toBe('closed');
    expect(issue(700).labels).toEqual(['spam']);
    expect(issue(unsure.issue_number).labels).toEqual([]);
    expect(await kinds(sure.id)).toEqual(['priority']);
    expect(await kinds(unsure.id)).toEqual(['spam', 'priority']);

    // Dismiss everything in one source with a filter: the medium priority on Discord tickets.
    const dismiss = await post('/triage/bulk', { from: 'review', op: 'dismiss', all: '1', source: 'discord', f: 'p:medium', back: `${w()}/triage?source=discord` });
    expect(dismiss.headers.location).toBe(`${w()}/triage?source=discord`);
    expect(flash(dismiss)).toBe('Dismissed 3 suggestions on 3 tickets and issues.');
    expect(await kinds(sure.id)).toEqual([]);
    expect(await kinds(unsure.id)).toEqual(['spam']);
    expect(await kinds(real.id)).toEqual([]);
    expect(await issueKinds(700)).toEqual(['priority']);

    // Picked one by one, without a filter: every waiting suggestion on them.
    const picked = await post('/triage/bulk', { from: 'review', op: 'dismiss', ticket: [`sub:${unsure.id}`, `gh:${ws.repoIds[0]}:700`], back: `${w()}/triage` });
    expect(flash(picked)).toBe('Dismissed 2 suggestions on 2 tickets and issues.');
    expect(await kinds(unsure.id)).toEqual([]);
    expect(await issueKinds(700)).toEqual([]);

    // Nothing left: the list says so, and the numbers add up.
    const empty = await post('/triage/bulk', { from: 'review', op: 'apply', all: '1', back: `${w()}/triage` });
    expect(flash(empty)).toBe('Nothing in this list has a suggestion waiting any more.');
    const after = await page('/triage');
    expect(after.body).toContain('Nothing to review');
    expect(statOf(after.body, 'To review')).toEqual(['0', 'all caught up']);
    expect(statOf(after.body, 'Applied this week')).toEqual(['2', '0 automatic · 2 by your team']);
    expect(statOf(after.body, 'Dismissed this week')?.[0]).toBe('5');

    // Off-site or unknown "back": the Review list.
    const offsite = await post('/triage/bulk', { from: 'review', op: 'dismiss', ticket: [`sub:${sure.id}`], back: 'https://evil.example/triage' });
    expect(offsite.headers.location).toBe(`${w()}/triage`);
  });

  it('applies and dismisses one suggestion at a time, then comes back to the same list', async () => {
    const { sure, unsure } = await setup();
    const back = `${w()}/triage?source=discord&f=f%3Aspam&page=1`;
    const applied = await post(`/tickets/${sure.id}/triage/apply`, { kind: 'spam', back });
    expect(applied.statusCode).toBe(302);
    expect(applied.headers.location).toBe(back);
    expect(flash(applied)).toBe('Applied on GitHub and closed the issue');
    expect(issue(sure.issue_number).labels).toEqual(['spam']);

    const dismissed = await post(`/issues/${ws.repoIds[0]}/700/triage/dismiss`, { kind: 'priority', back: `${w()}/triage?source=github` });
    expect(dismissed.headers.location).toBe(`${w()}/triage?source=github`);
    expect(await issueKinds(700)).toEqual(['spam']);
    const issueApplied = await post(`/issues/${ws.repoIds[0]}/700/triage/apply`, { kind: 'spam', back: `${w()}/triage` });
    expect(issueApplied.headers.location).toBe(`${w()}/triage`);
    expect(issue(700).labels).toEqual(['spam']);

    // Without "back", as from the ticket or issue page: back there.
    expect((await post(`/tickets/${unsure.id}/triage/dismiss`, { kind: 'priority' })).headers.location).toBe(`${w()}/tickets/${unsure.id}`);

    const stats = await page('/triage');
    expect(statOf(stats.body, 'Applied this week')).toEqual(['2', '0 automatic · 2 by your team']);
    expect(statOf(stats.body, 'Dismissed this week')?.[0]).toBe('2');
  });

  it('never sends "back" off the site or to another workspace', async () => {
    const { sure } = await setup();
    const other = await makeWorkspace(env, { owner: ws.owner });
    const unsafe = [
      'https://evil.example/w',
      '//evil.example/w',
      '/\\evil.example/w',
      '\\\\evil.example',
      'javascript:alert(1)',
      `/w/${other.workspace.id}/triage`,
      `${w()}/../${other.workspace.id}/triage`,
      `${w()}/%2e%2e/${other.workspace.id}/triage`,
      `${w()}x/triage`,
      '',
    ];
    for (const back of unsafe) {
      const ticket = await post(`/tickets/${sure.id}/triage/dismiss`, { kind: 'nothing-waiting', back });
      expect(ticket.headers.location, back).toBe(`${w()}/tickets/${sure.id}`);
      const gh = await post(`/issues/${ws.repoIds[0]}/700/triage/dismiss`, { kind: 'nothing-waiting', back });
      expect(gh.headers.location, back).toBe(`${w()}/issues/${ws.repoIds[0]}/700`);
    }
    // Any page of this workspace is fine, normalized.
    expect((await post(`/tickets/${sure.id}/triage/dismiss`, { kind: 'nothing-waiting', back: `${w()}/tickets/./x/../?status=all` })).headers.location).toBe(`${w()}/tickets/?status=all`);
  });

  it('counts what triage applied by itself this week from the activity log', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await setTriageEnabled(env.db, wid(), true);
    const action: TriageAction = { kind: 'spam', label: 'spam', close: true, confidence: 90 };
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'ticket', result: 'ok', detail: { applied: [action, { ...action, kind: 'priority', priority: 'high' }], suggested: [action] } });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'rerun', result: 'ok', detail: { applied: [action] } });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'review', result: 'ok', detail: { applied: [action] } });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'review', result: 'ok', detail: { dismissed: [action, action] } });
    // Not counted: a preview, a failure, and anything older than a week.
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'preview', result: 'ok', detail: { auto: [action] } });
    await writeTriageLog(env.db, { workspaceId: wid(), source: 'review', result: 'failed', detail: { suggested: [action] } });
    await env.db.query(`INSERT INTO triage_log (workspace_id, at, source, result, detail) VALUES ($1, $2, 'github', 'ok', $3)`, [wid(), new Date(Date.now() - 8 * 86_400_000), { applied: [action] }]);
    const res = await page('/triage');
    expect(statOf(res.body, 'Applied this week')).toEqual(['4', '3 automatic · 1 by your team']);
    expect(statOf(res.body, 'Dismissed this week')?.[0]).toBe('2');
    expect(res.body).toContain('Nothing to review');
    expect(res.body).toContain('When Claude suggests something for a new ticket or an issue opened on GitHub');
  });

  it('shows 50 a page, newest first', async () => {
    await setTriageEnabled(env.db, wid(), true);
    const now = Date.now();
    for (let i = 1; i <= 51; i++) {
      await env.db.query(
        `INSERT INTO issue_triage (id, workspace_id, repo_id, number, status, suggestions, suggestion_count, completed_at) VALUES ($1, $2, $3, $4, 'done', $5, 1, $6)`,
        [randomUUID(), wid(), ws.repoIds[0], 1000 + i, [{ kind: 'spam', label: 'spam', close: false, confidence: 90 }], new Date(now - i * 60_000)],
      );
    }
    const first = await page('/triage');
    expect(first.body).toContain('Page 1 of 2 · 51 tickets and issues');
    expect(first.body).toContain(`href="${w()}/triage?page=2"`);
    expect(first.body).toContain('Issue #1001');
    expect(first.body).toContain('Issue #1050');
    expect(first.body).not.toContain('Issue #1051');
    expect(first.body.indexOf('Issue #1001')).toBeLessThan(first.body.indexOf('Issue #1002'));
    // The bulk bar offers the whole list.
    expect(first.body).toContain('Select all 51 in this list');
    const second = await page('/triage?page=2');
    expect(second.body).toContain('Issue #1051');
    expect(second.body).not.toContain('Issue #1001<');
    expect(second.body).toMatch(new RegExp(`href="${w()}/triage"\\s*><span class="lead">.*Previous`));
    // Past the end (say the last ones were just dismissed): the last page.
    const beyond = await page('/triage?page=5');
    expect(beyond.statusCode).toBe(302);
    expect(beyond.headers.location).toBe(`${w()}/triage?page=2`);
  });

  it('says why nothing new comes in while triage is off or paused', async () => {
    const off = await page('/triage');
    expect(off.body).toContain('Nothing to review');
    expect(off.body).toContain('AI triage is off.');
    expect(statOf(off.body, 'Waiting for triage')).toEqual(['0', 'triage is off']);

    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await setTriageEnabled(env.db, wid(), true);
    await pauseTriage(env.db, wid(), 'credits', null);
    const paused = await page('/triage');
    // The page's own notice (the corner alert leaves it out here).
    expect(paused.body).toContain('id="triage-paused"');
    expect(paused.body).toContain('The Anthropic account is out of credits.');
    expect(paused.body).toContain('Nothing new is suggested while AI triage is paused.');
    expect(paused.body).toContain(`<a class="btn ghost" href="${w()}/triage/actions"`);
    expect(statOf(paused.body, 'Waiting for triage')).toEqual(['0', 'paused']);
  });
});

describe('Review for moderators', () => {
  it('View shows the queue without its controls; Edit can apply and dismiss', async () => {
    const { sure } = await setup();
    // Only Activity: Review sends them there.
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view' });
    const elsewhere = await page('/triage', mod);
    expect(elsewhere.statusCode).toBe(302);
    expect(elsewhere.headers.location).toBe(`${w()}/triage/activity`);

    await grant(env, wid(), mod.user.id, { 'triage.review': 'view' });
    const view = await page('/triage', mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('title="You can see the suggestions. Applying and dismissing them needs Edit on Review.');
    expect(view.body).toContain('Buy followers');
    expect(view.body).toContain('85%');
    expect(view.body).not.toContain('form="bulk-triage"');
    expect(view.body).not.toContain('data-select-all');
    expect(view.body).not.toContain('/triage/apply"');
    expect(view.body).not.toContain('/triage/dismiss"');
    expect(view.body).not.toContain('/triage/bulk"');
    // Without a GitHub issues page, the issue opens on GitHub.
    expect(view.body).not.toContain(`href="${w()}/issues/${ws.repoIds[0]}/700"`);
    expect(view.body).toContain('target="_blank" rel="noopener noreferrer">Win a prize<span class="rv-ext" title="Opens on GitHub">');
    expect(view.body).not.toMatch(/style="/);
    // The server says no too.
    expect((await post('/triage/bulk', { from: 'review', op: 'dismiss', ticket: [`sub:${sure.id}`] }, mod)).statusCode).toBe(403);
    expect((await post(`/tickets/${sure.id}/triage/apply`, { kind: 'spam', back: `${w()}/triage` }, mod)).statusCode).toBe(403);
    expect((await post(`/issues/${ws.repoIds[0]}/700/triage/dismiss`, { kind: 'spam' }, mod)).statusCode).toBe(403);
    expect(await kinds(sure.id)).toEqual(['spam', 'priority']);

    await grant(env, wid(), mod.user.id, { 'triage.review': 'edit', 'issues-github': 'view' });
    const edit = await page('/triage', mod);
    expect(edit.body).not.toContain('View only');
    expect(edit.body).toContain(`value="sub:${sure.id}" form="bulk-triage" data-match`);
    expect(edit.body).toContain(`action="${w()}/tickets/${sure.id}/triage/apply"`);
    expect(edit.body).toContain(`<a class="rv-title" href="${w()}/issues/${ws.repoIds[0]}/700" >Win a prize</a>`);
    const applied = await post(`/tickets/${sure.id}/triage/apply`, { kind: 'spam', back: `${w()}/triage` }, mod);
    expect(applied.headers.location).toBe(`${w()}/triage`);
    expect(issue(sure.issue_number).labels).toEqual(['spam']);
    const bulk = await post('/triage/bulk', { from: 'review', op: 'dismiss', all: '1', source: 'github', back: `${w()}/triage?source=github` }, mod);
    expect(bulk.headers.location).toBe(`${w()}/triage?source=github`);
    expect(await issueKinds(700)).toEqual([]);
  });
});

describe('Issue links for people without a GitHub issues page', () => {
  it('Activity and Re-run link an issue to GitHub instead, and every link on them opens', async () => {
    await setup();
    const repoId = ws.repoIds[0]!;
    const { repo_owner: owner, repo_name: name } = ws.apps[0]!;
    const run = await post('/triage/runs', { source: 'github', untouched: '1', count: 'all', mode: 'preview' });
    expect(run.headers.location).toMatch(/\/triage\/runs\/[0-9a-f-]{36}$/);
    const runPage = (who: Admin) => env.server.inject({ method: 'GET', url: run.headers.location as string, ...get(who) });

    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view', 'triage.runs': 'view' });
    const activity = await page('/triage/activity', mod);
    const results = await runPage(mod);
    for (const res of [activity, results]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(`href="${w()}/issues/${repoId}/700"`);
      for (const href of workspaceLinks(res.body)) {
        expect((await env.server.inject({ method: 'GET', url: href, ...get(mod) })).statusCode, href).not.toBe(403);
      }
    }
    expect(activity.body).toContain(`<a class="cell-title" href="https://github.com/${owner}/${name}/issues/700" target="_blank" rel="noopener noreferrer">Win a prize<span class="rv-ext" title="Opens on GitHub">`);
    expect(results.body).toContain('<span class="cell-title">Win a prize</span>');

    // With a GitHub issues page, the issue's own page.
    await grant(env, wid(), mod.user.id, { 'triage.activity': 'view', 'triage.runs': 'view', 'issues-github': 'view' });
    expect((await page('/triage/activity', mod)).body).toContain(`<a class="cell-title" href="${w()}/issues/${repoId}/700">Win a prize</a>`);
    expect((await runPage(mod)).body).toContain(`<a class="cell-title" href="${w()}/issues/${repoId}/700">Win a prize</a>`);
    expect((await page(`/issues/${repoId}/700`, mod)).statusCode).toBe(200);
  });
});

describe('Issues from a removed app', () => {
  it('leave Review, the badge and Opened on GitHub', async () => {
    await setup();
    expect((await page('/triage')).body).toContain('title="4 to review"');
    expect((await page('/issues/github?show=all')).body).toContain('Win a prize');

    expect((await post(`/apps/${ws.apps[0]!.id}/delete`, {})).statusCode).toBe(302);
    const res = await page('/triage');
    expect(statOf(res.body, 'To review')?.[0]).toBe('3');
    expect(res.body).toContain('title="3 to review"');
    expect(res.body).not.toContain('Win a prize');
    expect(res.body).not.toContain(`gh:${ws.repoIds[0]}:700`);
    expect((await page('/issues/github?show=all')).body).not.toContain('Win a prize');
    // Everything in the list can still be acted on, one at a time or in bulk.
    expect(await issueKinds(700)).toEqual(['spam', 'priority']);
  });
});

describe('Empty states for View only', () => {
  it('don’t ask people to do what they can’t', async () => {
    await grant(env, wid(), mod.user.id, { 'triage.review': 'view', 'triage.actions': 'view', 'triage.runs': 'view' });
    const review = await page('/triage', mod);
    expect(review.body).toContain(`AI triage is off. An admin can turn it on in <a href="${w()}/triage/actions">Actions</a>.`);
    expect(review.body).not.toContain('Turn it on in');
    const runs = await page('/triage/runs', mod);
    expect(runs.body).toContain('Re-runs your team starts show up here, with their results.');
    expect(runs.body).not.toContain('Start a preview above');
    // The owner can do both.
    expect((await page('/triage')).body).toContain(`AI triage is off. Turn it on in <a href="${w()}/triage/actions">Actions</a>`);
    expect((await page('/triage/runs')).body).toContain('Start a preview above');
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite, setModeratorTriageAccess } from '../src/domain/workspaces.js';
import { getTriageSettings, parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

const KEY = 'sk-ant-test-key-0123456789abcdef';
/** What Anthropic answers when the account is empty: a 400, not a 402. */
const NO_CREDITS = { status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' };

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const wid = () => ws.workspace.id;
const w = () => `/w/${ws.workspace.id}`;
const alerts = (who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}/alerts`, ...get(who) });
const paused = async () => (await getTriageSettings(env.db, wid())).paused;
const log = async () => (await env.db.query(`SELECT result, message, by_user FROM triage_log WHERE workspace_id = $1 AND source = 'system' ORDER BY id`, [wid()])).rows;
/** Moves the pause (and its last check) back in time, as if minutes had passed. */
const age = (minutes: number) => env.db.query('UPDATE triage_settings SET paused_at = paused_at - $2, paused_checked_at = paused_checked_at - $2 WHERE workspace_id = $1', [wid(), minutes * 60_000]);

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
    workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-al${n}`, interactionToken: null,
    guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r${n}`, displayName: `Member ${n}`, username: `member${n}` },
    title, description: `Click export and the app closes (${n}).`, ticketType: null,
  });
  if (r.kind !== 'accepted') throw new Error(r.kind);
  await env.worker.drain();
  return r.submission;
}

async function runOutOfCredits() {
  await new Promise((r) => setTimeout(r, 3));
  await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
  await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'suggest' } }));
  await setTriageEnabled(env.db, wid(), true);
  env.anthropic.queue.push(NO_CREDITS);
  const t = await file();
  await env.triage.drain();
  return t;
}

describe('when Claude stops', () => {
  it('pauses on an empty account, says so in Activity, and every page shows it in the corner', async () => {
    await runOutOfCredits();
    const p = await paused();
    expect(p).toMatchObject({ reason: 'credits', detail: 'The Anthropic account is out of credits.' });
    expect(await log()).toEqual([{ result: 'failed', message: 'Paused: The Anthropic account is out of credits.', by_user: null }]);

    // Every page has the corner panel; app.js loads it.
    const inbox = await env.server.inject({ method: 'GET', url: `${w()}/tickets`, ...get(ws.owner) });
    expect(inbox.body).toContain(`id="alert-dock" data-dock-src="${w()}/alerts"`);
    const res = await alerts();
    expect(res.headers['x-live-partial']).toBe('1');
    expect(res.body).toContain(`data-alert-id="triage-paused:${p!.at.getTime()}:credits"`);
    expect(res.body).toContain('AI triage is paused');
    expect(res.body).toContain('The Anthropic account is out of credits. Tickets are still filed as usual; nothing is triaged until it’s fixed.');
    expect(res.body).toContain('Waiting: 1 Discord ticket');
    expect(res.body).toContain('Checks again every 5 minutes and carries on by itself');
    expect(res.body).toContain(`action="${w()}/tickets/triage/resume"`);
    expect(res.body).toContain('href="https://console.anthropic.com/settings/billing"');
    // The Triage page has its own notice, which the corner panel leaves out there.
    expect(res.body).toContain('data-inline="triage-paused"');
    expect((await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage`, ...get(ws.owner) })).body).toContain('id="triage-paused"');
  });

  it('checks again every 5 minutes and carries on by itself once credits are added', async () => {
    const t = await runOutOfCredits();
    const first = await paused();
    // Not due yet.
    expect(await env.triage.engine.checkPaused()).toEqual([]);

    // Still empty: stays paused, same alert (so a dismissed one stays dismissed).
    await age(6);
    env.anthropic.queue.push(NO_CREDITS);
    const [still] = await env.triage.engine.checkPaused();
    expect(still).toMatchObject({ resumed: false, reason: 'credits' });
    const again = await paused();
    expect(again!.at.getTime()).toBe(first!.at.getTime() - 6 * 60_000);
    expect(again!.checkedAt).not.toBeNull();
    expect(env.anthropic.requests.at(-1)!.body).toMatchObject({ max_tokens: 1 });

    // Credits added: the next check carries on, and the waiting ticket is triaged.
    await age(6);
    const [ok] = await env.triage.engine.checkPaused();
    expect(ok).toMatchObject({ resumed: true });
    expect(await paused()).toBeNull();
    expect((await log()).at(-1)).toMatchObject({ result: 'ok', message: 'Claude works again, so triage carried on by itself.' });
    await env.triage.drain();
    expect((await env.db.query('SELECT status FROM triage_results WHERE submission_id = $1', [t.id])).rows[0].status).toBe('done');
    expect((await alerts()).body).toBe('');
  });

  it('Try again asks Claude first and says what it found', async () => {
    await runOutOfCredits();
    const tryAgain = () => env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/resume`, headers: { ...form(ws.owner).headers, accept: 'application/json' }, payload: new URLSearchParams({ _csrf: ws.owner.csrf }).toString() });
    env.anthropic.queue.push(NO_CREDITS);
    expect((await tryAgain()).json()).toEqual({ ok: false, error: 'Still paused: The Anthropic account is out of credits.' });
    expect(await paused()).not.toBeNull();
    expect((await tryAgain()).json()).toEqual({ ok: true, message: 'Claude works again, so triage carried on.' });
    expect(await paused()).toBeNull();
    expect((await log()).at(-1)).toMatchObject({ result: 'ok', message: 'Claude works again, so triage carried on.', by_user: ws.owner.user.id });
  });

  it('older pauses that saved the credit error as "rejected" are checked too', async () => {
    await runOutOfCredits();
    await env.db.query(`UPDATE triage_settings SET paused_reason = 'rejected', paused_detail = 'Your credit balance is too low to access the Anthropic API.' WHERE workspace_id = $1`, [wid()]);
    expect((await alerts()).body).toContain('The Anthropic account is out of credits.');
    await age(6);
    expect((await env.triage.engine.checkPaused())[0]).toMatchObject({ resumed: true });
  });

  it('tells moderators who can see triage, without the buttons they can’t use', async () => {
    await runOutOfCredits();
    const mod = await makeAdmin(env, 'mia');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, wid(), ws.owner.user.id, 'moderator')}`, ...form(mod) });
    expect((await alerts(mod)).body).toBe('');
    await setModeratorTriageAccess(env.db, wid(), mod.user.id, { activity: 'view' });
    const body = (await alerts(mod)).body;
    expect(body).toContain('AI triage is paused');
    expect(body).toContain('An admin needs to add credits.');
    expect(body).not.toContain('/tickets/triage/resume');
    expect(body).not.toContain('console.anthropic.com');
    expect(body).toContain(`href="${w()}/tickets/triage/activity"`);
  });

  it('also when this month’s limit is reached, or the triage worker stops', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'suggest' }, monthlyLimit: 1 }));
    await setTriageEnabled(env.db, wid(), true);
    expect((await alerts()).body).toBe('');
    await file();
    await env.triage.drain();
    const limit = (await alerts()).body;
    expect(limit).toContain('AI triage stopped for this month');
    expect(limit).toContain('It reached this month’s limit of 1 tickets');
    expect(limit).toContain(`href="${w()}/tickets/triage#limits"`);

    await env.db.query(`INSERT INTO process_status (id, role, pid, rss_bytes, heap_bytes, started_at, seen_at) VALUES ('t1', 'triage', 1, 1, 1, now_ms() - 3600000, now_ms() - 300000)`);
    const down = (await alerts()).body;
    expect(down).toContain('The triage worker isn’t running');
    expect(down).toContain('Check pm2 status on the server.');
    expect(down).toContain('data-dock-count');
  });

  it('shows the pause on a re-run that waits for it', async () => {
    await setApiKey(env.db, env.deps.box, wid(), KEY, ws.owner.user.id);
    await saveTriageConfig(env.db, wid(), parseTriageConfig({ priority: { mode: 'suggest' } }));
    await setTriageEnabled(env.db, wid(), true);
    await file();
    await env.triage.drain();
    const start = await env.server.inject({ method: 'POST', url: `${w()}/tickets/triage/runs`, ...form(ws.owner, { never: '1', untouched: '1', mode: 'preview' }) });
    expect(start.statusCode).toBe(302);
    env.anthropic.queue.push(NO_CREDITS);
    await env.triage.drain();
    expect((await paused())?.reason).toBe('credits');
    const run = (await env.db.query('SELECT id FROM triage_runs')).rows[0];
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/triage/runs/${run.id}`, ...get(ws.owner) });
    expect(page.body).toContain('Paused: the Anthropic account is out of credits. It carries on by itself once credits are added');
    expect((await alerts()).body).toContain('the re-run “Preview” (');
  });
});

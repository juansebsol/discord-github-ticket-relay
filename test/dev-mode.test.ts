import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDevMode, setDevMode } from '../src/domain/dev-mode.js';
import { healthView } from '../src/domain/health.js';
import { createInvite, setModeratorPermissions } from '../src/domain/workspaces.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let n = 0;
const w = () => `/w/${ws.workspace.id}`;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

/** A worker process that stopped reporting `minutesAgo` minutes ago (a restart, crash or deploy). */
async function stopped(minutesAgo: number) {
  n++;
  await env.db.query(`INSERT INTO process_status (id, role, pid, rss_bytes, heap_bytes, started_at, seen_at) VALUES ($1, 'worker', $2, 1, 1, now_ms() - 7200000, now_ms() - $3)`, [`w${n}`, n, minutesAgo * 60_000]);
}
const view = async () => healthView(env.db, await getDevMode(env.db));
const toggle = (on: boolean, who: Admin = ws.owner) => env.server.inject({
  method: 'POST', url: `${w()}/health/dev-mode`,
  headers: { ...form(who).headers, accept: 'application/json' },
  payload: new URLSearchParams({ _csrf: who.csrf, set: '1', ...(on ? { on: '1' } : {}) }).toString(),
});

describe('dev mode', () => {
  it('leaves restarts out while it’s on, and counts again from zero once it’s off', async () => {
    await stopped(120);
    expect((await view()).restarts.worker).toBe(1);

    // Turned on, then three deploys.
    await setDevMode(env.db, true, ws.owner.user.id);
    await env.db.query('UPDATE server_settings SET dev_mode_on_at = now_ms() - 60 * 60000');
    await stopped(30);
    await stopped(20);
    await stopped(10);
    let h = await view();
    expect(h.restarts.worker).toBe(1);
    expect(h.uncounted.worker).toBe(3);

    // Off: nothing before now counts any more.
    await setDevMode(env.db, false, ws.owner.user.id);
    h = await view();
    expect(h.restarts.worker).toBe(0);
    expect(h.uncounted.worker).toBe(4);
    expect((await getDevMode(env.db)).offAt).not.toBeNull();
  });

  it('is switched on Server health by admins, and the sidebar shows it’s on', async () => {
    for (const m of [120, 90, 60]) await stopped(m);
    await env.db.query(`INSERT INTO process_status (id, role, pid, rss_bytes, heap_bytes, started_at, seen_at) VALUES ('now', 'worker', 99, 1, 1, now_ms() - 600000, now_ms())`);
    const before = await env.server.inject({ method: 'GET', url: `${w()}/health?partial=1`, ...get(ws.owner) });
    expect(before.body).toContain('Filing worker restarted 3 times in 24 hours');
    expect(before.body).toContain('If these were deploys, turn on Dev mode while you deploy');

    const page = await env.server.inject({ method: 'GET', url: `${w()}/health`, ...get(ws.owner) });
    expect(page.body).toContain(`action="${w()}/health/dev-mode"`);
    expect(page.body).toMatch(/data-dev-tag[^>]*hidden/);

    expect((await toggle(true)).json()).toEqual({ ok: true, message: 'Dev mode is on: restarts aren’t counted until you turn it off.', on: true });
    const on = await env.server.inject({ method: 'GET', url: `${w()}/tickets`, ...get(ws.owner) });
    expect(on.body).not.toMatch(/data-dev-tag[^>]*hidden/);
    const live = await env.server.inject({ method: 'GET', url: `${w()}/health?partial=1`, ...get(ws.owner) });
    expect(live.body).toContain('Dev mode is on');

    expect((await toggle(false)).json()).toMatchObject({ ok: true, on: false });
    const after = await env.server.inject({ method: 'GET', url: `${w()}/health?partial=1`, ...get(ws.owner) });
    expect(after.body).not.toContain('restarted 3 times');
    expect(after.body).toContain('+3 in dev mode');
  });

  it('moderators who see Server health see it’s on, but can’t switch it', async () => {
    const mod = await makeAdmin(env, 'mia');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await setModeratorPermissions(env.db, ws.workspace.id, mod.user.id, { canActTickets: false, canViewContributors: false, canViewHealth: true });
    expect((await toggle(true, mod)).statusCode).toBe(403);
    await setDevMode(env.db, true, ws.owner.user.id);
    const page = await env.server.inject({ method: 'GET', url: `${w()}/health`, ...get(mod) });
    expect(page.body).toContain('Dev mode on');
    expect(page.body).not.toContain(`action="${w()}/health/dev-mode"`);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyAsset } from '../src/analytics/assets.js';
import { rollUp } from '../src/analytics/recorder.js';
import { SLOT_MS, slotOf, windowOf } from '../src/analytics/time.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite } from '../src/domain/workspaces.js';
import { form, get, grant, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

describe('Analytics: release files and time', () => {
  it('reads what each release file is from its name', () => {
    expect(classifyAsset('photocraft-0.11.1-windows-x64.msi')).toEqual({ platform: 'windows', arch: 'x64', format: 'MSI', kind: 'app' });
    expect(classifyAsset('photocraft-0.11.1-windows-x86-portable.zip')).toMatchObject({ platform: 'windows', arch: 'x86', format: 'Portable zip' });
    expect(classifyAsset('photocraft-0.11.1-macos-universal.dmg')).toMatchObject({ platform: 'macos', arch: 'universal', format: 'DMG' });
    expect(classifyAsset('photocraft-0.11.1-linux-aarch64.AppImage')).toMatchObject({ platform: 'linux', arch: 'arm64', format: 'AppImage' });
    expect(classifyAsset('photocraft-0.11.1-linux-x86_64.pkg.tar.zst')).toMatchObject({ platform: 'linux', arch: 'x64', format: 'pkg.tar.zst' });
    expect(classifyAsset('photocraft-0.11.1-freebsd-x86_64.tar.gz')).toMatchObject({ platform: 'freebsd', format: 'tar.gz' });
    expect(classifyAsset('photocraft-cli-0.11.1-macos-universal.zip')).toMatchObject({ platform: 'macos', kind: 'cli' });
    expect(classifyAsset('photocraft-web-0.11.1.zip')).toMatchObject({ platform: 'web', kind: 'web' });
    for (const meta of ['SHA256SUMS.txt', 'photocraft-0.11.1-linux-x86_64.AppImage.zsync', 'latest.json', 'app.msi.sig']) expect(classifyAsset(meta).kind).toBe('meta');
  });

  it('starts today at the viewer’s midnight, and only offers steps that fit', () => {
    const now = Date.parse('2026-10-21T06:20:00Z');
    const today = windowOf(undefined, undefined, 'America/Los_Angeles', now);
    expect(today).toMatchObject({ start: Date.parse('2026-10-20T07:00:00Z'), end: Date.parse('2026-10-21T07:00:00Z'), until: now });
    expect(today.step.id).toBe('30m');
    expect(today.buckets).toHaveLength(48);
    // Compared with the same time yesterday.
    expect(today.prevEnd - today.prevStart).toBe(now - today.start);
    expect(windowOf('7d', undefined, 'UTC', now).step.id).toBe('3h');
    // 30 minutes over 30 days would be 1,440 bars: not offered, so the range's own step is used.
    const month = windowOf('30d', '30m', 'UTC', now);
    expect(month.step.id).toBe('1d');
    expect(month.steps.filter((s) => s.ok).map((s) => s.id)).toEqual(['3h', '6h', '12h', '1d']);
    expect(windowOf('90d', '6h', 'UTC', now).steps.filter((s) => s.ok).map((s) => s.id)).toEqual(['1d']);
    // A day of 25 hours when the clocks go back.
    const fall = windowOf('7d', '1d', 'America/Los_Angeles', Date.parse('2026-11-03T20:00:00Z'));
    expect(fall.buckets[5]! - fall.buckets[4]!).toBe(25 * 3_600_000);
  });
});

let env: TestEnv;
let ws: ConfiguredWorkspace;
const w = () => `/w/${ws.workspace.id}`;
const page = (url: string, who: Admin = ws.owner) => env.server.inject({ method: 'GET', url: `${w()}${url}`, ...get(who) });
const post = (url: string, fields: Record<string, string> = {}, who: Admin = ws.owner) => env.server.inject({ method: 'POST', url: `${w()}${url}`, ...form(who, fields) });
const repo = (i = 0) => env.github.repos.get(ws.repoIds[i]!)!;
const tick = (now: number) => env.triage.engine.analytics.tick(now);
const counts = async () => (await env.db.query(
  'SELECT a.name, a.release, c.slot_at, c.downloads FROM download_counts c JOIN download_assets a ON a.id = c.asset_id ORDER BY c.slot_at, a.name',
)).rows.map((r) => ({ name: r.name, release: r.release, slot: r.slot_at.getTime(), n: r.downloads }));
const ago = (h: number, from = Date.now()) => new Date(from - h * 3_600_000).toISOString();

function seed(now = Date.now()) {
  repo().releases = [
    { tag: 'v0.11.1', published_at: ago(30, now), assets: [
      { name: 'photocraft-0.11.1-windows-x64.msi', downloads: 1000 },
      { name: 'photocraft-0.11.1-macos-universal.dmg', downloads: 500 },
      { name: 'photocraft-0.11.1-linux-x86_64.AppImage', downloads: 200 },
      { name: 'SHA256SUMS.txt', downloads: 90 },
    ] },
    { tag: 'v0.10.0', published_at: ago(200, now), assets: [{ name: 'photocraft-0.10.0-windows-x64.msi', downloads: 4000 }] },
  ];
  repo().stars = [{ login: 'ana', at: ago(5, now) }, { login: 'ben', at: ago(400, now) }];
}
const asset = (name: string) => repo().releases!.flatMap((r) => r.assets ?? []).find((a) => a.name === name)!;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'PhotoCraft', repoIndex: 0 }] });
});
afterAll(async () => {
  await testDb().end();
});

describe('Analytics: recording downloads', () => {
  it('is off until turned on, then records how much each file grew per 30 minutes', async () => {
    seed();
    const t0 = slotOf(Date.now()) - 4 * SLOT_MS + 60_000;
    expect(await tick(t0)).toBe(0);
    const off = (await page('/analytics')).body;
    expect(off).toContain('See downloads every half hour');
    expect(off).toContain('Turn on');
    expect((await post('/analytics/enabled', { enabled: '1' })).statusCode).toBe(302);
    // The first read is a starting point.
    expect(await tick(t0)).toBe(1);
    expect(await counts()).toEqual([]);
    expect(await tick(t0 + 60_000)).toBe(0);
    // Half an hour later: what grew, in the slot that just ended; checksums aren't downloads.
    asset('photocraft-0.11.1-windows-x64.msi').downloads += 40;
    asset('photocraft-0.11.1-macos-universal.dmg').downloads += 10;
    asset('SHA256SUMS.txt').downloads += 9;
    expect(await tick(t0 + SLOT_MS)).toBe(1);
    expect(await counts()).toEqual([
      { name: 'photocraft-0.11.1-macos-universal.dmg', release: 'v0.11.1', slot: slotOf(t0), n: 10 },
      { name: 'photocraft-0.11.1-windows-x64.msi', release: 'v0.11.1', slot: slotOf(t0), n: 40 },
    ]);
    // A read missed: the growth is spread over the slots in between.
    asset('photocraft-0.11.1-windows-x64.msi').downloads += 7;
    await tick(t0 + 3 * SLOT_MS);
    const spread = (await counts()).filter((c) => c.slot > slotOf(t0));
    expect(spread).toEqual([
      { name: 'photocraft-0.11.1-windows-x64.msi', release: 'v0.11.1', slot: slotOf(t0) + SLOT_MS, n: 3 },
      { name: 'photocraft-0.11.1-windows-x64.msi', release: 'v0.11.1', slot: slotOf(t0) + 2 * SLOT_MS, n: 4 },
    ]);
  });

  it('counts a new release from when it was published, and starts again after a long gap', async () => {
    seed();
    const t0 = slotOf(Date.now()) - 60 * SLOT_MS;
    await post('/analytics/enabled', { enabled: '1' });
    await tick(t0);
    repo().releases!.unshift({ tag: 'v0.12.0', published_at: new Date(t0 + 10 * 60_000).toISOString(), assets: [{ name: 'photocraft-0.12.0-windows-x64.msi', downloads: 25 }] });
    await tick(t0 + SLOT_MS);
    expect(await counts()).toEqual([{ name: 'photocraft-0.12.0-windows-x64.msi', release: 'v0.12.0', slot: slotOf(t0), n: 25 }]);
    // Off for over a day: nothing invented for the gap.
    asset('photocraft-0.12.0-windows-x64.msi').downloads += 5000;
    const later = t0 + 50 * SLOT_MS;
    await tick(later);
    expect((await counts()).length).toBe(1);
    const sync = (await env.db.query('SELECT started_at FROM download_sync')).rows[0];
    expect(sync.started_at.getTime()).toBe(later);
  });

  it('reads the star history once, then only new stars; old detail is kept per day', async () => {
    seed();
    await post('/analytics/enabled', { enabled: '1' });
    const t0 = Date.now();
    await tick(t0);
    const stars = async () => (await env.db.query('SELECT login FROM repo_stars ORDER BY login')).rows.map((r) => r.login);
    expect(await stars()).toEqual(['ana', 'ben']);
    // GitHub's own total, per 30-minute slot, with the downloads.
    expect((await env.db.query('SELECT slot_at, total FROM repo_star_counts')).rows).toEqual([{ slot_at: new Date(slotOf(t0)), total: 2 }]);
    repo().stars!.push({ login: 'cy', at: new Date().toISOString() });
    await tick(t0 + SLOT_MS);
    expect(await stars()).toEqual(['ana', 'ben', 'cy']);
    expect((await env.db.query('SELECT total FROM repo_star_counts ORDER BY slot_at')).rows.map((r) => r.total)).toEqual([2, 3]);
    expect((await env.db.query('SELECT stars_total FROM download_sync')).rows[0].stars_total).toBe(3);
    // 30-minute rows older than 32 days are added up per UTC day.
    const old = Date.parse('2026-08-01T10:30:00Z');
    const { rows } = await env.db.query('SELECT id FROM download_assets LIMIT 1');
    await env.db.query('INSERT INTO download_counts (asset_id, slot_at, downloads) VALUES ($1, $2, 3), ($1, $3, 4)', [rows[0].id, new Date(old), new Date(old + SLOT_MS)]);
    await rollUp(env.db, Date.parse('2026-10-21T00:00:00Z'));
    expect((await env.db.query('SELECT day_at, downloads FROM download_days')).rows).toEqual([{ day_at: new Date('2026-08-01T00:00:00Z'), downloads: 7 }]);
    expect((await env.db.query('SELECT count(*) AS n FROM download_counts WHERE slot_at < $1', [new Date('2026-09-01')])).rows[0].n).toBe(0);
  });
});

describe('Analytics: the page', () => {
  async function recorded() {
    seed();
    await post('/analytics/enabled', { enabled: '1' });
    const t0 = slotOf(Date.now()) - 10 * SLOT_MS;
    await tick(t0);
    asset('photocraft-0.11.1-windows-x64.msi').downloads += 300;
    asset('photocraft-0.11.1-macos-universal.dmg').downloads += 100;
    asset('photocraft-0.11.1-linux-x86_64.AppImage').downloads += 100;
    await tick(t0 + SLOT_MS);
  }
  async function ticket(title: string) {
    const r = await acceptSubmission(env.deps, {
      workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-an-${title}`, interactionToken: null,
      guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `r-${title}`, displayName: 'Member', username: 'member' },
      title, description: `${title}, every time.`, ticketType: null,
    });
    if (r.kind !== 'accepted') throw new Error(r.kind);
    await env.worker.drain();
  }

  it('shows downloads with their breakdowns, activity and release health, for the range and step picked', async () => {
    await recorded();
    await ticket('Export crashes');
    const res = await page('/analytics?range=7d');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // One app: downloads by platform, in the fixed order.
    expect(body).toMatch(/data-an-chart='[^']*&quot;name&quot;:&quot;Windows&quot;[^']*&quot;name&quot;:&quot;macOS&quot;[^']*&quot;name&quot;:&quot;Linux&quot;/);
    expect(body).toContain('<div class="an-kl">Downloads</div><div class="an-kv">500</div>');
    expect(body).toContain('<div class="an-kl">Tickets per 1K downloads</div><div class="an-kv">2.0</div>');
    expect(body).toContain('x64 (Intel, AMD)');
    expect(body).toContain('>MSI<');
    expect(body).toContain('>v0.11.1</a> <span class="tag subtle">Latest</span>');
    // Release health: GitHub's totals for each release, and tickets while it was the latest.
    expect(body).toMatch(/v0\.11\.1<\/a>.*?<td class="num">2,200<\/td>\s*<td class="num">1<\/td>\s*<td class="num">0\.5<\/td>/s);
    // Steps too fine for the range are shown but not offered.
    expect(body).toContain('aria-current="true">3h</a>');
    const quarter = (await page('/analytics?range=90d')).body;
    expect(quarter).toContain('<span class="seg-item off" aria-disabled="true" title="Too fine for 90 days">30m</span>');
    // The viewer's time zone counts the days.
    const berlin = await env.server.inject({ method: 'GET', url: `${w()}/analytics`, headers: { ...get(ws.owner).headers, cookie: `${get(ws.owner).headers!.cookie}; tr_tz=Europe/Berlin` } });
    expect(berlin.body).toContain('data-an-tz="Europe/Berlin"');
  });

  it('switches the main chart to stars: new stars over time, and each app’s total', async () => {
    await recorded();
    const body = (await page('/analytics?range=7d&metric=stars')).body;
    expect(body).toMatch(/aria-label="Chart"><a class="seg-item" href="[^"]*\/analytics\?range=7d"\s*>Downloads<\/a><a class="seg-item" href="[^"]*\/analytics\?metric=stars&amp;range=7d" aria-current="true">Stars<\/a>/);
    expect(body).toContain('new stars · PhotoCraft');
    expect(body).toMatch(/data-an-chart='[^']*&quot;name&quot;:&quot;New stars&quot;/);
    // Total 2 (GitHub's count), 1 given in the last 7 days.
    expect(body).toMatch(/Stars by app[\s\S]*?PhotoCraft<\/span>\s*<span class="an-bv num">2 <span class="an-up">\+1<\/span>/);
    // The download breakdowns aren't shown; the app picker keeps the stars view.
    expect(body).not.toContain('id="an-pl-h"');
    expect(body).toContain('<input type="hidden" name="metric" value="stars">');
    expect((await page('/analytics?range=7d')).body).toContain('id="an-pl-h"');
  });

  it('is on the Overview and in the sidebar; moderators need access, and Edit to turn it off', async () => {
    await recorded();
    expect((await page('')).body).toContain('Open Analytics');
    const mod = await makeAdmin(env, 'mo');
    await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, 'moderator')}`, ...form(mod) });
    await grant(env, ws.workspace.id, mod.user.id, {});
    expect((await page('/analytics', mod)).statusCode).toBe(403);
    await grant(env, ws.workspace.id, mod.user.id, { analytics: 'view' });
    const view = await page('/analytics', mod);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('View only');
    expect((await post('/analytics/enabled', { enabled: '0' }, mod)).statusCode).toBe(403);
    expect((await post('/analytics/enabled', { enabled: '0' })).statusCode).toBe(302);
    expect((await page('/analytics')).body).toContain('Turn on');
  });
});

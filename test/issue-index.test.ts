import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { healthView, startHeartbeat } from '../src/domain/health.js';
import { chooseOriginal, ftsQuery, IssueIndexer, searchIndex, type IndexedIssue } from '../src/domain/issue-index.js';
import { acceptSubmission } from '../src/domain/submissions.js';
import { createInvite, setModeratorPermissions } from '../src/domain/workspaces.js';
import { parseTriageConfig, saveTriageConfig, setApiKey, setTriageEnabled } from '../src/triage/settings.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, resetDb, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
const w = () => `/w/${ws.workspace.id}`;
const repo = () => env.github.repos.get(ws.repoIds[0]!)!;
const repoId = () => ws.repoIds[0]!;
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
});
afterAll(async () => {
  await testDb().end();
});

function addIssue(number: number, title: string, o: { body?: string; state?: 'open' | 'closed'; reason?: string; created?: string; comments?: string[] } = {}) {
  repo().issues.push({
    number, title, body: o.body ?? `${title}. Happens every time.`, labels: [], created_at: o.created ?? daysAgo(400 - number % 300), user: 'someone',
    state: o.state ?? 'open', state_reason: o.reason ?? null, closed_at: o.state === 'closed' ? daysAgo(10) : null, comments: o.comments,
  });
}

/** Unrelated noise so an old original isn't among the "recent issues". */
function noise(from: number, count: number) {
  const topics = ['Dark mode toggle', 'Sidebar icons blurry', 'Login button color', 'Typo on settings page', 'Slow startup on Mac', 'Keyboard shortcut missing', 'Tooltip overlaps menu', 'Font too small in panel'];
  for (let i = 0; i < count; i++) addIssue(from + i, `${topics[i % topics.length]} ${i}`, { created: daysAgo(5 - i / 100) });
}

async function indexed(): Promise<IndexedIssue[]> {
  return (await env.db.query<IndexedIssue>('SELECT * FROM issue_index WHERE repo_id = $1 ORDER BY number', [repoId()])).rows;
}

async function joinAs(role: 'moderator', name: string, perms?: Partial<{ canActTickets: boolean; canViewContributors: boolean; canSearchIssues: boolean; canManageFiles: boolean }>): Promise<Admin> {
  const person = await makeAdmin(env, name);
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, role)}`, ...form(person) });
  if (perms) await setModeratorPermissions(env.db, ws.workspace.id, person.user.id, { canActTickets: false, canViewContributors: false, ...perms });
  return person;
}

// ---- Sync ------------------------------------------------------------------------------------------

describe('issue index sync', () => {
  it('copies every issue oldest first, resumes a long first load, then picks up changes and deletions', async () => {
    for (let n = 1; n <= 650; n++) addIssue(n, `Issue number ${n}`);
    const indexer = new IssueIndexer(env.deps);
    await indexer.tick();
    let r = (await env.db.query('SELECT * FROM issue_index_repos WHERE repo_id = $1', [repoId()])).rows[0];
    expect(r.status).toBe('ready');
    expect(await indexed()).toHaveLength(650);

    // A bigger repository loads in steps.
    for (let n = 651; n <= 1500; n++) addIssue(n, `Issue number ${n}`);
    await env.db.query(`UPDATE issue_index_repos SET status = 'loading', next_page = 1, synced_until = NULL WHERE repo_id = $1`, [repoId()]);
    await indexer.sync(repoId(), { pages: 5 });
    r = (await env.db.query('SELECT * FROM issue_index_repos WHERE repo_id = $1', [repoId()])).rows[0];
    expect(r.status).toBe('loading');
    expect(r.next_page).toBe(6);
    await indexer.sync(repoId(), { pages: 20 });
    expect((await env.db.query('SELECT status FROM issue_index_repos WHERE repo_id = $1', [repoId()])).rows[0].status).toBe('ready');
    expect(await indexed()).toHaveLength(1500);

    // Edits and new issues arrive with one request when nothing else changed.
    const edited = repo().issues.find((i) => i.number === 7)!;
    edited.title = 'Export to PDF crashes';
    edited.updated_at = new Date(Date.now() + 1000).toISOString();
    addIssue(1501, 'Brand new issue', { created: new Date(Date.now() + 1000).toISOString() });
    const before = env.github.listCalls;
    await indexer.sync(repoId(), { pages: 5, fullCheck: false });
    expect(env.github.listCalls - before).toBe(1);
    const rows = await indexed();
    expect(rows.find((i) => i.number === 7)!.title).toBe('Export to PDF crashes');
    expect(rows.find((i) => i.number === 1501)).toBeTruthy();

    // The weekly check marks deleted issues.
    repo().issues = repo().issues.filter((i) => i.number !== 9);
    await indexer.sync(repoId(), { pages: 5, fullCheck: true });
    expect((await indexed()).find((i) => i.number === 9)).toBeUndefined();
  });

  it('forgets a repository no app uses any more', async () => {
    addIssue(1, 'Something');
    await new IssueIndexer(env.deps).tick();
    expect(await indexed()).toHaveLength(1);
    await env.db.query('DELETE FROM apps WHERE workspace_id = $1', [ws.workspace.id]);
    await new IssueIndexer(env.deps).tick();
    expect(await indexed()).toHaveLength(0);
  });
});

// ---- Search and choosing the original ---------------------------------------------------------------------

describe('search and originals', () => {
  it('finds matches across the whole history with word forms, ignoring search syntax', async () => {
    addIssue(1, 'Exporting to PDF crashes on Windows', { created: daysAgo(900) });
    noise(2, 60);
    await new IssueIndexer(env.deps).tick();
    const q = ftsQuery('PDF export crash', 'When I export a PDF the app crashes. "OR" NEAR(*)')!;
    expect(q).not.toContain('NEAR(');
    const hits = await searchIndex(env.db, { repoIds: [repoId()], query: q, limit: 5 });
    expect(hits[0]!.number).toBe(1);
    expect(hits[0]!.snippet).toContain('\u0001');
  });

  it('follows copies to the oldest open original, and only falls back to closed ones', () => {
    const k = (n: number, o: Partial<IndexedIssue>) => [n, { number: n, state: 'open', created_at: new Date(2020, 0, n), duplicate_of: null, gone: 0, ...o }] as const;
    const known = new Map([k(10, {}), k(20, { duplicate_of: 10 }), k(30, {}), k(40, { state: 'closed' }), k(50, { duplicate_of: 60 }), k(60, { duplicate_of: 50 })]);
    expect(chooseOriginal([{ number: 20, confidence: 95 }], known)).toMatchObject({ number: 10, via: 20, closed: false });
    expect(chooseOriginal([{ number: 30, confidence: 90 }, { number: 10, confidence: 85 }], known)).toMatchObject({ number: 10, others: [30] });
    expect(chooseOriginal([{ number: 40, confidence: 95 }], known)).toMatchObject({ number: 40, closed: true });
    expect(chooseOriginal([{ number: 40, confidence: 95 }, { number: 30, confidence: 90 }], known)).toMatchObject({ number: 30, closed: false });
    // A match far less confident than the best one doesn't win just by being older.
    expect(chooseOriginal([{ number: 30, confidence: 95 }, { number: 10, confidence: 40 }], known)!.number).toBe(30);
    // Loops stop.
    expect([50, 60]).toContain(chooseOriginal([{ number: 50, confidence: 90 }], known)!.number);
  });
});

// ---- Triage uses it ----------------------------------------------------------------------------------------

describe('duplicate triage with the issue database', () => {
  async function enable(config: Record<string, unknown> = { duplicate: { mode: 'auto' } }) {
    await new Promise((r) => setTimeout(r, 2));
    await setApiKey(env.db, env.deps.box, ws.workspace.id, 'sk-ant-test-key-0123456789abcdef', ws.owner.user.id);
    await saveTriageConfig(env.db, ws.workspace.id, parseTriageConfig(config));
    await setTriageEnabled(env.db, ws.workspace.id, true);
  }
  let n = 0;
  async function file(title: string, description: string) {
    n++;
    const r = await acceptSubmission(env.deps, {
      workspace: ws.workspace, app: ws.apps[0]!, installationId: ws.installationId, source: 'discord', interactionId: `int-ix${n}`, interactionToken: null,
      guildId: ws.guildId, guildName: 'G', channelId: ws.channelId, reporter: { id: `rx${n}`, displayName: `M${n}`, username: `m${n}` }, title, description,
    });
    if (r.kind !== 'accepted') throw new Error(r.kind);
    await env.worker.drain();
    return (await env.db.query('SELECT * FROM submissions WHERE id = $1', [r.submission.id])).rows[0] as { id: string; issue_number: number };
  }
  const issue = (num: number) => repo().issues.find((i) => i.number === num)!;
  const result = async (id: string) => (await env.db.query('SELECT * FROM triage_results WHERE submission_id = $1', [id])).rows[0];

  it('finds an old original through a newer copy and links the original', async () => {
    addIssue(1, 'Exporting to PDF crashes on Windows', { created: daysAgo(900) });
    addIssue(2, 'PDF export crash', { state: 'closed', reason: 'duplicate', created: daysAgo(300), comments: ['Duplicate of #1'] });
    noise(3, 60);
    await enable();
    const t = await file('App crashes when I export a PDF', 'Every time I export to PDF the whole app crashes and closes.');
    env.anthropic.queue.push({ ...env.anthropic.verdict, duplicates: [{ number: 2, confidence: 96 }] });
    await env.triage.drain();

    const prompt: string = env.anthropic.requests[0]!.body.messages[0].content;
    expect(prompt).toContain('"number": 2');
    expect(prompt).toContain('"closed_as": "duplicate"');
    expect(env.anthropic.requests[0]!.body.system[0].text).not.toContain('stop at the first');
    expect(issue(t.issue_number).comments?.[0]).toContain('Possible duplicate of #1');
    expect(issue(t.issue_number).labels).toEqual(['duplicate']);
    const v = (await result(t.id)).verdict;
    expect(v).toMatchObject({ duplicate_of: 1, duplicate_via: 2, duplicate_closed: false });
    const row = (await env.db.query('SELECT duplicate_of FROM issue_index WHERE repo_id = $1 AND number = $2', [repoId(), t.issue_number])).rows[0];
    expect(row.duplicate_of).toBe(1);

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/${t.id}`, ...get(ws.owner) });
    expect(page.body).toContain('which copies');
  });

  it('only suggests when the original is closed, and drops originals deleted on GitHub', async () => {
    addIssue(1, 'Ruler tool snaps to the wrong grid', { state: 'closed', reason: 'completed', created: daysAgo(500) });
    addIssue(2, 'Brush size resets after restart', { created: daysAgo(400) });
    await enable();
    const fixed = await file('Ruler tool snapping to wrong grid again', 'The ruler snaps to the wrong grid.');
    env.anthropic.queue.push({ ...env.anthropic.verdict, duplicates: [{ number: 1, confidence: 97 }] });
    await env.triage.drain();
    expect(issue(fixed.issue_number).labels).toEqual([]);
    expect((await result(fixed.id)).suggestions).toEqual([expect.objectContaining({ kind: 'duplicate', duplicateOf: 1, originalClosed: true })]);

    // #2 is in our copy but was deleted on GitHub since the last sync.
    await new IssueIndexer(env.deps).sync(repoId(), { pages: 5, fullCheck: false });
    repo().issues = repo().issues.filter((i) => i.number !== 2);
    const gone = await file('Brush size resets after a restart', 'Brush size goes back to default after restarting.');
    env.anthropic.queue.push({ ...env.anthropic.verdict, duplicates: [{ number: 2, confidence: 97 }] });
    await env.triage.drain();
    expect(issue(gone.issue_number).labels).toEqual([]);
    expect((await result(gone.id)).verdict.duplicate_of).toBeNull();
    expect((await env.db.query('SELECT 1 FROM issue_index WHERE repo_id = $1 AND number = 2', [repoId()])).rows).toHaveLength(0);
  });
});

// ---- Console -----------------------------------------------------------------------------------------------

describe('Issues tab and moderator access', () => {
  it('shows sync status and searches every issue; moderators need the switch', async () => {
    addIssue(1, 'Exporting to PDF crashes on Windows', { created: daysAgo(900) });
    addIssue(2, 'Dark mode toggle missing', { state: 'closed', reason: 'not_planned' });
    await new IssueIndexer(env.deps).tick();

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues?state=all&q=pdf%20crash`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Issue database');
    expect(page.body).toContain('Up to date');
    expect(page.body).toContain('<mark>');
    expect(page.body).toContain('Exporting to PDF crashes on Windows');
    expect(page.body).not.toContain('Dark mode toggle missing');
    const closed = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues?state=closed`, ...get(ws.owner) });
    expect(closed.body).toContain('Closed · not planned');

    const viewer = await joinAs('moderator', 'mod-plain');
    expect((await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues`, ...get(viewer) })).statusCode).toBe(403);
    const searcher = await joinAs('moderator', 'mod-search', { canSearchIssues: true });
    const ok = await env.server.inject({ method: 'GET', url: `${w()}/tickets/issues`, ...get(searcher) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('>Issues</a>');
    expect(ok.body).not.toContain('>Files</a>');
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/issues/sync`, ...form(searcher) })).statusCode).toBe(302);
  });

  it('lets admins give moderators the Files tab, with cleanup rules kept for admins', async () => {
    const mod = await joinAs('moderator', 'mod-files');
    expect((await env.server.inject({ method: 'GET', url: `${w()}/tickets/files`, ...get(mod) })).statusCode).toBe(403);
    const saved = await env.server.inject({ method: 'POST', url: `${w()}/members/${mod.user.id}/permissions`, ...form(ws.owner, { can_manage_files: '1', can_search_issues: '1' }) });
    expect(saved.statusCode).toBe(302);
    const row = (await env.db.query('SELECT can_manage_files, can_search_issues, can_act_tickets FROM workspace_members WHERE user_id = $1', [mod.user.id])).rows[0];
    expect(row).toMatchObject({ can_manage_files: true, can_search_issues: true, can_act_tickets: false });

    const files = await env.server.inject({ method: 'GET', url: `${w()}/tickets/files`, ...get(mod) });
    expect(files.statusCode).toBe(200);
    expect(files.body).toContain('Only owners and admins can change these.');
    expect(files.body).not.toContain('Save rules');
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/settings`, ...form(mod, { closed_days: '1', age_days: '1', storage_limit_gb: '1' }) })).statusCode).toBe(403);
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/scan`, ...form(mod) })).statusCode).toBe(302);

    const members = await env.server.inject({ method: 'GET', url: `${w()}/members`, ...get(ws.owner) });
    expect(members.body).toContain('Search all issues');
    expect(members.body).toContain('Clean up files');
  });
});

// ---- Server health ------------------------------------------------------------------------------------------

describe('server health', () => {
  it('shows each process’s memory against its limit, and counts restarts', async () => {
    process.env.MEMORY_LIMIT_MB = '256';
    const stop = startHeartbeat(env.db, { id: 'triage-1', role: 'triage' });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    delete process.env.MEMORY_LIMIT_MB;
    // An earlier worker that stopped reporting an hour ago: a restart.
    await env.db.query(`INSERT INTO process_status (id, role, pid, rss_bytes, heap_bytes, limit_mb, started_at, seen_at) VALUES ('old', 'triage', 1, 1, 1, 256, now_ms() - 7200000, now_ms() - 3600000)`);
    const h = await healthView(env.db);
    expect(h.running.map((p) => p.role)).toEqual(['triage']);
    expect(h.running[0]!.limit_mb).toBe(256);
    expect(h.restarts.triage).toBe(1);
    expect(h.host!.total).toBeGreaterThan(0);

    const page = await env.server.inject({ method: 'GET', url: `${w()}/deployment`, ...get(ws.owner) });
    expect(page.body).toContain('Server health');
    expect(page.body).toContain('Triage and issue sync');
    expect(page.body).toContain('of 256 MB');
    const mod = await joinAs('moderator', 'mod-health');
    expect((await env.server.inject({ method: 'GET', url: `${w()}/deployment`, ...get(mod) })).statusCode).toBe(403);
  });
});

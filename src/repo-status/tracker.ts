/**
 * Repo status: reads each watched repository from GitHub, one at a time, in the background
 * (the triage worker's polling loop, next to the issue index), and keeps what the page shows.
 *
 * Per repository: one GraphQL query for its releases and their downloads; one for counts, dates,
 * each window's commits and the open issues to score; one comparing the latest build's tag with
 * the default branch; and pages of commit authors, PRs and issues since a week ago (or the
 * latest build, whichever is earlier, up to 30 days), which give each window's people, PRs and
 * issues. Those are kept between reads, so after the first one only what's new is fetched. No
 * search API (GitHub limits it far more tightly). GraphQL has its own hourly budget, apart from
 * the REST one filing uses; reads pause when it runs low.
 */
import type { Queryable } from '../db/database.js';
import type { Deps } from '../domain/types.js';
import { GitHubApiError } from '../github/client.js';
import { rankIssues, summarizeReleases, type IssueInput, type Release, type UrgentIssue } from './score.js';

/** The activity windows the page offers, then since the latest build and all time. */
export const WINDOWS = [
  { id: '10m', label: 'Last 10 min', minutes: 10 },
  { id: '30m', label: 'Last 30 min', minutes: 30 },
  { id: '1h', label: 'Last hour', minutes: 60 },
  { id: '4h', label: 'Last 4 h', minutes: 4 * 60 },
  { id: '12h', label: 'Last 12 h', minutes: 12 * 60 },
  { id: '1d', label: 'Last day', minutes: 24 * 60 },
  { id: '7d', label: 'Last week', minutes: 7 * 24 * 60 },
] as const;
export const SINCE_BUILD = 'build';
export const ALL_TIME = 'all';
export const DEFAULT_WINDOW = '4h';

/** How often each repository is read (minutes). */
export const EVERY_MINUTES = [5, 10, 15, 30, 60] as const;
/** Issues kept per repository for Fix first. */
const KEEP_URGENT = 30;
/** A repository whose read failed is tried again after this. */
const RETRY_MS = 10 * 60_000;
const LEASE_MS = 3 * 60_000;
/** Below this many GraphQL points left, reads wait for the budget to reset. */
const BUDGET_FLOOR = 300;
/** Recent activity is kept for at least a week, and since the latest build up to this far back. */
const HORIZON_MAX_MS = 30 * 86_400_000;
/** Everything recent is read again from scratch this often (deleted issues, late-dated commits). */
const FULL_MS = 6 * 3_600_000;
const OVERLAP_MS = 10 * 60_000;
/** Pages of 100 read per list and read, at most. */
const MAX_PAGES = 30;
const ICON_MAX = 256 * 1024;

export interface Activity {
  commits: number;
  prs: number;
  merged: number;
  issues: number;
  /** Distinct commit authors (by login, else email); all time, GitHub's contributor count. */
  people: number | null;
}

export interface Build {
  tag: string;
  url: string;
  at: string | null;
  prerelease: boolean;
  downloads: number;
  totalDownloads: number;
  /** Commits on the default branch since the build; estimate: not counted from the tag itself. */
  unreleased: number | null;
  estimate: boolean;
  compareUrl: string | null;
}

export interface RepoStats {
  defaultBranch: string | null;
  openPrs: number;
  openIssues: number;
  oldestOpenPrAt: string | null;
  lastCommitAt: string | null;
  lastIssueAt: string | null;
  newestPrAt: string | null;
  /** By window id (WINDOWS, SINCE_BUILD when there's a build, ALL_TIME). */
  activity: Record<string, Activity | null>;
  build: Build | null;
  urgency: number;
  critical: number;
  urgent: UrgentIssue[];
}

/** What's kept between reads: recent commit authors, PRs opened and merged, issues opened. */
interface Raw {
  horizon: string;
  fullAt: string;
  lastAt: string;
  authors: Record<string, [string, string]>;
  opened: Record<string, string>;
  merged: Record<string, string>;
  issues: Record<string, string>;
  contributors: number | null;
  contributorsAt: string | null;
}

export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

export interface StatusSettings {
  enabled: boolean;
  /** Null: the apps' repositories. */
  repos: RepoRef[] | null;
  everyMinutes: number;
  refreshAt: Date | null;
}

export interface StatusRow {
  repo_id: number;
  owner: string;
  name: string;
  stats: RepoStats | null;
  has_icon: boolean;
  fetched_at: Date | null;
  checked_at: Date | null;
  error: string | null;
  budget: number | null;
  budget_reset_at: Date | null;
  lease_until_at: Date | null;
}

// ---- Settings and what the page reads -----------------------------------------------------------

export async function getStatusSettings(q: Queryable, workspaceId: string): Promise<StatusSettings> {
  const { rows } = await q.query<{ enabled: boolean; repos: RepoRef[] | null; every_minutes: number; refresh_at: Date | null }>(
    'SELECT enabled, repos, every_minutes, refresh_at FROM repo_status_settings WHERE workspace_id = $1',
    [workspaceId],
  );
  const r = rows[0];
  return { enabled: Boolean(r?.enabled), repos: r?.repos ?? null, everyMinutes: r?.every_minutes ?? 15, refreshAt: r?.refresh_at ?? null };
}

export async function saveStatusSettings(q: Queryable, workspaceId: string, s: { enabled: boolean; repos: RepoRef[] | null; everyMinutes: number }): Promise<void> {
  await q.query(
    `INSERT INTO repo_status_settings (workspace_id, enabled, repos, every_minutes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, repos = excluded.repos, every_minutes = excluded.every_minutes, updated_at = now_ms()`,
    [workspaceId, s.enabled, s.repos, s.everyMinutes],
  );
}

/** "Refresh now": every repository of the workspace is due (still read one at a time). */
export async function requestRefresh(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('UPDATE repo_status_settings SET refresh_at = now_ms() WHERE workspace_id = $1', [workspaceId]);
}

/** The workspace's repositories, in order: its own list, else each app's repository once. */
export async function statusRepos(q: Queryable, workspaceId: string, s: StatusSettings): Promise<RepoRef[]> {
  if (s.repos) return s.repos;
  const { rows } = await q.query<{ repo_id: number; repo_owner: string; repo_name: string }>(
    'SELECT repo_id, repo_owner, repo_name FROM apps WHERE workspace_id = $1 ORDER BY position, lower(name)',
    [workspaceId],
  );
  const seen = new Set<number>();
  return rows.filter((r) => !seen.has(r.repo_id) && seen.add(r.repo_id)).map((r) => ({ id: r.repo_id, owner: r.repo_owner, name: r.repo_name }));
}

export async function statusRows(q: Queryable, repoIds: number[]): Promise<Map<number, StatusRow>> {
  if (!repoIds.length) return new Map();
  const { rows } = await q.query<StatusRow>(
    `SELECT repo_id, owner, name, stats, icon IS NOT NULL AS has_icon, fetched_at, checked_at, error, budget, budget_reset_at, lease_until_at
       FROM repo_status WHERE repo_id IN (SELECT value FROM json_each($1))`,
    [repoIds],
  );
  return new Map(rows.map((r) => [r.repo_id, { ...r, has_icon: Boolean(r.has_icon) }]));
}

export async function statusIcon(q: Queryable, repoId: number): Promise<Buffer | null> {
  const { rows } = await q.query<{ icon: string | null }>('SELECT icon FROM repo_status WHERE repo_id = $1', [repoId]);
  return rows[0]?.icon ? Buffer.from(rows[0].icon, 'base64') : null;
}

// ---- Reading GitHub -----------------------------------------------------------------------------

const MAIN_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    openPrs: pullRequests(states: OPEN) { totalCount }
    allPrs: pullRequests { totalCount }
    mergedPrs: pullRequests(states: MERGED) { totalCount }
    oldestOpenPr: pullRequests(states: OPEN, first: 1, orderBy: {field: CREATED_AT, direction: ASC}) { nodes { createdAt } }
    newestPr: pullRequests(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt } }
    openIssues: issues(states: OPEN) { totalCount }
    allIssues: issues { totalCount }
    newestIssue: issues(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt } }
    icon: object(expression: "HEAD:assets/app-icon/hicolor/64x64/apps") { ... on Tree { entries { name oid } } }
    recentOpen: issues(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...I } }
    hotOpen: issues(states: OPEN, first: 30, orderBy: {field: COMMENTS, direction: DESC}) { nodes { ...I } }
    defaultBranchRef {
      name
      target {
        ... on Commit {
          all: history(first: 1) { totalCount nodes { committedDate } }
          {HISTORY}
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}
fragment I on Issue {
  number title url createdAt updatedAt authorAssociation
  comments { totalCount }
  reactions { totalCount }
  labels(first: 10) { nodes { name } }
}`;

const RELEASES_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    releases(first: 50, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        tagName url isDraft isPrerelease publishedAt createdAt
        tagCommit { oid committedDate }
        releaseAssets(first: 100) { nodes { name downloadCount } }
      }
    }
  }
}`;

const BUILD_QUERY = `
query($owner: String!, $name: String!, $tag: String!, $branch: String!, $at: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $tag) { compare(headRef: $branch) { status aheadBy } }
    defaultBranchRef { target { ... on Commit { since: history(since: $at) { totalCount } } } }
  }
}`;

const AUTHORS_QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(since: $since, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { oid committedDate author { email name user { login } } }
          }
        }
      }
    }
  }
}`;

const EVENTS_QUERY = `
query($owner: String!, $name: String!, $opened: Boolean!, $merged: Boolean!, $issues: Boolean!, $openedAfter: String, $mergedAfter: String, $issuesAfter: String) {
  repository(owner: $owner, name: $name) {
    opened: pullRequests(first: 100, after: $openedAfter, orderBy: {field: CREATED_AT, direction: DESC}) @include(if: $opened) {
      pageInfo { hasNextPage endCursor }
      nodes { number createdAt }
    }
    merged: pullRequests(states: MERGED, first: 100, after: $mergedAfter, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $merged) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt mergedAt }
    }
    issues: issues(first: 100, after: $issuesAfter, orderBy: {field: CREATED_AT, direction: DESC}) @include(if: $issues) {
      pageInfo { hasNextPage endCursor }
      nodes { number createdAt }
    }
  }
}`;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const time = (v: unknown) => (typeof v === 'string' ? new Date(v) : null);
const count = (v: any) => Number(v?.totalCount ?? 0);
const first = (v: any, key: string) => (typeof v?.nodes?.[0]?.[key] === 'string' ? (v.nodes[0][key] as string) : null);

/** Each window's start: WINDOWS by index (c0…), then since the latest build (cb). */
function windowStarts(now: number, buildAt: Date | null): { id: string; key: string; since: Date }[] {
  const out = WINDOWS.map((w, i) => ({ id: w.id as string, key: `c${i}`, since: new Date(now - w.minutes * 60_000) }));
  if (buildAt) out.push({ id: SINCE_BUILD, key: 'cb', since: buildAt });
  return out;
}

function issuesOf(conn: any): IssueInput[] {
  return (conn?.nodes ?? []).map((i: any) => ({
    number: Number(i.number),
    title: String(i.title ?? ''),
    url: String(i.url ?? ''),
    createdAt: time(i.createdAt),
    updatedAt: time(i.updatedAt),
    comments: count(i.comments),
    reactions: count(i.reactions),
    labels: (i.labels?.nodes ?? []).map((l: any) => String(l?.name ?? '')).filter(Boolean),
    authorAssociation: String(i.authorAssociation ?? ''),
  }));
}

export class RepoStatusTracker {
  /** GraphQL budget per installation, as GitHub last reported it. */
  private budgets = new Map<number, { remaining: number; resetAt: Date }>();

  constructor(readonly deps: Deps) {}

  /** Repositories of workspaces with Repo status on, each with its most frequent schedule. */
  private async tracked(): Promise<{ repo: RepoRef; installationId: number; everyMs: number; refreshAt: number }[]> {
    const { db } = this.deps;
    const { rows } = await db.query<{ workspace_id: string; installation_id: number }>(
      `SELECT s.workspace_id, g.installation_id FROM repo_status_settings s
         JOIN github_connections g ON g.workspace_id = s.workspace_id AND g.status = 'active' WHERE s.enabled = 1`,
    );
    const out = new Map<number, { repo: RepoRef; installationId: number; everyMs: number; refreshAt: number }>();
    for (const w of rows) {
      const s = await getStatusSettings(db, w.workspace_id);
      for (const repo of await statusRepos(db, w.workspace_id, s)) {
        const prev = out.get(repo.id);
        const everyMs = s.everyMinutes * 60_000;
        const refreshAt = s.refreshAt?.getTime() ?? 0;
        if (!prev) out.set(repo.id, { repo, installationId: w.installation_id, everyMs, refreshAt });
        else {
          prev.everyMs = Math.min(prev.everyMs, everyMs);
          prev.refreshAt = Math.max(prev.refreshAt, refreshAt);
        }
      }
    }
    return [...out.values()];
  }

  /** Reads the repositories that are due, stalest first, at most `max` of them. Returns how many were read. */
  async tick(now = Date.now(), max = 1): Promise<number> {
    const { db, github } = this.deps;
    if (!github) return 0;
    const tracked = await this.tracked();
    if (!tracked.length) return 0;
    const known = await statusRows(db, tracked.map((t) => t.repo.id));
    const due = tracked
      .map((t) => ({ ...t, row: known.get(t.repo.id) }))
      .filter(({ row, everyMs, refreshAt }) => {
        if (!row?.fetched_at) return !row?.checked_at || now - row.checked_at.getTime() >= RETRY_MS;
        const last = row.fetched_at.getTime();
        if (row.error && row.checked_at && now - row.checked_at.getTime() < RETRY_MS) return false;
        return now - last >= everyMs || last < refreshAt;
      })
      .sort((a, b) => (a.row?.fetched_at?.getTime() ?? 0) - (b.row?.fetched_at?.getTime() ?? 0));
    let read = 0;
    for (const t of due) {
      if (read >= max) break;
      const budget = this.budgets.get(t.installationId);
      if (budget && budget.remaining < BUDGET_FLOOR && budget.resetAt.getTime() > now) continue;
      if (!(await this.claim(t.repo, t.installationId, now))) continue;
      await this.read(t.repo, t.installationId, now);
      read++;
    }
    return read;
  }

  private async claim(repo: RepoRef, installationId: number, now: number): Promise<boolean> {
    const { db } = this.deps;
    await db.query(
      `INSERT INTO repo_status (repo_id, owner, name, installation_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id) DO NOTHING`,
      [repo.id, repo.owner, repo.name, installationId],
    );
    const { rows } = await db.query(
      `UPDATE repo_status SET lease_until_at = $2, owner = $3, name = $4, installation_id = $5
        WHERE repo_id = $1 AND (lease_until_at IS NULL OR lease_until_at < $6) RETURNING repo_id`,
      [repo.id, new Date(now + LEASE_MS), repo.owner, repo.name, installationId, new Date(now)],
    );
    return rows.length > 0;
  }

  private async read(repo: RepoRef, installationId: number, now: number): Promise<void> {
    const { db } = this.deps;
    const { rows } = await db.query<{ raw: Raw | null; icon_oid: string | null }>('SELECT raw, icon_oid FROM repo_status WHERE repo_id = $1', [repo.id]);
    try {
      const got = await this.fetch(installationId, repo, rows[0]?.raw ?? null, rows[0]?.icon_oid ?? null, now);
      await db.query(
        `UPDATE repo_status SET stats = $2, raw = $3, fetched_at = $4, checked_at = $4, error = NULL, budget = $5, budget_reset_at = $6,
           icon = CASE WHEN $7 = 1 THEN $8 ELSE icon END, icon_oid = CASE WHEN $7 = 1 THEN $9 ELSE icon_oid END, lease_until_at = NULL
         WHERE repo_id = $1`,
        [repo.id, got.stats, got.raw, new Date(now), got.budget?.remaining ?? null, got.budget?.resetAt ?? null, got.icon ? 1 : 0, got.icon?.png ?? null, got.icon?.oid ?? null],
      );
    } catch (err) {
      const e = err as Error;
      if (err instanceof GitHubApiError && err.isRateLimit) {
        this.budgets.set(installationId, { remaining: 0, resetAt: new Date(now + Math.max(300, err.retryAfterSeconds ?? 300) * 1000) });
      }
      const message = err instanceof GitHubApiError && (err.status === 404 || err.status === 403) && !err.isRateLimit
        ? 'GitHub didn’t let the app read this repository. It needs Contents and Pull requests: Read.'
        : err instanceof GitHubApiError && err.isRateLimit ? 'GitHub’s hourly budget ran out: reading again when it resets.' : e.message.slice(0, 200);
      this.deps.log.warn({ repo: `${repo.owner}/${repo.name}`, err: e.message }, 'repo status read failed');
      await db.query('UPDATE repo_status SET error = $2, checked_at = $3, lease_until_at = NULL WHERE repo_id = $1', [repo.id, message, new Date(now)]);
    }
  }

  /** Reads one repository (exposed for tests through tick). */
  private async fetch(installationId: number, repo: RepoRef, prev: Raw | null, iconOid: string | null, now: number) {
    const gh = this.deps.github!;
    // A partial answer (a field GitHub won't give the app) is kept, but logged.
    const onErrors = (errors: any[]) => this.deps.log.warn({ repo: `${repo.owner}/${repo.name}`, errors: errors.slice(0, 3).map((e) => String(e?.message ?? e)) }, 'repo status: GitHub left part of the answer out');
    const ask = (query: string, variables: Record<string, unknown>) => gh.graphql(installationId, query, variables, { onErrors });
    const vars = { owner: repo.owner, name: repo.name };

    // Releases and their downloads.
    const releases: Release[] = [];
    let after: string | null = null;
    for (let page = 0; page < 4; page++) {
      const d: any = await ask(RELEASES_QUERY, { ...vars, after });
      if (!d?.repository) throw new GitHubApiError(404, 'Repository not found', null, false, null);
      const conn = d.repository.releases;
      for (const r of conn?.nodes ?? []) {
        releases.push({
          tag: String(r.tagName), url: r.url ? String(r.url) : null, draft: Boolean(r.isDraft), prerelease: Boolean(r.isPrerelease),
          publishedAt: time(r.publishedAt), createdAt: time(r.createdAt), commitSha: r.tagCommit?.oid ?? null, commitAt: time(r.tagCommit?.committedDate),
          assets: (r.releaseAssets?.nodes ?? []).map((a: any) => ({ name: String(a.name ?? ''), downloads: Number(a.downloadCount ?? 0) })),
        });
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    const rel = summarizeReleases(releases);
    const buildAt = rel.latestAt;

    // Counts, dates, each window's commits and the open issues to score.
    const starts = windowStarts(now, buildAt);
    const history = starts.map((w) => `${w.key}: history(since: "${iso(w.since)}") { totalCount }`).join('\n          ');
    const main: any = await ask(MAIN_QUERY.replace('{HISTORY}', history), vars);
    const r = main?.repository;
    if (!r) throw new GitHubApiError(404, 'Repository not found', null, false, null);
    const budget = main?.rateLimit ? { remaining: Number(main.rateLimit.remaining), resetAt: new Date(main.rateLimit.resetAt) } : null;
    if (budget) this.budgets.set(installationId, budget);
    const branch: string | null = r.defaultBranchRef?.name ?? null;
    const head = r.defaultBranchRef?.target ?? null;

    // Commits on the default branch since the latest build.
    let unreleased: number | null = null;
    let estimate = false;
    const latest = rel.latest;
    if (latest && branch) {
      const at = latest.commitAt ?? buildAt ?? new Date(now);
      const b: any = await ask(BUILD_QUERY, { ...vars, tag: `refs/tags/${latest.tag}`, branch, at: iso(at) });
      const cmp = b?.repository?.ref?.compare;
      if (cmp && typeof cmp.aheadBy === 'number') {
        unreleased = cmp.aheadBy;
        estimate = !['AHEAD', 'IDENTICAL'].includes(String(cmp.status));
      } else if (b?.repository?.defaultBranchRef?.target) {
        unreleased = count(b.repository.defaultBranchRef.target.since);
        estimate = true;
      }
    }

    // Recent commit authors, PRs and issues: since the horizon on a full read, else since the last read.
    const horizon = new Date(Math.max(now - HORIZON_MAX_MS, Math.min(now - 7 * 86_400_000, buildAt?.getTime() ?? Infinity)));
    const full = !prev || new Date(prev.horizon) > horizon || now - new Date(prev.fullAt).getTime() > FULL_MS;
    const raw: Raw = full
      ? { horizon: horizon.toISOString(), fullAt: new Date(now).toISOString(), lastAt: '', authors: {}, opened: {}, merged: {}, issues: {}, contributors: prev?.contributors ?? null, contributorsAt: prev?.contributorsAt ?? null }
      : { ...prev!, horizon: horizon.toISOString() };
    const since = full ? horizon : new Date(new Date(prev!.lastAt).getTime() - OVERLAP_MS);
    if (head) {
      after = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const d: any = await ask(AUTHORS_QUERY, { ...vars, since: iso(since), after });
        const conn = d?.repository?.defaultBranchRef?.target?.history;
        for (const c of conn?.nodes ?? []) {
          const who = c.author?.user?.login ?? c.author?.email ?? c.author?.name ?? 'someone';
          raw.authors[String(c.oid)] = [String(c.committedDate), String(who).toLowerCase()];
        }
        if (!conn?.pageInfo?.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
    }
    const cursors: Record<'opened' | 'merged' | 'issues', string | null> = { opened: null, merged: null, issues: null };
    const walking = { opened: true, merged: true, issues: true };
    for (let page = 0; page < MAX_PAGES && (walking.opened || walking.merged || walking.issues); page++) {
      const d: any = await ask(EVENTS_QUERY, {
        ...vars, opened: walking.opened, merged: walking.merged, issues: walking.issues,
        openedAfter: cursors.opened, mergedAfter: cursors.merged, issuesAfter: cursors.issues,
      });
      const repoData = d?.repository ?? {};
      const step = (key: 'opened' | 'merged' | 'issues', at: (n: any) => string | null, keep: (n: any) => string | null) => {
        if (!walking[key]) return;
        const conn = repoData[key];
        let older = false;
        for (const n of conn?.nodes ?? []) {
          const t = at(n);
          if (!t || new Date(t) < since) { older = true; continue; }
          const v = keep(n);
          if (v) raw[key][String(n.number)] = v;
        }
        walking[key] = !older && Boolean(conn?.pageInfo?.hasNextPage);
        cursors[key] = conn?.pageInfo?.endCursor ?? null;
      };
      step('opened', (n) => n.createdAt, (n) => n.createdAt);
      step('merged', (n) => n.updatedAt, (n) => n.mergedAt);
      step('issues', (n) => n.createdAt, (n) => n.createdAt);
    }
    // What's older than the horizon goes.
    const keepAfter = horizon.getTime();
    for (const key of ['opened', 'merged', 'issues'] as const) {
      for (const [k, v] of Object.entries(raw[key])) if (new Date(v).getTime() < keepAfter) delete raw[key][k];
    }
    for (const [k, v] of Object.entries(raw.authors)) if (new Date(v[0]).getTime() < keepAfter) delete raw.authors[k];
    raw.lastAt = new Date(now).toISOString();
    if (!raw.contributorsAt || now - new Date(raw.contributorsAt).getTime() > FULL_MS) {
      try {
        raw.contributors = await gh.contributorCount(installationId, repo.owner, repo.name);
        raw.contributorsAt = new Date(now).toISOString();
      } catch (err) {
        if (err instanceof GitHubApiError && err.isRateLimit) throw err;
      }
    }

    // The app icon, read again only when it changes.
    let icon: { png: string; oid: string } | null = null;
    const entry = (r.icon?.entries ?? []).find((e: any) => /\.png$/i.test(String(e?.name ?? '')));
    if (entry?.oid && entry.oid !== iconOid) {
      try {
        const bytes = await gh.blob(installationId, repo.owner, repo.name, entry.oid);
        if (bytes.length && bytes.length <= ICON_MAX && bytes.subarray(0, 4).toString('hex') === '89504e47') icon = { png: bytes.toString('base64'), oid: entry.oid };
      } catch {
        // No icon: a lettered tile.
      }
    }

    // What the page shows.
    const inWindow = (since: Date) => {
      if (since.getTime() < keepAfter - 60_000) return null;
      const after = (m: Record<string, string>) => Object.values(m).filter((v) => new Date(v) >= since).length;
      const people = new Set(Object.values(raw.authors).filter(([at]) => new Date(at) >= since).map(([, who]) => who));
      return { prs: after(raw.opened), merged: after(raw.merged), issues: after(raw.issues), people: people.size };
    };
    const activity: Record<string, Activity | null> = {};
    for (const w of starts) {
      const counted = inWindow(w.since);
      const commits = w.id === SINCE_BUILD && unreleased !== null ? unreleased : count(head?.[w.key]);
      // A build older than what's kept: its window can't be counted (its commits are in Builds).
      activity[w.id] = counted ? { commits, ...counted } : null;
    }
    activity[ALL_TIME] = { commits: count(head?.all), prs: count(r.allPrs), merged: count(r.mergedPrs), issues: count(r.allIssues), people: raw.contributors };
    const { urgent, urgency, critical } = rankIssues([...issuesOf(r.recentOpen), ...issuesOf(r.hotOpen)], new Date(now), latest?.tag ?? null, KEEP_URGENT);
    const htmlRepo = `https://github.com/${repo.owner}/${repo.name}`;
    const stats: RepoStats = {
      defaultBranch: branch,
      openPrs: count(r.openPrs),
      openIssues: count(r.openIssues),
      oldestOpenPrAt: first(r.oldestOpenPr, 'createdAt'),
      lastCommitAt: first(head?.all, 'committedDate'),
      lastIssueAt: first(r.newestIssue, 'createdAt'),
      newestPrAt: first(r.newestPr, 'createdAt'),
      activity,
      build: latest
        ? {
            tag: latest.tag,
            url: latest.url || `${htmlRepo}/releases/tag/${encodeURIComponent(latest.tag)}`,
            at: buildAt?.toISOString() ?? null,
            prerelease: latest.prerelease,
            downloads: rel.latestDownloads,
            totalDownloads: rel.totalDownloads,
            unreleased,
            estimate,
            compareUrl: branch ? `${htmlRepo}/compare/${encodeURIComponent(latest.tag)}...${encodeURIComponent(branch)}` : null,
          }
        : null,
      urgency,
      critical,
      urgent,
    };
    return { stats, raw, budget, icon };
  }
}

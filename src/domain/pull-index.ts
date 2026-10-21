/**
 * The pull request index: open pull requests of the indexed repositories (the apps' ones), and
 * closed ones for 90 days. Read from GitHub's pull request list, on its own every 10 minutes: the
 * issue list leaves pull requests out unless the app has Pull requests: Read, while a public
 * repository's can be listed without it. A first catch-up reads the open ones and the ones closed
 * in the last 90 days; after that, only what changed (usually one call). AI triage reads the index
 * to say a ticket is being worked on, or already fixed (and whether that fix is released), and
 * Repo status › Pull requests lists it.
 */
import type { Queryable } from '../db/database.js';
import { GitHubApiError, type PullDetail } from '../github/client.js';
import { closedIssues, noiseOf } from '../triage/knowledge-changes.js';
import type { Deps } from './types.js';

/** Closed pull requests are kept this long after they were closed or merged. */
export const PULLS_KEEP_DAYS = 90;
/** How often each repository's pull requests are checked for changes, and its releases read. */
export const PULLS_EVERY_MS = 10 * 60_000;
const RELEASES_EVERY_MS = 30 * 60_000;
/** A catch-up that failed (a timeout, say) is tried again this soon. */
const PULLS_RETRY_MS = 2 * 60_000;
const PULLS_LEASE_MS = 2 * 60_000;
/** Page caps: the catch-up's two lists, and a regular check. */
const CATCH_UP_PAGES = 10;
const CHECK_PAGES = 5;
/** Repositories read per round of the index loop. */
const PULLS_PER_ROUND = 4;
const EXCERPT_CHARS = 600;

export interface IndexedPull {
  repo_id: number;
  number: number;
  title: string;
  excerpt: string;
  author: string | null;
  labels: string[];
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: Date | null;
  closes: number[];
  mentions: number[];
  noise: string | null;
  html_url: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface Release {
  tag: string;
  at: string;
}

/** Other issues a pull request names without a closing keyword ("for #12", "see #3"), not itself. */
export function mentionedIssues(text: string, self: number, closes: number[]): number[] {
  const all = [...text.matchAll(/(?:^|[^\w&/])#(\d{1,7})\b/g)].map((m) => Number(m[1]));
  return [...new Set(all)].filter((n) => n !== self && !closes.includes(n)).slice(0, 5);
}

/** The start of a description: no comments, images, checklists or long blank runs. */
function excerptOf(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/^\s*- \[[ x]\] .*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_CHARS);
}

/** Keeps pull requests (or forgets closed ones past PULLS_KEEP_DAYS). */
export async function upsertPulls(q: Queryable, repoId: number, pulls: PullDetail[], now = Date.now()): Promise<void> {
  for (const p of pulls) await upsertPull(q, repoId, p, now);
}

async function upsertPull(q: Queryable, repoId: number, p: PullDetail, now: number): Promise<void> {
  if (p.state === 'closed' && (p.closedAt?.getTime() ?? p.updatedAt.getTime()) < now - PULLS_KEEP_DAYS * 86_400_000) {
    await q.query('DELETE FROM pull_index WHERE repo_id = $1 AND number = $2', [repoId, p.number]);
    return;
  }
  const text = `${p.title}\n${p.body}`;
  const closes = closedIssues(text).filter((n) => n !== p.number);
  await q.query(
    `INSERT INTO pull_index (repo_id, number, title, excerpt, author, labels, state, draft, merged_at, closes, mentions, noise, html_url, created_at, updated_at, closed_at, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now_ms())
     ON CONFLICT (repo_id, number) DO UPDATE SET
       title = excluded.title, excerpt = excluded.excerpt, author = excluded.author, labels = excluded.labels, state = excluded.state,
       draft = excluded.draft, merged_at = excluded.merged_at, closes = excluded.closes, mentions = excluded.mentions, noise = excluded.noise,
       html_url = excluded.html_url, updated_at = excluded.updated_at, closed_at = excluded.closed_at, indexed_at = now_ms()`,
    [
      repoId, p.number, p.title.slice(0, 300), excerptOf(p.body), p.author, p.labels, p.state, p.draft ? 1 : 0, p.mergedAt, closes,
      mentionedIssues(text, p.number, closes), noiseOf({ authorIsBot: p.authorIsBot, title: p.title, labels: p.labels }), p.url, p.createdAt, p.updatedAt, p.closedAt,
    ],
  );
}

/** Closed pull requests older than PULLS_KEEP_DAYS go. */
export async function prunePulls(q: Queryable, repoId: number, now = Date.now()): Promise<void> {
  await q.query(
    "DELETE FROM pull_index WHERE repo_id = $1 AND state = 'closed' AND COALESCE(closed_at, updated_at) < $2",
    [repoId, new Date(now - PULLS_KEEP_DAYS * 86_400_000)],
  );
}

/** The first release published at or after a merge: the one the fix shipped in (null: not released yet). */
export function releaseOf(mergedAt: Date, releases: Release[]): Release | null {
  const after = releases.filter((r) => new Date(r.at).getTime() >= mergedAt.getTime());
  return after.length ? after.reduce((a, b) => (new Date(a.at) < new Date(b.at) ? a : b)) : null;
}

/** A repository's recent releases, as the issue sync last read them (null: never read, or not readable). */
export async function repoReleases(q: Queryable, repoId: number): Promise<Release[] | null> {
  const { rows } = await q.query<{ releases: string | null }>('SELECT releases FROM issue_index_repos WHERE repo_id = $1', [repoId]);
  const raw = rows[0]?.releases;
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as Release[];
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Pull requests by number. */
export async function getPulls(q: Queryable, repoId: number, numbers: number[]): Promise<Map<number, IndexedPull>> {
  if (!numbers.length) return new Map();
  const { rows } = await q.query<IndexedPull>('SELECT * FROM pull_index WHERE repo_id = $1 AND number IN (SELECT value FROM json_each($2))', [repoId, numbers]);
  return new Map(rows.map((r) => [r.number, r]));
}

/** Open and merged pull requests that name these issues (closing keyword or mention), not bots or chores. */
export async function pullsForIssues(q: Queryable, repoId: number, numbers: number[]): Promise<Map<number, IndexedPull[]>> {
  const out = new Map<number, IndexedPull[]>();
  if (!numbers.length) return out;
  const { rows } = await q.query<IndexedPull>(
    `SELECT DISTINCT p.* FROM pull_index p, json_each(p.closes) c
      WHERE p.repo_id = $1 AND p.noise IS NULL AND (p.state = 'open' OR p.merged_at IS NOT NULL) AND c.value IN (SELECT value FROM json_each($2))
     UNION
     SELECT DISTINCT p.* FROM pull_index p, json_each(p.mentions) c
      WHERE p.repo_id = $1 AND p.noise IS NULL AND (p.state = 'open' OR p.merged_at IS NOT NULL) AND c.value IN (SELECT value FROM json_each($2))`,
    [repoId, numbers],
  );
  for (const p of rows) {
    for (const n of new Set([...p.closes, ...p.mentions])) {
      if (!numbers.includes(n)) continue;
      out.set(n, [...(out.get(n) ?? []), p]);
    }
  }
  // Closing ones first, then open before merged, newest first.
  for (const [n, list] of out) {
    out.set(n, list.sort((a, b) => Number(b.closes.includes(n)) - Number(a.closes.includes(n)) || Number(a.state !== 'open') - Number(b.state !== 'open') || b.updated_at.getTime() - a.updated_at.getTime()));
  }
  return out;
}

// ---- Reading them from GitHub --------------------------------------------------------------------

interface PullSyncRepo {
  repo_id: number;
  owner: string;
  name: string;
  installation_id: number;
  pulls_loaded_at: Date | null;
  pulls_synced_until: number | null;
  releases_checked_at: Date | null;
}

/**
 * Reads the pull requests of the repositories that are due: a catch-up first, then every 10
 * minutes. A few per round, so the issue sync sharing the loop stays current. Returns how many.
 */
export async function syncDuePulls(deps: Deps, now = Date.now()): Promise<number> {
  if (!deps.github) return 0;
  const { rows } = await deps.db.query<PullSyncRepo>(
    `SELECT repo_id, owner, name, installation_id, pulls_loaded_at, pulls_synced_until, releases_checked_at FROM issue_index_repos
      WHERE (pulls_lease_until_at IS NULL OR pulls_lease_until_at < $1)
        AND (pulls_checked_at IS NULL OR pulls_checked_at < $1 - CASE WHEN pulls_loaded_at IS NULL THEN $2 ELSE $3 END)
      ORDER BY pulls_loaded_at IS NOT NULL, pulls_checked_at LIMIT $4`,
    [new Date(now), PULLS_RETRY_MS, PULLS_EVERY_MS, PULLS_PER_ROUND],
  );
  for (const r of rows) await syncPulls(deps, r, now);
  return rows.length;
}

async function syncPulls(deps: Deps, repo: PullSyncRepo, now: number): Promise<void> {
  const { db, github } = deps;
  const claimed = await db.query(
    'UPDATE issue_index_repos SET pulls_lease_until_at = $2 WHERE repo_id = $1 AND (pulls_lease_until_at IS NULL OR pulls_lease_until_at < $3) RETURNING repo_id',
    [repo.repo_id, new Date(now + PULLS_LEASE_MS), new Date(now)],
  );
  if (!claimed.rows.length || !github) return;
  const list = (o: Parameters<typeof github.listPullsPage>[3]) => github.listPullsPage(repo.installation_id, repo.owner, repo.name, o);
  let newest = repo.pulls_synced_until ?? 0;
  let loaded = Boolean(repo.pulls_loaded_at);
  let error: string | null = null;
  let pauseUntil: Date | null = null;
  const keep = async (pulls: PullDetail[]) => {
    await upsertPulls(db, repo.repo_id, pulls, now);
    for (const x of pulls) newest = Math.max(newest, x.updatedAt.getTime());
  };
  try {
    if (!loaded) {
      // Every open one, then the ones closed in the last 90 days (newest first, until older).
      for (let p = 1; p <= CATCH_UP_PAGES; p++) {
        const page = await list({ state: 'open', sort: 'created', direction: 'desc', page: p, perPage: 100 });
        await keep(page.pulls);
        if (!page.more) break;
      }
      const keepAfter = now - PULLS_KEEP_DAYS * 86_400_000;
      for (let p = 1; p <= CATCH_UP_PAGES; p++) {
        const page = await list({ state: 'closed', sort: 'updated', direction: 'desc', page: p, perPage: 100 });
        await keep(page.pulls);
        if (!page.more || page.pulls.some((x) => x.updatedAt.getTime() < keepAfter)) break;
      }
      loaded = true;
    } else {
      // What changed since the last check, newest first, until it reaches what was already seen.
      const since = (repo.pulls_synced_until ?? 0) - 60_000;
      for (let p = 1; p <= CHECK_PAGES; p++) {
        const page = await list({ state: 'all', sort: 'updated', direction: 'desc', page: p, perPage: 50 });
        await keep(page.pulls);
        if (!page.more || page.pulls.some((x) => x.updatedAt.getTime() < since)) break;
      }
      await prunePulls(db, repo.repo_id, now);
    }
  } catch (err) {
    const e = err as Error;
    if (err instanceof GitHubApiError && err.isRateLimit) pauseUntil = new Date(now + Math.min(3600, Math.max(60, err.retryAfterSeconds ?? 60)) * 1000);
    error = err instanceof GitHubApiError
      ? err.isRateLimit ? 'GitHub’s hourly budget ran out: reading again when it resets.'
        : err.status === 403 || err.status === 404 ? 'GitHub didn’t let the app read this repository’s pull requests. A private repository needs Pull requests: Read.'
          : `GitHub returned ${err.status}. Trying again shortly.`
      : `GitHub couldn’t be reached (${e.message}). Trying again shortly.`;
    deps.log.warn({ repo: `${repo.owner}/${repo.name}`, err: e.message }, 'pull request sync failed');
  }
  // Releases, so a merged fix is "not released yet" or "in v1.4.3" (a failure here only waits for the next round).
  if (!error && (!repo.releases_checked_at || repo.releases_checked_at.getTime() < now - RELEASES_EVERY_MS)) {
    try {
      let releases: string | null = null;
      try {
        const found = await github.listReleases(repo.installation_id, repo.owner, repo.name, 20);
        releases = JSON.stringify(found.filter((r) => r.publishedAt).map((r) => ({ tag: r.tag, at: r.publishedAt!.toISOString() })));
      } catch (err) {
        // A private repository's releases need Contents: read. Without them, fixes are just "merged".
        if (!(err instanceof GitHubApiError) || err.isRateLimit || (err.status !== 403 && err.status !== 404)) throw err;
      }
      await db.query('UPDATE issue_index_repos SET releases = $2, releases_checked_at = $3 WHERE repo_id = $1', [repo.repo_id, releases, new Date(now)]);
    } catch (err) {
      deps.log.warn({ repo: `${repo.owner}/${repo.name}`, err: (err as Error).message }, 'release check failed');
    }
  }
  await db.query(
    `UPDATE issue_index_repos SET pulls_loaded_at = CASE WHEN $2 = 1 THEN COALESCE(pulls_loaded_at, $5) ELSE pulls_loaded_at END,
       pulls_synced_until = $3, pulls_checked_at = $5, pulls_error = $4, pulls_lease_until_at = $6 WHERE repo_id = $1`,
    [repo.repo_id, loaded && !error ? 1 : 0, newest || null, error, new Date(now), pauseUntil],
  );
}

/**
 * AI triage: the pull requests and commits Claude compares a ticket with, to say it's being worked
 * on (an open pull request) or already fixed (a merged one, or a commit pushed without one). From
 * the pull request index (kept by the issue sync) and, with Keep them up to date on, the commits
 * Knowledge tracks. Nothing is asked of GitHub here.
 */
import type { Queryable } from '../db/database.js';
import { pullsForIssues, releaseOf, repoReleases, PULLS_KEEP_DAYS, type IndexedPull, type Release } from '../domain/pull-index.js';

/** Best text matches among the pull requests, and how many in all Claude sees. */
const WORK_SEARCH = 8;
const WORK_COMMITS = 4;
const WORK_MAX = 14;
/** Characters of each one's description Claude sees. */
export const WORK_TEXT_CHARS = 400;

/** A pull request or commit as an action keeps it (and a comment names it). */
export interface WorkRef {
  /** "#123" for a pull request, the short sha for a commit. */
  ref: string;
  kind: 'pull' | 'commit';
  number?: number;
  sha?: string;
  title: string;
  url: string;
  draft?: boolean;
  /** For merged work: the release it shipped in; null when not released yet; missing when unknown. */
  release?: string | null;
}

export interface WorkItem extends WorkRef {
  state: 'open' | 'draft' | 'merged';
  text: string;
  /** The issues it says it's for ("Fixes #12", "for #12"). */
  for: number[];
  mergedAt: Date | null;
  author: string | null;
}

/** The release a merged change shipped in (null: not yet), or undefined when the repository's releases aren't known. */
function shippedIn(at: Date, releases: Release[] | null): string | null | undefined {
  if (!releases || !releases.length) return undefined;
  return releaseOf(at, releases)?.tag ?? null;
}

function fromPull(p: IndexedPull, releases: Release[] | null): WorkItem {
  const merged = p.merged_at;
  return {
    ref: `#${p.number}`, kind: 'pull', number: p.number, title: p.title, url: p.html_url, draft: p.draft,
    ...(merged ? { release: shippedIn(merged, releases) } : {}),
    state: p.state === 'open' ? (p.draft ? 'draft' : 'open') : 'merged', text: p.excerpt, for: [...p.closes, ...p.mentions], mergedAt: merged, author: p.author,
  };
}

/**
 * For a ticket in this repository: open pull requests and ones merged in the last 90 days that
 * match its text, the ones that name the issues it was matched with, and commits pushed without a
 * pull request that say they fix one of those issues. Bots and chores are left out.
 */
export async function findWork(q: Queryable, repoId: number, query: string | null, issueNumbers: number[], now = Date.now()): Promise<WorkItem[]> {
  const releases = await repoReleases(q, repoId);
  const since = new Date(now - PULLS_KEEP_DAYS * 86_400_000);
  const out = new Map<string, WorkItem>();
  // The ones about the issues it matched come first: "for #3592" is the strongest sign.
  for (const list of (await pullsForIssues(q, repoId, issueNumbers.slice(0, 10))).values()) {
    for (const p of list) if (!out.has(`#${p.number}`)) out.set(`#${p.number}`, fromPull(p, releases));
  }
  if (query) {
    try {
      const { rows } = await q.query<IndexedPull>(
        `SELECT p.* FROM pull_index_fts JOIN pull_index p ON p.rowid = pull_index_fts.rowid
          WHERE pull_index_fts MATCH $1 AND p.repo_id = $2 AND p.noise IS NULL AND (p.state = 'open' OR p.merged_at >= $3)
          ORDER BY bm25(pull_index_fts, 4.0, 1.0) LIMIT $4`,
        [query, repoId, since, WORK_SEARCH],
      );
      for (const p of rows) if (!out.has(`#${p.number}`)) out.set(`#${p.number}`, fromPull(p, releases));
    } catch {
      // Triage continues without them.
    }
  }
  if (issueNumbers.length) {
    const { rows } = await q.query<{ ref: string; title: string; body: string; url: string; author: string | null; closes: number[]; merged_at: Date }>(
      "SELECT ref, title, body, url, author, closes, merged_at FROM repo_changes WHERE repo_id = $1 AND kind = 'commit' AND noise IS NULL AND merged_at >= $2 ORDER BY merged_at DESC LIMIT 200",
      [repoId, since],
    );
    const wanted = new Set(issueNumbers);
    for (const c of rows.filter((r) => r.closes.some((n) => wanted.has(n))).slice(0, WORK_COMMITS)) {
      const short = c.ref.slice(0, 7);
      out.set(short, {
        ref: short, kind: 'commit', sha: c.ref, title: c.title, url: c.url, release: shippedIn(c.merged_at, releases),
        state: 'merged', text: c.body, for: c.closes, mergedAt: c.merged_at, author: c.author,
      });
    }
  }
  return [...out.values()].slice(0, WORK_MAX);
}

/** What an answer's ref names, if Claude was shown it ("#12", "12", or a commit's sha or its start). */
export function workByRef(ref: string | null | undefined, shown: Map<string, WorkItem>): WorkItem | null {
  if (!ref) return null;
  const r = ref.trim();
  if (shown.has(r)) return shown.get(r)!;
  if (/^\d+$/.test(r) && shown.has(`#${r}`)) return shown.get(`#${r}`)!;
  if (/^[0-9a-f]{7,40}$/i.test(r)) return [...shown.values()].find((w) => w.kind === 'commit' && w.sha!.toLowerCase().startsWith(r.toLowerCase())) ?? null;
  return null;
}

/** Just what an action keeps of it. */
export function workRef(w: WorkItem): WorkRef {
  return {
    ref: w.ref, kind: w.kind, ...(w.number ? { number: w.number } : {}), ...(w.sha ? { sha: w.sha } : {}), title: w.title.slice(0, 200), url: w.url,
    ...(w.kind === 'pull' ? { draft: Boolean(w.draft) } : {}), ...(w.state === 'merged' && w.release !== undefined ? { release: w.release } : {}),
  };
}

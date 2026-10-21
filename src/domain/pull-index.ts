/**
 * The pull request index: open pull requests of the indexed repositories, and closed ones for 90
 * days, kept from the issue index's own sync (GitHub lists pull requests with the issues, so this
 * costs no extra calls). AI triage reads it to say a ticket is being worked on, or already fixed
 * (and whether that fix is released), and Repo status › Pull requests lists it.
 */
import type { Queryable } from '../db/database.js';
import type { PullDetail } from '../github/client.js';
import { closedIssues, noiseOf } from '../triage/knowledge-changes.js';

/** Closed pull requests are kept this long after they were closed or merged. */
export const PULLS_KEEP_DAYS = 90;
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

/** Keeps a pull request from the issue sync (or forgets a closed one past PULLS_KEEP_DAYS). */
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

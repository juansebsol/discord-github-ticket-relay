/**
 * Repo status › Pull requests: the open pull requests of the watched repositories, the merged ones
 * waiting for a release, and the ones merged in the last 90 days, each with the issues it's for and
 * how many Discord tickets are about those. From the pull request index: nothing asked of GitHub.
 */
import type { Queryable } from '../db/database.js';
import { pullsForIssues, releaseOf, repoReleases, type IndexedPull, type Release } from '../domain/pull-index.js';
import type { RepoRef } from './tracker.js';

export interface LinkedIssue {
  number: number;
  title: string | null;
  state: 'open' | 'closed' | null;
  /** "Fixes #12" rather than only naming it. */
  closes: boolean;
}

export interface PullItem {
  repo: RepoRef;
  pull: IndexedPull;
  issues: LinkedIssue[];
  /** The release a merged one shipped in; null when not yet; undefined when unknown (releases not read). */
  release: Release | null | undefined;
}

export interface PullLists {
  open: PullItem[];
  /** Merged, in a repository that makes releases, and not in one yet. */
  waiting: PullItem[];
  /** Merged and released, or merged in a repository without releases. */
  merged: PullItem[];
}

const stripPrefix = (title: string) => title.replace(/^(\s*\[[^\]]*\])+\s*/, '').trim();

export async function listPulls(q: Queryable, repos: RepoRef[]): Promise<PullLists> {
  const out: PullLists = { open: [], waiting: [], merged: [] };
  for (const repo of repos) {
    const { rows } = await q.query<IndexedPull>(
      `SELECT * FROM pull_index WHERE repo_id = $1 AND noise IS NULL AND (state = 'open' OR merged_at IS NOT NULL) ORDER BY updated_at DESC LIMIT 300`,
      [repo.id],
    );
    if (!rows.length) continue;
    const numbers = [...new Set(rows.flatMap((p) => [...p.closes, ...p.mentions]))];
    const { rows: issues } = numbers.length
      ? await q.query<{ number: number; title: string; state: 'open' | 'closed' }>(
          'SELECT number, title, state FROM issue_index WHERE repo_id = $1 AND gone = 0 AND number IN (SELECT value FROM json_each($2))',
          [repo.id, numbers],
        )
      : { rows: [] };
    const known = new Map(issues.map((i) => [i.number, i]));
    const releases = await repoReleases(q, repo.id);
    for (const pull of rows) {
      const linked: LinkedIssue[] = [
        ...pull.closes.map((n) => ({ n, closes: true })),
        ...pull.mentions.map((n) => ({ n, closes: false })),
      ]
        // A mention that isn't a known issue is often another pull request: left out.
        .filter((x) => x.closes || known.has(x.n))
        .map((x) => ({ number: x.n, title: known.has(x.n) ? stripPrefix(known.get(x.n)!.title) : null, state: known.get(x.n)?.state ?? null, closes: x.closes }));
      if (pull.state === 'open') {
        out.open.push({ repo, pull, issues: linked, release: undefined });
        continue;
      }
      const release = releases ? releaseOf(pull.merged_at!, releases) : undefined;
      const item = { repo, pull, issues: linked, release };
      if (releases && releases.length && release === null) out.waiting.push(item);
      else out.merged.push(item);
    }
  }
  const byUpdated = (a: PullItem, b: PullItem) => b.pull.updated_at.getTime() - a.pull.updated_at.getTime();
  const byMerged = (a: PullItem, b: PullItem) => b.pull.merged_at!.getTime() - a.pull.merged_at!.getTime();
  out.open.sort(byUpdated);
  out.waiting.sort(byMerged);
  out.merged.sort(byMerged);
  return out;
}

/** What a pull request means for an issue it's for: being worked on, fixed and waiting, or fixed in a release. */
export interface IssueFix {
  pull: IndexedPull;
  status: 'open' | 'waiting' | 'merged';
  release: Release | null | undefined;
}

/** For each of these issues, the most relevant pull request about it (closing ones first, open before merged). */
export async function fixesFor(q: Queryable, repoId: number, numbers: number[]): Promise<Map<number, IssueFix>> {
  const out = new Map<number, IssueFix>();
  const pulls = await pullsForIssues(q, repoId, numbers);
  if (!pulls.size) return out;
  const releases = await repoReleases(q, repoId);
  for (const [n, list] of pulls) {
    const pull = list[0]!;
    if (pull.state === 'open') out.set(n, { pull, status: 'open', release: undefined });
    else {
      const release = releases ? releaseOf(pull.merged_at!, releases) : undefined;
      out.set(n, { pull, status: releases && releases.length && release === null ? 'waiting' : 'merged', release });
    }
  }
  return out;
}

/**
 * AI triage › Knowledge, changes: what gets merged into each app repository's default branch,
 * polled from GitHub every 15 minutes while Keep them up to date is on (no webhooks): pull requests,
 * commits pushed without one, and releases. Bots, dependency bumps and chores are kept but never
 * sent to Claude. Claude works the rest into the app's TRIAGE.md (an update of the parts they
 * touch, see the writer), and each ticket's prompt gets its app's recent ones right away.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import type { Deps } from '../domain/types.js';
import { GitHubApiError } from '../github/client.js';

/** Each repository is checked this often. */
export const CHECK_MS = 15 * 60_000;
/** The first check reads this far back, so tickets get some context right away. */
const BACKFILL_MS = 14 * 86_400_000;
/** Each check overlaps the last a little (clocks differ); changes already seen are skipped. */
const OVERLAP_MS = 5 * 60_000;
const LEASE_MS = 2 * 60_000;
const BODY_CHARS = 1500;
/** GitHub calls kept free for filing tickets, as for triage re-runs: checks wait while fewer are left. */
const GITHUB_RESERVE = { share: 0.2, min: 500 };

/** The note on a change Claude was given but said nothing about. */
export const NOT_USED = 'Not used';

export type ChangeKind = 'pr' | 'commit' | 'release';
export type ChangeStatus = 'pending' | 'added' | 'skipped';

export interface AppChange {
  id: string;
  repo_id: number;
  kind: ChangeKind;
  ref: string;
  title: string;
  body: string;
  author: string | null;
  url: string;
  labels: string[];
  closes: number[];
  noise: string | null;
  merged_at: Date;
  status: ChangeStatus;
  note: string | null;
  decided_at: Date | null;
}

/** "Fixes #12, closes #3" → [12, 3]. */
export function closedIssues(text: string): number[] {
  return [...new Set([...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)].map((m) => Number(m[1])))];
}

/** Why a change isn't worth Claude's time ("Bot", "Chore"), or null. */
export function noiseOf(o: { authorIsBot: boolean; title: string; labels: string[] }): string | null {
  if (o.authorIsBot) return 'Bot';
  if (o.labels.some((l) => /^(dependencies|deps|chore|ci|build|tooling|infrastructure)$/i.test(l))) return 'Chore';
  if (/^(chore|ci|build|deps|test|tests|style|refactor)(\([^)]*\))?!?:/i.test(o.title) || /^(bump|update dependency|update dependencies)\b/i.test(o.title)) return 'Chore';
  return null;
}

/** A description without comments, images and checklists, cut to size. */
function cleanBody(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/^\s*- \[[ x]\] .*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, BODY_CHARS);
}

const firstLine = (s: string) => s.split('\n')[0]!.trim();

interface Tracked {
  repo_id: number;
  owner: string;
  name: string;
  installation_id: number;
  app_ids: string[];
}

interface SyncRow {
  repo_id: number;
  installation_id: number;
  owner: string;
  name: string;
  default_branch: string | null;
  since_at: Date;
  head_sha: string | null;
  checked_at: Date | null;
  last_error: string | null;
}

export class ChangeTracker {
  constructor(readonly deps: Deps) {}

  /** Repositories of workspaces tracking changes: triage on, and Keep them up to date on. */
  private async tracked(): Promise<Tracked[]> {
    const { rows } = await this.deps.db.query<{ repo_id: number; owner: string; name: string; installation_id: number; app_id: string }>(
      `SELECT a.repo_id, a.repo_owner AS owner, a.repo_name AS name, g.installation_id, a.id AS app_id
         FROM apps a JOIN triage_settings t ON t.workspace_id = a.workspace_id
         JOIN github_connections g ON g.workspace_id = a.workspace_id AND g.status = 'active'
        WHERE (t.enabled = 1 OR t.github_enabled = 1) AND json_extract(t.triage_config, '$.knowledgeAuto') = 1`,
    );
    const byRepo = new Map<number, Tracked>();
    for (const r of rows) {
      const t = byRepo.get(r.repo_id) ?? { repo_id: r.repo_id, owner: r.owner, name: r.name, installation_id: r.installation_id, app_ids: [] };
      t.app_ids.push(r.app_id);
      byRepo.set(r.repo_id, t);
    }
    return [...byRepo.values()];
  }

  /** The repository's check, when it's due (and no other process has it). */
  private async claim(t: Tracked, now: number): Promise<SyncRow | null> {
    const { db } = this.deps;
    // A repository checked for the first time reads two weeks back.
    await db.query(
      'INSERT INTO repo_change_sync (repo_id, installation_id, owner, name, since_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (repo_id) DO NOTHING',
      [t.repo_id, t.installation_id, t.owner, t.name, new Date(now - BACKFILL_MS)],
    );
    const { rows } = await db.query<SyncRow>(
      `UPDATE repo_change_sync SET lease_until_at = $2, installation_id = $5, owner = $6, name = $7
        WHERE repo_id = $1 AND (checked_at IS NULL OR checked_at <= $3) AND (lease_until_at IS NULL OR lease_until_at < $4)
       RETURNING repo_id, installation_id, owner, name, default_branch, since_at, head_sha, checked_at, last_error`,
      [t.repo_id, new Date(now + LEASE_MS), new Date(now - CHECK_MS), new Date(now), t.installation_id, t.owner, t.name],
    );
    return rows[0] ?? null;
  }

  /** Checks the repositories that are due. Returns how many new changes it found. */
  async tick(now = Date.now()): Promise<number> {
    if (!this.deps.github) return 0;
    let found = 0;
    for (const t of await this.tracked()) {
      const rl = this.deps.github.rateLimitFor(t.installation_id);
      if (rl && rl.remaining < Math.max(GITHUB_RESERVE.min, Math.round(rl.limit * GITHUB_RESERVE.share))) continue;
      const sync = await this.claim(t, now);
      if (!sync) continue;
      try {
        found += await this.check(t, sync, now);
      } catch (err) {
        const rateLimited = err instanceof GitHubApiError && (err.isRateLimit || err.status >= 500);
        const message = err instanceof GitHubApiError && err.status === 403 && !err.isRateLimit
          ? 'GitHub didn’t allow reading the pull requests and commits. The GitHub app needs Pull requests: Read and Contents: Read.'
          : err instanceof GitHubApiError && err.status === 404 ? 'The repository can’t be read.' : (err as Error).message.slice(0, 200);
        // GitHub busy: the next round tries again. Otherwise it waits for the next check.
        await this.deps.db.query(`UPDATE repo_change_sync SET lease_until_at = NULL, last_error = $2${rateLimited ? '' : ', checked_at = $3'} WHERE repo_id = $1`, rateLimited ? [t.repo_id, message] : [t.repo_id, message, new Date(now)]);
      }
    }
    return found;
  }

  /** Reads what's new in one repository and records it for each of its apps. */
  private async check(t: Tracked, sync: SyncRow, now: number): Promise<number> {
    const { db } = this.deps;
    const gh = this.deps.github!;
    const { installation_id: inst, owner, name } = sync;
    const branch = sync.default_branch ?? (await gh.getRepoAbout(inst, owner, name)).defaultBranch ?? 'main';
    const since = sync.since_at;
    const pulls = await gh.listMergedPulls(inst, owner, name, branch, since);
    // Commits since the newest one seen last time, whatever their date (one made yesterday and
    // pushed now counts). The first check, or when that one isn't among the latest: by date.
    const latest = await gh.listBranchCommits(inst, owner, name, branch, sync.head_sha ? null : since);
    const seen = sync.head_sha ? latest.findIndex((c) => c.sha === sync.head_sha) : -1;
    const fresh = seen >= 0 ? latest.slice(0, seen) : sync.head_sha ? latest.filter((c) => c.date > since) : latest;
    // Merges, squashed pull requests ("… (#123)") and commits a pull request brought in aren't changes of their own.
    const commits: typeof fresh = [];
    for (const c of fresh) {
      if (c.parents > 1 || /^Merge (pull request|branch) /i.test(c.message) || /\(#\d+\)$/.test(firstLine(c.message))) continue;
      if (!(await gh.mergedPullsOfCommit(inst, owner, name, c.sha)).length) commits.push(c);
    }
    let releases: Awaited<ReturnType<typeof gh.listReleases>> = [];
    try {
      releases = (await gh.listReleases(inst, owner, name, 10)).filter((r) => r.publishedAt && r.publishedAt > since);
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.isRateLimit) throw err;
    }
    const changes = [
      ...pulls.map((p) => ({ kind: 'pr' as const, ref: String(p.number), title: p.title, body: cleanBody(p.body), author: p.author, url: p.url, labels: p.labels, closes: closedIssues(`${p.title}\n${p.body}`), noise: noiseOf(p), at: p.mergedAt })),
      ...commits.map((c) => ({ kind: 'commit' as const, ref: c.sha, title: firstLine(c.message).slice(0, 200), body: cleanBody(c.message.split('\n').slice(1).join('\n')), author: c.author, url: c.url, labels: [] as string[], closes: closedIssues(c.message), noise: noiseOf({ authorIsBot: c.authorIsBot, title: firstLine(c.message), labels: [] }), at: c.date })),
      ...releases.map((r) => ({ kind: 'release' as const, ref: r.tag, title: r.name || r.tag, body: cleanBody(r.body), author: null, url: `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(r.tag)}`, labels: [] as string[], closes: [] as number[], noise: null, at: r.publishedAt! })),
    ];
    let found = 0;
    for (const c of changes) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO repo_changes (id, repo_id, kind, ref, title, body, author, url, labels, closes, noise, merged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (repo_id, kind, ref) DO NOTHING RETURNING id`,
        [randomUUID(), t.repo_id, c.kind, c.ref, c.title, c.body, c.author, c.url, c.labels, c.closes, c.noise, c.at],
      );
      const id = rows[0]?.id;
      if (!id) continue;
      found++;
      for (const appId of t.app_ids) {
        await db.query(
          'INSERT OR IGNORE INTO app_changes (app_id, change_id, status, note, decided_at) VALUES ($1, $2, $3, $4, $5)',
          [appId, id, c.noise ? 'skipped' : 'pending', c.noise, c.noise ? new Date(now) : null],
        );
      }
    }
    await db.query(
      'UPDATE repo_change_sync SET default_branch = $2, since_at = $3, head_sha = $4, checked_at = $5, last_error = NULL, lease_until_at = NULL WHERE repo_id = $1',
      [t.repo_id, branch, new Date(Math.max(since.getTime(), now - OVERLAP_MS)), latest[0]?.sha ?? sync.head_sha, new Date(now)],
    );
    return found;
  }
}

const SELECT = `SELECT c.id, c.repo_id, c.kind, c.ref, c.title, c.body, c.author, c.url, c.labels, c.closes, c.noise, c.merged_at, x.status, x.note, x.decided_at
  FROM app_changes x JOIN repo_changes c ON c.id = x.change_id`;

/** An app's latest changes, newest first (its page). */
export async function appChanges(q: Queryable, appId: string, limit = 15): Promise<AppChange[]> {
  const { rows } = await q.query<AppChange>(`${SELECT} WHERE x.app_id = $1 ORDER BY c.merged_at DESC LIMIT ${limit}`, [appId]);
  return rows;
}

/** Changes Claude hasn't looked at yet (not bots or chores), oldest first. */
export async function pendingChanges(q: Queryable, appId: string, limit = 30): Promise<AppChange[]> {
  const { rows } = await q.query<AppChange>(`${SELECT} WHERE x.app_id = $1 AND x.status = 'pending' ORDER BY c.merged_at LIMIT ${limit}`, [appId]);
  return rows;
}

/**
 * These apps' recent changes (not bots or chores), newest first: for each ticket's prompt, and for
 * a full rewrite. What Claude left out of the TRIAGE.md still goes to tickets.
 */
export async function recentChanges(q: Queryable, appIds: string[], days = 14, limit = 15): Promise<Map<string, AppChange[]>> {
  const out = new Map<string, AppChange[]>();
  for (const appId of appIds) {
    const { rows } = await q.query<AppChange>(
      `${SELECT} WHERE x.app_id = $1 AND c.noise IS NULL AND c.merged_at >= $2 ORDER BY c.merged_at DESC LIMIT ${limit}`,
      [appId, new Date(Date.now() - days * 86_400_000)],
    );
    if (rows.length) out.set(appId, rows);
  }
  return out;
}

/** Per app: changes since midnight, how many of those are in its TRIAGE.md, and how many wait. */
export async function changeCounts(q: Queryable, workspaceId: string, now = new Date()): Promise<Map<string, { today: number; added: number; pending: number }>> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const { rows } = await q.query<{ app_id: string; today: number; added: number; pending: number }>(
    `SELECT x.app_id,
            COALESCE(sum(c.merged_at >= $2), 0) AS today,
            COALESCE(sum(c.merged_at >= $2 AND x.status = 'added'), 0) AS added,
            COALESCE(sum(x.status = 'pending'), 0) AS pending
       FROM app_changes x JOIN repo_changes c ON c.id = x.change_id JOIN apps a ON a.id = x.app_id
      WHERE a.workspace_id = $1 GROUP BY x.app_id`,
    [workspaceId, midnight],
  );
  return new Map(rows.map((r) => [r.app_id, { today: Number(r.today), added: Number(r.added), pending: Number(r.pending) }]));
}

/** How far a repository's check got (its app's page). */
export async function changeSync(q: Queryable, repoId: number): Promise<{ default_branch: string | null; checked_at: Date | null; last_error: string | null } | null> {
  const { rows } = await q.query<{ default_branch: string | null; checked_at: Date | null; last_error: string | null }>('SELECT default_branch, checked_at, last_error FROM repo_change_sync WHERE repo_id = $1', [repoId]);
  return rows[0] ?? null;
}

/** What Claude did with each change: worked into the TRIAGE.md, or left out (and why). */
export async function decideChanges(q: Queryable, appId: string, decisions: { id: string; status: 'added' | 'skipped'; note: string | null }[]): Promise<void> {
  for (const d of decisions) {
    await q.query("UPDATE app_changes SET status = $3, note = $4, decided_at = now_ms() WHERE app_id = $1 AND change_id = $2 AND status = 'pending'", [appId, d.id, d.status, d.note]);
  }
}

/** "#456", "abc1234", "v1.2". */
export function changeLabel(c: Pick<AppChange, 'kind' | 'ref'>): string {
  return c.kind === 'pr' ? `#${c.ref}` : c.kind === 'commit' ? c.ref.slice(0, 7) : c.ref;
}

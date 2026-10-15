/**
 * A copy of every issue in the connected repositories, searched locally to find duplicates.
 *
 * GitHub's search API only matches a few words and is rate limited, and showing Claude the
 * latest issues misses older originals. So every issue is copied here once (oldest first),
 * then kept current by asking GitHub for issues changed since the last sync, every couple of
 * minutes and right before each triage. No webhooks or extra GitHub permissions are needed.
 * Deleted or moved issues are caught by a weekly full check and by checking a duplicate's
 * original live before acting on it; their copies are deleted.
 */
import type { Queryable } from '../db/database.js';
import { GitHubApiError, type IssueDetail } from '../github/client.js';
import { MARKER_PREFIX } from '../github/issue-content.js';
import { extractDescription, STOPWORDS } from '../triage/prompt.js';
import type { Deps } from './types.js';

export const EXCERPT_CHARS = 1500;
const SYNC_EVERY_MS = 2 * 60_000;
const FULL_CHECK_EVERY_MS = 7 * 86_400_000;
const LEASE_MS = 120_000;

export interface IndexedIssue {
  repo_id: number;
  number: number;
  title: string;
  excerpt: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  app_name: string | null;
  duplicate_of: number | null;
  html_url: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  gone: number;
  indexed_at: Date;
  /** Who opened it on GitHub. */
  author: string | null;
  author_avatar: string | null;
}

export interface IndexRepo {
  repo_id: number;
  owner: string;
  name: string;
  installation_id: number;
  status: 'loading' | 'ready' | 'error';
  next_page: number;
  newest_number: number | null;
  synced_until: number | null;
  full_check_at: Date | null;
  sync_requested_at: Date | null;
  last_synced_at: Date | null;
  last_error: string | null;
  lease_until_at: Date | null;
}

// ---- What's stored -----------------------------------------------------------------------

/** The searchable start of an issue's text: the ticket's description and answers, or the body. */
export function excerptOf(body: string): string {
  const text = body.includes(MARKER_PREFIX) ? extractDescription(body) : body.replace(/<!--[\s\S]*?-->/g, '');
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT_CHARS);
}

/** The app of a ticket this app filed: the last [bracket] before the title, e.g. "[Bug] [PhotoCraft] …". */
export function appOf(title: string, body: string): string | null {
  if (!body.includes(MARKER_PREFIX)) return null;
  const groups = /^(\s*\[[^\]]*\])+/.exec(title)?.[0].match(/\[([^\]]*)\]/g) ?? [];
  const last = groups.at(-1);
  return last ? last.slice(1, -1).trim() || null : null;
}

export async function upsertIssues(q: Queryable, repoId: number, issues: IssueDetail[]): Promise<void> {
  for (const i of issues) {
    await q.query(
      `INSERT INTO issue_index (repo_id, number, title, excerpt, state, state_reason, labels, app_name, html_url, created_at, updated_at, closed_at, gone, indexed_at, author, author_avatar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, now_ms(), $13, $14)
       ON CONFLICT (repo_id, number) DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt, state = excluded.state,
         state_reason = excluded.state_reason, labels = excluded.labels, app_name = excluded.app_name, html_url = excluded.html_url,
         created_at = excluded.created_at, updated_at = excluded.updated_at, closed_at = excluded.closed_at, gone = 0, indexed_at = now_ms(),
         author = COALESCE(excluded.author, issue_index.author), author_avatar = COALESCE(excluded.author_avatar, issue_index.author_avatar)`,
      [repoId, i.number, i.title.slice(0, 300), excerptOf(i.body), i.state, i.stateReason, i.labels, appOf(i.title, i.body), i.url, i.createdAt, i.updatedAt, i.closedAt, i.author ?? null, i.authorAvatar ?? null],
    );
  }
}

/** An issue deleted or moved on GitHub: its copy is deleted too. */
export async function markGone(q: Queryable, repoId: number, number: number): Promise<void> {
  await q.query('DELETE FROM issue_index WHERE repo_id = $1 AND number = $2', [repoId, number]);
}

/** Remembers which issue a duplicate copies, so later matches link to the original. */
export async function setDuplicateOf(q: Queryable, repoId: number, number: number, original: number): Promise<void> {
  if (number === original) return;
  await q.query('UPDATE issue_index SET duplicate_of = $3 WHERE repo_id = $1 AND number = $2', [repoId, number, original]);
}

export async function getIndexed(q: Queryable, repoId: number, numbers: number[]): Promise<Map<number, IndexedIssue>> {
  if (!numbers.length) return new Map();
  const { rows } = await q.query<IndexedIssue>('SELECT * FROM issue_index WHERE repo_id = $1 AND number IN (SELECT value FROM json_each($2))', [repoId, JSON.stringify(numbers)]);
  return new Map(rows.map((r) => [r.number, r]));
}

// ---- Search ------------------------------------------------------------------------------

const EXTRA_STOPWORDS = new Set('i im ive id ill me my mine we us it its is am be was do did done using use used try tried trying want wanted need needs one two also still even every each other another something anything thing things way ways work works working time times now new old way'.split(' '));

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(\s*\[[^\]]*\])+/, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w) && !EXTRA_STOPWORDS.has(w));
}

/**
 * A full-text query from a ticket: every distinctive title word, then the description's most
 * frequent ones. Each word is quoted, so nothing a member types is read as search syntax.
 */
export function ftsQuery(title: string, description = '', maxTerms = 16): string | null {
  const fromTitle = [...new Set(words(title))];
  const counts = new Map<string, number>();
  for (const w of words(description)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const fromText = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([w]) => w).filter((w) => !fromTitle.includes(w));
  const terms = [...fromTitle, ...fromText].slice(0, maxTerms);
  return terms.length ? terms.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ') : null;
}

export interface SearchHit extends IndexedIssue {
  score: number;
  /** The description around the matching words, wrapped in \u0001 … \u0002 (escape, then turn into <mark>). */
  snippet: string | null;
}

/** Best matches first (titles count four times as much as descriptions). */
export async function searchIndex(
  q: Queryable,
  o: { repoIds: number[]; query: string; limit: number; state?: 'open' | 'closed'; exclude?: { repoId: number; number: number } },
): Promise<SearchHit[]> {
  const params: unknown[] = [o.query, JSON.stringify(o.repoIds)];
  const where = ['issue_index_fts MATCH $1', 'i.repo_id IN (SELECT value FROM json_each($2))', 'i.gone = 0'];
  if (o.state) {
    params.push(o.state);
    where.push(`i.state = $${params.length}`);
  }
  if (o.exclude) {
    params.push(o.exclude.repoId, o.exclude.number);
    where.push(`NOT (i.repo_id = $${params.length - 1} AND i.number = $${params.length})`);
  }
  params.push(o.limit);
  const { rows } = await q.query<SearchHit>(
    `SELECT i.*, bm25(issue_index_fts, 4.0, 1.0) AS score, snippet(issue_index_fts, 1, char(1), char(2), '…', 24) AS snippet
     FROM issue_index_fts JOIN issue_index i ON i.rowid = issue_index_fts.rowid
     WHERE ${where.join(' AND ')} ORDER BY score LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** The text a member searched for in the console, turned into a query (all words must match). */
export function consoleQuery(text: string): string | null {
  const ws = text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).slice(0, 12);
  return ws.length ? ws.map((w) => `"${w}"*`).join(' ') : null;
}

export async function recentIssues(q: Queryable, o: { repoIds: number[]; limit: number; offset: number; state?: 'open' | 'closed' }): Promise<IndexedIssue[]> {
  const params: unknown[] = [JSON.stringify(o.repoIds)];
  const where = ['repo_id IN (SELECT value FROM json_each($1))', 'gone = 0'];
  if (o.state) {
    params.push(o.state);
    where.push(`state = $${params.length}`);
  }
  params.push(o.limit, o.offset);
  const { rows } = await q.query<IndexedIssue>(`SELECT * FROM issue_index WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return rows;
}

// ---- Choosing the original ---------------------------------------------------------------

export interface Match {
  number: number;
  confidence: number;
}

export interface Original {
  number: number;
  confidence: number;
  /** The newer copy Claude matched, when the original was found by following it. */
  via: number | null;
  closed: boolean;
  /** Other issues Claude thought were the same problem. */
  others: number[];
}

type Known = Pick<IndexedIssue, 'number' | 'state' | 'created_at' | 'duplicate_of' | 'gone'>;

/** Follows "duplicate of" links to the issue everything else copies (stops at loops and gaps). */
export function followChain(number: number, known: Map<number, Known>): number {
  let n = number;
  const seen = new Set<number>([n]);
  for (let hops = 0; hops < 5; hops++) {
    const next = known.get(n)?.duplicate_of;
    if (!next || seen.has(next) || !known.has(next) || known.get(next)!.gone) break;
    seen.add(next);
    n = next;
  }
  return n;
}

/**
 * Picks the issue to link from Claude's matches: among the confident ones, follow each to its
 * original, then prefer the oldest that's still open, and only fall back to a closed one.
 */
export function chooseOriginal(matches: Match[], known: Map<number, Known>): Original | null {
  const usable = matches.filter((m) => known.has(m.number) && !known.get(m.number)!.gone);
  if (!usable.length) return null;
  const best = Math.max(...usable.map((m) => m.confidence));
  const group = usable.filter((m) => m.confidence >= best - 20);
  const targets = new Map<number, { confidence: number; via: number | null }>();
  for (const m of group) {
    const to = followChain(m.number, known);
    const prev = targets.get(to);
    if (!prev || m.confidence > prev.confidence) targets.set(to, { confidence: m.confidence, via: to === m.number ? null : m.number });
  }
  const order = [...targets.keys()].sort((a, b) => {
    const x = known.get(a)!;
    const y = known.get(b)!;
    if ((x.state === 'open') !== (y.state === 'open')) return x.state === 'open' ? -1 : 1;
    return x.created_at.getTime() - y.created_at.getTime() || a - b;
  });
  const pick = order[0]!;
  const chosen = targets.get(pick)!;
  return {
    number: pick,
    confidence: chosen.confidence,
    via: chosen.via,
    closed: known.get(pick)!.state === 'closed',
    others: usable.map((m) => m.number).filter((n) => n !== pick && n !== chosen.via),
  };
}

const DUPLICATE_COMMENT = /\b(?:possible\s+)?(?:duplicate|dupe)\s+of\s+#(\d+)/i;

/**
 * For matches closed as duplicates whose original we don't know yet, reads their comments
 * ("Duplicate of #123", GitHub's own convention) and remembers the original. At most a few calls.
 */
export async function learnOriginals(deps: Deps, repo: { repo_id: number; owner: string; name: string; installation_id: number }, known: Map<number, IndexedIssue>, numbers: number[]): Promise<void> {
  if (!deps.github) return;
  const unknown = numbers.map((n) => known.get(n)).filter((i): i is IndexedIssue => Boolean(i && !i.duplicate_of && (i.state_reason === 'duplicate' || i.labels.some((l) => /duplicate/i.test(l))))).slice(0, 3);
  for (const i of unknown) {
    try {
      const comments = await deps.github.listIssueComments(repo.installation_id, repo.owner, repo.name, i.number);
      const hit = comments.map((c) => DUPLICATE_COMMENT.exec(c)?.[1]).find(Boolean);
      if (hit && Number(hit) !== i.number) {
        i.duplicate_of = Number(hit);
        await setDuplicateOf(deps.db, repo.repo_id, i.number, Number(hit));
      }
    } catch {
      // Best effort: the match is used as it is.
    }
  }
  // Make sure the originals we now point to are known too.
  const missing = [...new Set([...known.values()].map((i) => i.duplicate_of).filter((n): n is number => Boolean(n) && !known.has(n!)))];
  for (const [n, row] of await getIndexed(deps.db, repo.repo_id, missing)) known.set(n, row);
}

// ---- Syncing -----------------------------------------------------------------------------

/** Every repository used by an app in a workspace with GitHub connected; repositories no app uses any more are forgotten. */
export async function ensureRepos(q: Queryable): Promise<void> {
  const { rows } = await q.query<{ repo_id: number; repo_owner: string; repo_name: string; installation_id: number }>(
    `SELECT a.repo_id, a.repo_owner, a.repo_name, max(g.installation_id) AS installation_id
     FROM apps a JOIN github_connections g ON g.workspace_id = a.workspace_id AND g.status = 'active'
     GROUP BY a.repo_id`,
  );
  for (const r of rows) {
    await q.query(
      `INSERT INTO issue_index_repos (repo_id, owner, name, installation_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id) DO UPDATE SET owner = excluded.owner, name = excluded.name, installation_id = excluded.installation_id`,
      [r.repo_id, r.repo_owner, r.repo_name, r.installation_id],
    );
  }
  const keep = JSON.stringify(rows.map((r) => r.repo_id));
  await q.query(`DELETE FROM issue_index WHERE repo_id NOT IN (SELECT value FROM json_each($1)) AND repo_id NOT IN (SELECT repo_id FROM apps)`, [keep]);
  await q.query(`DELETE FROM issue_index_repos WHERE repo_id NOT IN (SELECT value FROM json_each($1)) AND repo_id NOT IN (SELECT repo_id FROM apps)`, [keep]);
}

export async function getIndexRepo(q: Queryable, repoId: number): Promise<IndexRepo | null> {
  const { rows } = await q.query<IndexRepo>('SELECT * FROM issue_index_repos WHERE repo_id = $1', [repoId]);
  return rows[0] ?? null;
}

export interface RepoStatus extends IndexRepo {
  indexed: number;
  open: number;
}

export async function indexStatus(q: Queryable, repoIds: number[]): Promise<RepoStatus[]> {
  const { rows } = await q.query<RepoStatus>(
    `SELECT r.*, (SELECT count(*) FROM issue_index i WHERE i.repo_id = r.repo_id AND i.gone = 0) AS indexed,
       (SELECT count(*) FROM issue_index i WHERE i.repo_id = r.repo_id AND i.gone = 0 AND i.state = 'open') AS open
     FROM issue_index_repos r WHERE r.repo_id IN (SELECT value FROM json_each($1)) ORDER BY r.owner, r.name`,
    [JSON.stringify(repoIds)],
  );
  return rows;
}

export async function requestSync(q: Queryable, repoIds: number[]): Promise<void> {
  await q.query('UPDATE issue_index_repos SET sync_requested_at = now_ms() WHERE repo_id IN (SELECT value FROM json_each($1))', [JSON.stringify(repoIds)]);
}

export class IssueIndexer {
  constructor(private readonly deps: Deps) {}

  /** Syncs every repository that's due (first load, changes every 2 minutes, or "Sync now"). */
  async tick(): Promise<void> {
    if (!this.deps.github) return;
    await ensureRepos(this.deps.db);
    const { rows } = await this.deps.db.query<IndexRepo>(
      `SELECT * FROM issue_index_repos
       WHERE (lease_until_at IS NULL OR lease_until_at < now_ms())
         AND (status = 'loading' OR sync_requested_at IS NOT NULL OR last_synced_at IS NULL OR last_synced_at < now_ms() - $1)`,
      [SYNC_EVERY_MS],
    );
    for (const repo of rows) await this.sync(repo.repo_id, { pages: repo.status === 'loading' ? 10 : 5 });
  }

  /**
   * Brings one repository up to date within a page budget (100 issues per page). A first load
   * continues where it stopped on the next call. Returns quietly if another process is syncing it.
   */
  async sync(repoId: number, o: { pages: number; /** true: now; false: never (quick refresh before triage); default: weekly */ fullCheck?: boolean } = { pages: 5 }): Promise<IndexRepo | null> {
    const { db, github } = this.deps;
    if (!github) return null;
    const claimed = await db.query<IndexRepo>(
      `UPDATE issue_index_repos SET lease_until_at = now_ms() + $2 WHERE repo_id = $1 AND (lease_until_at IS NULL OR lease_until_at < now_ms()) RETURNING *`,
      [repoId, LEASE_MS],
    );
    const repo = claimed.rows[0];
    if (!repo) return getIndexRepo(db, repoId);
    let pauseUntil: number | null = null;
    try {
      let budget = o.pages;
      if (repo.status === 'loading' || repo.synced_until === null) {
        // First load, oldest issues first. Changes made meanwhile are picked up afterwards.
        if (repo.next_page === 1) {
          const newest = await github.listIssuesPage(repo.installation_id, repo.owner, repo.name, { sort: 'created', direction: 'desc', page: 1, perPage: 1 });
          repo.newest_number = newest.issues[0]?.number ?? 0;
          repo.synced_until = Date.now() - 60_000;
        }
        let done = false;
        while (budget-- > 0) {
          const page = await github.listIssuesPage(repo.installation_id, repo.owner, repo.name, { sort: 'created', direction: 'asc', page: repo.next_page });
          await upsertIssues(db, repoId, page.issues);
          repo.next_page++;
          if (!page.more) {
            done = true;
            break;
          }
        }
        await db.query(
          `UPDATE issue_index_repos SET status = $2, next_page = $3, newest_number = $4, synced_until = $5, full_check_at = CASE WHEN $2 = 'ready' THEN now_ms() ELSE full_check_at END,
             last_synced_at = now_ms(), last_error = NULL, sync_requested_at = NULL WHERE repo_id = $1`,
          [repoId, done ? 'ready' : 'loading', repo.next_page, repo.newest_number, repo.synced_until],
        );
        if (!done) return getIndexRepo(db, repoId);
      }

      // Issues changed since the last sync (new, edited, closed, reopened, relabelled).
      const since = new Date((repo.synced_until ?? Date.now()) - 60_000);
      let newest = repo.synced_until ?? 0;
      for (let p = 1; budget-- > 0; p++) {
        const page = await github.listIssuesPage(repo.installation_id, repo.owner, repo.name, { sort: 'updated', direction: 'asc', page: p, since });
        await upsertIssues(db, repoId, page.issues);
        for (const i of page.issues) newest = Math.max(newest, i.updatedAt.getTime());
        if (!page.more) break;
      }

      // Weekly: anything no longer listed was deleted or moved to another repository.
      const fullDue = o.fullCheck ?? (!repo.full_check_at || repo.full_check_at.getTime() < Date.now() - FULL_CHECK_EVERY_MS);
      if (fullDue) {
        const seen: number[] = [];
        for (let p = 1; p <= 1000; p++) {
          const page = await github.listIssuesPage(repo.installation_id, repo.owner, repo.name, { sort: 'created', direction: 'asc', page: p });
          seen.push(...page.issues.map((i) => i.number));
          // The full list also refreshes every copy (and fills in details added later, like the author).
          await upsertIssues(db, repoId, page.issues);
          if (!page.more) break;
        }
        await db.query('DELETE FROM issue_index WHERE repo_id = $1 AND number NOT IN (SELECT value FROM json_each($2))', [repoId, JSON.stringify(seen)]);
      }

      await db.query(
        `UPDATE issue_index_repos SET status = 'ready', synced_until = $2, last_synced_at = now_ms(), last_error = NULL, sync_requested_at = NULL,
           full_check_at = CASE WHEN $3 THEN now_ms() ELSE full_check_at END WHERE repo_id = $1`,
        [repoId, newest, fullDue],
      );
    } catch (err) {
      const message = err instanceof GitHubApiError
        ? err.isRateLimit ? 'GitHub rate limit; continuing shortly.' : err.status === 404 || err.status === 403 ? 'The GitHub App can’t read this repository’s issues.' : `GitHub returned ${err.status}.`
        : 'GitHub couldn’t be reached.';
      if (err instanceof GitHubApiError && err.isRateLimit) pauseUntil = Date.now() + Math.min(3600, Math.max(60, err.retryAfterSeconds ?? 60)) * 1000;
      await db.query(
        `UPDATE issue_index_repos SET status = CASE WHEN status = 'loading' THEN 'loading' ELSE 'error' END, last_error = $2, last_synced_at = now_ms(), sync_requested_at = NULL WHERE repo_id = $1`,
        [repoId, message],
      );
      this.deps.log.warn({ repo: `${repo.owner}/${repo.name}`, err: (err as Error).message }, 'issue index sync failed');
    } finally {
      await db.query('UPDATE issue_index_repos SET lease_until_at = $2 WHERE repo_id = $1', [repoId, pauseUntil]);
    }
    return getIndexRepo(db, repoId);
  }

  /** Before triaging: make sure the repository is known and pick up the latest changes (best effort). */
  async refresh(repo: { repo_id: number; owner: string; name: string; installation_id: number }): Promise<IndexRepo | null> {
    await this.deps.db.query(
      `INSERT INTO issue_index_repos (repo_id, owner, name, installation_id) VALUES ($1, $2, $3, $4) ON CONFLICT (repo_id) DO NOTHING`,
      [repo.repo_id, repo.owner, repo.name, repo.installation_id],
    );
    try {
      return await this.sync(repo.repo_id, { pages: 3, fullCheck: false });
    } catch {
      return getIndexRepo(this.deps.db, repo.repo_id);
    }
  }
}

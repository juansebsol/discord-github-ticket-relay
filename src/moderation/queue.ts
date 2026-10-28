/**
 * Ticket management's lists: the open issues of the workspace's repositories (Discord tickets and
 * issues opened on GitHub), from the issue index, with what triage and moderators found about
 * each. Every query is limited to the repositories the workspace has an app for.
 */
import type { Queryable } from '../db/database.js';
import type { AppRow } from '../domain/types.js';
import { consoleQuery, getIndexed, type IndexedIssue } from '../domain/issue-index.js';
import { pullsForIssues, releaseOf, repoReleases, type IndexedPull, type Release } from '../domain/pull-index.js';

export const QUEUES = [
  { key: 'open', label: 'All open', desc: 'Every open ticket and issue.' },
  { key: 'repeat', label: 'Repeat bugs', desc: 'Duplicates, found by triage or marked by a moderator, grouped under the original.' },
  { key: 'fixed', label: 'Fixed, still open', desc: 'A merged pull request fixes it, or triage found it was already fixed.' },
  { key: 'quiet', label: 'Needs info, quiet', desc: 'Waiting for details, with nothing new for 14 days.' },
  { key: 'spam', label: 'Spam', desc: 'Triage thinks it’s spam, or it has the spam label.' },
  { key: 'old', label: 'Old', desc: 'Nothing new for 90 days.' },
  { key: 'closed', label: 'Closed by mods', desc: 'Closed here in the last 30 days.' },
] as const;
export type QueueKey = (typeof QUEUES)[number]['key'];

export function isQueue(v: unknown): v is QueueKey {
  return typeof v === 'string' && QUEUES.some((q) => q.key === v);
}

const DAY = 86_400_000;
export const QUIET_DAYS = 14;
export const OLD_DAYS = 90;
export const CLOSED_DAYS = 30;

export type Source = 'all' | 'discord' | 'github';

/** An issue, as "repo id-number" in links and forms. */
export interface IssueKey {
  repoId: number;
  number: number;
}

export function parseKey(v: unknown): IssueKey | null {
  const m = typeof v === 'string' ? /^(\d{1,15})-(\d{1,9})$/.exec(v) : null;
  return m ? { repoId: Number(m[1]), number: Number(m[2]) } : null;
}

export function keyOf(k: IssueKey): string {
  return `${k.repoId}-${k.number}`;
}

export interface QueueScope {
  workspaceId: string;
  apps: AppRow[];
  /** One app (its repository, and its name where several apps share the repository). */
  app?: AppRow | null;
  source: Source;
  search?: string;
  /** Only the duplicates of this original (Repeat bugs). */
  orig?: IssueKey | null;
}

/** Label names (lower case) that mean spam and "needs info", from triage and the close reasons. */
export interface QueueLabels {
  spam: string[];
  needsInfo: string[];
}

export interface QueueRow {
  repo_id: number;
  number: number;
  title: string;
  labels: string[];
  html_url: string;
  created_at: Date;
  updated_at: Date;
  app_name: string | null;
  author: string | null;
  sub_id: string | null;
  sub_ref: string | null;
  reporter: string | null;
  /** The original it duplicates (moderator or triage), and triage's confidence when it's only a suggestion. */
  dup_of: number | null;
  dup_conf: number | null;
  /** A moderator marked it (mod_actions), rather than triage. */
  dup_marked: number;
  /** A merged pull request that says it fixes this. */
  fixed_by: number | null;
  triage_fixed: number;
  spam_conf: number | null;
  spam_label: number;
  needs_info: number;
}

/** What the search box understood: a ticket reference, an issue, or words. */
export type Search = { kind: 'ref'; ref: string } | { kind: 'issue'; repoId: number | null; number: number } | { kind: 'words'; fts: string } | null;

export function parseSearch(raw: string | undefined, apps: AppRow[]): Search {
  const text = (raw ?? '').trim().slice(0, 200);
  if (!text) return null;
  if (/^TR-[A-Z0-9]{4,20}$/i.test(text)) return { kind: 'ref', ref: text.toUpperCase() };
  const url = /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(text);
  if (url) {
    const app = apps.find((a) => a.repo_owner.toLowerCase() === url[1]!.toLowerCase() && a.repo_name.toLowerCase() === url[2]!.toLowerCase());
    return app ? { kind: 'issue', repoId: app.repo_id, number: Number(url[3]) } : { kind: 'issue', repoId: -1, number: Number(url[3]) };
  }
  const num = /^(?:([\w.-]+)#|#)?(\d{1,9})$/.exec(text);
  if (num) {
    const app = num[1] ? apps.find((a) => a.repo_name.toLowerCase() === num[1]!.toLowerCase() || `${a.repo_owner}/${a.repo_name}`.toLowerCase() === num[1]!.toLowerCase()) : null;
    return { kind: 'issue', repoId: num[1] ? (app?.repo_id ?? -1) : null, number: Number(num[2]) };
  }
  const fts = consoleQuery(text);
  return fts ? { kind: 'words', fts } : null;
}

const json = (v: unknown) => JSON.stringify(v);
const hasKind = (col: string, kind: string) => `EXISTS (SELECT 1 FROM json_each(COALESCE(${col}, '[]')) a WHERE json_extract(a.value, '$.kind') = '${kind}')`;
const confOf = (col: string, kind: string) => `(SELECT json_extract(a.value, '$.confidence') FROM json_each(COALESCE(${col}, '[]')) a WHERE json_extract(a.value, '$.kind') = '${kind}' LIMIT 1)`;

/** Each list as a condition on q (the open issues with what's known about them). */
function queueWhere(key: Exclude<QueueKey, 'closed'>, now: number): string {
  switch (key) {
    case 'open': return '1';
    case 'repeat': return 'q.dup_of IS NOT NULL';
    case 'fixed': return '(q.fixed_by IS NOT NULL OR q.triage_fixed)';
    case 'quiet': return `(q.needs_info AND q.updated_at < ${now - QUIET_DAYS * DAY})`;
    case 'spam': return '(q.spam_conf IS NOT NULL OR q.spam_label)';
    case 'old': return `q.updated_at < ${now - OLD_DAYS * DAY}`;
  }
}

function repoIds(scope: QueueScope): number[] {
  const ids = scope.app ? [scope.app.repo_id] : scope.apps.map((a) => a.repo_id);
  return [...new Set(ids)];
}

/** The open issues with what's known about them, as a CTE named q. `params` gets the values. */
function openIssues(scope: QueueScope, labels: QueueLabels, params: unknown[]): string {
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const ws = bind(scope.workspaceId);
  const repos = bind(json(repoIds(scope)));
  const where = [`i.repo_id IN (SELECT value FROM json_each(${repos}))`, 'i.gone = 0', `i.state = 'open'`];
  if (scope.source === 'discord') where.push('s.id IS NOT NULL');
  if (scope.source === 'github') where.push('s.id IS NULL');
  // Apps sharing a repository: their tickets and issues carry the app's name.
  if (scope.app && scope.apps.filter((a) => a.repo_id === scope.app!.repo_id).length > 1) where.push(`COALESCE(s.app_name, i.app_name) = ${bind(scope.app.name)}`);
  const search = parseSearch(scope.search, scope.apps);
  if (search?.kind === 'ref') where.push(`s.ref = ${bind(search.ref)}`);
  if (search?.kind === 'issue') {
    where.push(`i.number = ${bind(search.number)}`);
    if (search.repoId !== null) where.push(`i.repo_id = ${bind(search.repoId)}`);
  }
  if (search?.kind === 'words') where.push(`i.rowid IN (SELECT rowid FROM issue_index_fts WHERE issue_index_fts MATCH ${bind(search.fts)})`);
  const spam = bind(json(labels.spam));
  const needsInfo = bind(json(labels.needsInfo));
  return `base AS (
      SELECT i.repo_id, i.number, i.title, i.labels, i.html_url, i.created_at, i.updated_at, i.app_name, i.author, i.duplicate_of,
        s.id AS sub_id, s.ref AS sub_ref, s.reporter_display_name AS reporter,
        COALESCE(tr.suggestions, it.suggestions) AS sugg, COALESCE(tr.applied_actions, it.applied_actions) AS applied
      FROM issue_index i
      LEFT JOIN submissions s ON s.id = (SELECT x.id FROM submissions x WHERE x.workspace_id = ${ws} AND x.repo_id = i.repo_id AND x.issue_number = i.number AND x.status = 'created' ORDER BY x.created_at LIMIT 1)
      LEFT JOIN triage_results tr ON tr.submission_id = s.id AND tr.status = 'done'
      LEFT JOIN issue_triage it ON s.id IS NULL AND it.workspace_id = ${ws} AND it.repo_id = i.repo_id AND it.number = i.number AND it.status = 'done'
      WHERE ${where.join(' AND ')}
    ),
    fixes AS (
      SELECT p.repo_id, CAST(c.value AS INTEGER) AS number, max(p.number) AS pr FROM pull_index p, json_each(p.closes) c
      WHERE p.repo_id IN (SELECT value FROM json_each(${repos})) AND p.merged_at IS NOT NULL GROUP BY 1, 2
    ),
    q AS (
      SELECT b.repo_id, b.number, b.title, b.labels, b.html_url, b.created_at, b.updated_at, b.app_name, b.author, b.sub_id, b.sub_ref, b.reporter,
        CASE WHEN EXISTS (SELECT 1 FROM mod_actions m WHERE m.workspace_id = ${ws} AND m.repo_id = b.repo_id AND m.number = b.number AND m.kind = 'not_duplicate' AND m.undone_at IS NULL) THEN NULL
          ELSE NULLIF(COALESCE(b.duplicate_of, (SELECT CAST(json_extract(a.value, '$.duplicateOf') AS INTEGER) FROM json_each(COALESCE(b.sugg, '[]')) a WHERE json_extract(a.value, '$.kind') = 'duplicate' LIMIT 1)), b.number) END AS dup_of,
        CASE WHEN b.duplicate_of IS NULL THEN ${confOf('b.sugg', 'duplicate')} END AS dup_conf,
        EXISTS (SELECT 1 FROM mod_actions m WHERE m.workspace_id = ${ws} AND m.repo_id = b.repo_id AND m.number = b.number AND m.kind = 'duplicate' AND m.undone_at IS NULL) AS dup_marked,
        f.pr AS fixed_by,
        (${hasKind('b.sugg', 'fixed')} OR ${hasKind('b.applied', 'fixed')}) AS triage_fixed,
        ${confOf('b.sugg', 'spam')} AS spam_conf,
        EXISTS (SELECT 1 FROM json_each(b.labels) l WHERE lower(l.value) IN (SELECT value FROM json_each(${spam}))) AS spam_label,
        (EXISTS (SELECT 1 FROM json_each(b.labels) l WHERE lower(l.value) IN (SELECT value FROM json_each(${needsInfo}))) OR ${hasKind('b.sugg', 'needsInfo')} OR ${hasKind('b.applied', 'needsInfo')}) AS needs_info
      FROM base b LEFT JOIN fixes f ON f.repo_id = b.repo_id AND f.number = b.number
    )`;
}

export type QueueCounts = Record<QueueKey, number>;

export async function queueCounts(db: Queryable, scope: QueueScope, labels: QueueLabels, now = Date.now()): Promise<QueueCounts> {
  if (!scope.apps.length) return { open: 0, repeat: 0, fixed: 0, quiet: 0, spam: 0, old: 0, closed: 0 };
  const params: unknown[] = [];
  const cte = openIssues(scope, labels, params);
  const sums = (['repeat', 'fixed', 'quiet', 'spam', 'old'] as const).map((k) => `COALESCE(sum(${queueWhere(k, now)}), 0) AS "${k}"`).join(', ');
  const [{ rows }, closed] = await Promise.all([
    db.query<Record<string, number>>(`WITH ${cte} SELECT count(*) AS "open", ${sums} FROM q`, params),
    closedCount(db, scope, now),
  ]);
  const r = rows[0] ?? {};
  return { open: Number(r.open ?? 0), repeat: Number(r.repeat ?? 0), fixed: Number(r.fixed ?? 0), quiet: Number(r.quiet ?? 0), spam: Number(r.spam ?? 0), old: Number(r.old ?? 0), closed };
}

/** One list, newest activity first (Old: the quietest first). */
export async function queueRows(db: Queryable, scope: QueueScope, labels: QueueLabels, key: Exclude<QueueKey, 'closed'>, o: { limit: number; offset?: number }, now = Date.now()): Promise<QueueRow[]> {
  if (!scope.apps.length) return [];
  const params: unknown[] = [];
  const cte = openIssues(scope, labels, params);
  const where = [queueWhere(key, now)];
  if (scope.orig) {
    params.push(scope.orig.repoId, scope.orig.number);
    where.push(`q.repo_id = $${params.length - 1} AND q.dup_of = $${params.length}`);
  }
  params.push(o.limit, o.offset ?? 0);
  const order = key === 'old' ? 'q.updated_at ASC' : 'q.updated_at DESC';
  const { rows } = await db.query<QueueRow & { labels: string | string[] }>(
    `WITH ${cte} SELECT * FROM q WHERE ${where.join(' AND ')} ORDER BY ${order}, q.number DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...r, labels: typeof r.labels === 'string' ? (JSON.parse(r.labels) as string[]) : r.labels }));
}

// ---- Closed by mods ------------------------------------------------------------------------------

/** Issues whose latest close or reopen here was a close, in the last 30 days. */
function closedWhere(scope: QueueScope, params: unknown[], now: number): string {
  params.push(scope.workspaceId, json(repoIds(scope)), now - CLOSED_DAYS * DAY);
  const [ws, repos, since] = [params.length - 2, params.length - 1, params.length].map((n) => `$${n}`);
  return `m.workspace_id = ${ws} AND m.kind = 'close' AND m.undone_at IS NULL AND m.at >= ${since} AND m.repo_id IN (SELECT value FROM json_each(${repos}))
    AND NOT EXISTS (SELECT 1 FROM mod_actions m2 WHERE m2.workspace_id = m.workspace_id AND m2.repo_id = m.repo_id AND m2.number = m.number AND m2.kind IN ('close', 'reopen') AND m2.undone_at IS NULL AND m2.at > m.at)`;
}

async function closedCount(db: Queryable, scope: QueueScope, now: number): Promise<number> {
  const params: unknown[] = [];
  const { rows } = await db.query<{ n: number }>(`SELECT count(DISTINCT m.repo_id || '-' || m.number) AS n FROM mod_actions m WHERE ${closedWhere(scope, params, now)}`, params);
  return Number(rows[0]?.n ?? 0);
}

export interface ClosedRow {
  id: string;
  repo_id: number;
  number: number;
  title: string;
  reason: string | null;
  duplicate_of: number | null;
  user_id: string | null;
  at: Date;
  sub_ref: string | null;
  html_url: string | null;
}

export async function closedRows(db: Queryable, scope: QueueScope, o: { limit: number; offset?: number }, now = Date.now()): Promise<ClosedRow[]> {
  const params: unknown[] = [];
  const where = closedWhere(scope, params, now);
  params.push(o.limit, o.offset ?? 0);
  const { rows } = await db.query<ClosedRow>(
    `SELECT m.id, m.repo_id, m.number, m.title, m.reason, m.duplicate_of, m.user_id, m.at, s.ref AS sub_ref, i.html_url
     FROM mod_actions m LEFT JOIN submissions s ON s.id = m.submission_id LEFT JOIN issue_index i ON i.repo_id = m.repo_id AND i.number = m.number
     WHERE ${where} ORDER BY m.at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

// ---- Repeat bugs, grouped under the original -----------------------------------------------------

export interface DuplicateGroup {
  repoId: number;
  /** The original (followed one step when it's a duplicate itself). */
  number: number;
  original: IndexedIssue | null;
  rows: QueueRow[];
  /** The pull request for the original (fixing it first, then open), and the release it shipped in. */
  pull: IndexedPull | null;
  release: Release | null;
}

/** Repeat bugs as groups, the biggest first. Reads up to `max` duplicates. */
export async function duplicateGroups(db: Queryable, scope: QueueScope, labels: QueueLabels, max = 1000): Promise<DuplicateGroup[]> {
  const rows = await queueRows(db, scope, labels, 'repeat', { limit: max });
  const byRepo = new Map<number, Set<number>>();
  for (const r of rows) byRepo.set(r.repo_id, (byRepo.get(r.repo_id) ?? new Set()).add(r.dup_of!));
  const originals = new Map<string, IndexedIssue>();
  for (const [repoId, numbers] of byRepo) {
    const found = await getIndexed(db, repoId, [...numbers]);
    for (const [n, i] of found) originals.set(`${repoId}-${n}`, i);
    // An original that's a duplicate itself: its original leads the group.
    const next = [...found.values()].map((i) => i.duplicate_of).filter((n): n is number => n !== null && !found.has(n));
    for (const [n, i] of await getIndexed(db, repoId, next)) originals.set(`${repoId}-${n}`, i);
  }
  const groups = new Map<string, DuplicateGroup>();
  for (const r of rows) {
    const direct = originals.get(`${r.repo_id}-${r.dup_of}`);
    const root = direct?.duplicate_of && direct.duplicate_of !== r.number ? direct.duplicate_of : r.dup_of!;
    const k = `${r.repo_id}-${root}`;
    if (!groups.has(k)) groups.set(k, { repoId: r.repo_id, number: root, original: originals.get(k) ?? null, rows: [], pull: null, release: null });
    groups.get(k)!.rows.push(r);
  }
  const list = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || Math.max(...b.rows.map((x) => x.updated_at.getTime())) - Math.max(...a.rows.map((x) => x.updated_at.getTime())));
  for (const repoId of new Set(list.map((g) => g.repoId))) {
    const mine = list.filter((g) => g.repoId === repoId);
    const [pulls, releases] = await Promise.all([pullsForIssues(db, repoId, mine.map((g) => g.number)), repoReleases(db, repoId)]);
    for (const g of mine) {
      g.pull = pulls.get(g.number)?.[0] ?? null;
      g.release = g.pull?.merged_at && releases ? releaseOf(g.pull.merged_at, releases) : null;
    }
  }
  return list;
}

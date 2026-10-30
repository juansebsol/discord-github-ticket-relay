/**
 * The MCP's ticket searches: Ticket management's list of issues (Discord tickets and issues opened
 * on GitHub, with triage's and moderators' findings), plus how many members reported each, who
 * claimed it and an open pull request for it, filtered, sorted and counted. All from the copies
 * kept here: nothing is asked of GitHub.
 */
import type { Queryable } from '../db/database.js';
import type { AppRow } from '../domain/types.js';
import { issuesCte, queueWhere, type QueueKey, type QueueLabels, type QueueRow, type Source } from '../moderation/queue.js';
import { settleClaims } from './claims.js';

export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
export const SORTS = ['priority', 'reports', 'newest', 'oldest', 'updated', 'quiet'] as const;
export type Sort = (typeof SORTS)[number];
export const LISTS = ['repeat', 'fixed', 'quiet', 'spam', 'old'] as const satisfies readonly Exclude<QueueKey, 'open' | 'closed'>[];
export type List = (typeof LISTS)[number];
export const DIMENSIONS = ['app', 'priority', 'label', 'list', 'source', 'state', 'claimed', 'has_pr', 'week', 'month'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface TicketFilter {
  workspaceId: string;
  apps: AppRow[];
  app: AppRow | null;
  state: 'open' | 'closed' | 'all';
  list: List | null;
  source: Source;
  /** Priorities, 'none' for untriaged. */
  priority: string[];
  labels: string[];
  withoutLabels: string[];
  claimed: 'me' | 'anyone' | 'nobody' | null;
  userId: string;
  hasPr: boolean | null;
  minReports: number | null;
  createdAfter: number | null;
  createdBefore: number | null;
  updatedAfter: number | null;
  updatedBefore: number | null;
  text: string;
}

export interface TicketRow extends QueueRow {
  /** Members who reported it: itself plus the issues that repeat it. */
  reports: number;
  claim_user: string | null;
  claimer: string | null;
  /** An open pull request that fixes or names it. */
  open_pr: number | null;
}

/** The issues matching the filter: the CTEs, and `FROM … WHERE …` over q (with rp: reports, cl: claim, op: open PR). */
function filtered(f: TicketFilter, labels: QueueLabels, params: unknown[], o: { labelJoin?: boolean } = {}): { with: string; from: string } {
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const cte = issuesCte({ workspaceId: f.workspaceId, apps: f.apps, app: f.app, source: f.source, search: f.text }, labels, params, f.state);
  const ws = bind(f.workspaceId);
  const repos = bind(JSON.stringify([...new Set((f.app ? [f.app] : f.apps).map((a) => a.repo_id))]));
  const dupOf = `CAST(json_extract(a.value, '$.duplicateOf') AS INTEGER)`;
  const isDup = `json_extract(a.value, '$.kind') = 'duplicate'`;
  const with_ = `WITH ${cte},
    links AS (
      SELECT repo_id, number AS src, duplicate_of AS dst FROM issue_index WHERE repo_id IN (SELECT value FROM json_each(${repos})) AND gone = 0 AND duplicate_of IS NOT NULL
      UNION SELECT t.repo_id, t.number, ${dupOf} FROM issue_triage t, json_each(COALESCE(t.suggestions, '[]')) a WHERE t.workspace_id = ${ws} AND t.suggestion_count > 0 AND ${isDup}
      UNION SELECT s.repo_id, s.issue_number, ${dupOf} FROM submissions s JOIN triage_results t ON t.submission_id = s.id, json_each(COALESCE(t.suggestions, '[]')) a
        WHERE s.workspace_id = ${ws} AND s.status = 'created' AND t.suggestion_count > 0 AND ${isDup}
    ),
    reported AS (SELECT repo_id, dst AS number, count(DISTINCT src) AS n FROM links WHERE src <> dst GROUP BY 1, 2),
    claims AS (SELECT c.repo_id, c.number, c.user_id, COALESCE(u.display_name, u.username) AS claimer FROM ticket_claims c LEFT JOIN users u ON u.id = c.user_id WHERE c.workspace_id = ${ws} AND c.ended_at IS NULL),
    openprs AS (SELECT repo_id, number, max(pr) AS pr FROM (
      SELECT p.repo_id, CAST(c.value AS INTEGER) AS number, p.number AS pr FROM pull_index p, json_each(p.closes) c WHERE p.repo_id IN (SELECT value FROM json_each(${repos})) AND p.state = 'open' AND p.noise IS NULL
      UNION ALL SELECT p.repo_id, CAST(c.value AS INTEGER), p.number FROM pull_index p, json_each(p.mentions) c WHERE p.repo_id IN (SELECT value FROM json_each(${repos})) AND p.state = 'open' AND p.noise IS NULL
    ) GROUP BY 1, 2)`;
  const now = Date.now();
  const where: string[] = [];
  if (f.list) where.push(queueWhere(f.list, now));
  if (f.priority.length) {
    const named = f.priority.filter((p) => p !== 'none');
    where.push(`(${[named.length ? `q.priority IN (SELECT value FROM json_each(${bind(JSON.stringify(named))}))` : '', f.priority.includes('none') ? 'q.priority IS NULL' : ''].filter(Boolean).join(' OR ')})`);
  }
  for (const l of f.labels) where.push(`EXISTS (SELECT 1 FROM json_each(q.labels) l WHERE lower(l.value) = lower(${bind(l)}))`);
  for (const l of f.withoutLabels) where.push(`NOT EXISTS (SELECT 1 FROM json_each(q.labels) l WHERE lower(l.value) = lower(${bind(l)}))`);
  if (f.claimed === 'me') where.push(`cl.user_id = ${bind(f.userId)}`);
  if (f.claimed === 'anyone') where.push('cl.user_id IS NOT NULL');
  if (f.claimed === 'nobody') where.push('cl.user_id IS NULL');
  if (f.hasPr !== null) where.push(f.hasPr ? 'op.pr IS NOT NULL' : 'op.pr IS NULL');
  if (f.minReports) where.push(`COALESCE(rp.n, 0) + 1 >= ${bind(f.minReports)}`);
  if (f.createdAfter) where.push(`q.created_at >= ${bind(f.createdAfter)}`);
  if (f.createdBefore) where.push(`q.created_at < ${bind(f.createdBefore)}`);
  if (f.updatedAfter) where.push(`q.updated_at >= ${bind(f.updatedAfter)}`);
  if (f.updatedBefore) where.push(`q.updated_at < ${bind(f.updatedBefore)}`);
  return {
    with: with_,
    from: `FROM q LEFT JOIN reported rp ON rp.repo_id = q.repo_id AND rp.number = q.number
      LEFT JOIN claims cl ON cl.repo_id = q.repo_id AND cl.number = q.number
      LEFT JOIN openprs op ON op.repo_id = q.repo_id AND op.number = q.number
      ${o.labelJoin ? 'LEFT JOIN json_each(q.labels) lb' : ''}
    WHERE ${where.length ? where.join(' AND ') : '1'}`,
  };
}

function select(q: { with: string; from: string }, columns: string, rest = ''): string {
  return `${q.with} SELECT ${columns} ${q.from} ${rest}`;
}

const ORDER: Record<Sort, string> = {
  priority: `CASE q.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, reports DESC, q.updated_at DESC`,
  reports: 'reports DESC, q.updated_at DESC',
  newest: 'q.created_at DESC',
  oldest: 'q.created_at ASC',
  updated: 'q.updated_at DESC',
  quiet: 'q.updated_at ASC',
};

export async function findTickets(db: Queryable, f: TicketFilter, labels: QueueLabels, o: { sort: Sort; limit: number; offset: number }): Promise<{ total: number; rows: TicketRow[] }> {
  if (!f.apps.length) return { total: 0, rows: [] };
  await settleClaims(db, f.workspaceId);
  const countParams: unknown[] = [];
  const total = await db.query<{ n: number }>(select(filtered(f, labels, countParams), 'count(*) AS n'), countParams);
  const params: unknown[] = [];
  const sql = filtered(f, labels, params);
  params.push(o.limit, o.offset);
  const { rows } = await db.query<TicketRow & { labels: string | string[] }>(
    select(sql, 'q.*, COALESCE(rp.n, 0) + 1 AS reports, cl.user_id AS claim_user, cl.claimer, op.pr AS open_pr', `ORDER BY ${ORDER[o.sort]}, q.number DESC LIMIT $${params.length - 1} OFFSET $${params.length}`),
    params,
  );
  return { total: Number(total.rows[0]?.n ?? 0), rows: rows.map((r) => ({ ...r, labels: typeof r.labels === 'string' ? (JSON.parse(r.labels) as string[]) : r.labels })) };
}

const KEY: Record<Exclude<Dimension, 'list'>, string> = {
  app: `q.repo_id || char(31) || COALESCE(q.app, '')`,
  priority: `COALESCE(q.priority, 'none')`,
  label: `COALESCE(lb.value, '(no label)')`,
  source: `CASE WHEN q.sub_id IS NULL THEN 'github' ELSE 'discord' END`,
  state: 'q.state',
  claimed: `CASE WHEN cl.user_id IS NULL THEN '(nobody)' ELSE COALESCE(cl.claimer, '(someone)') END`,
  has_pr: `CASE WHEN op.pr IS NULL THEN 'no' ELSE 'yes' END`,
  week: `strftime('%Y-W%W', q.created_at / 1000, 'unixepoch')`,
  month: `strftime('%Y-%m', q.created_at / 1000, 'unixepoch')`,
};

export interface CountGroup {
  key: string[];
  count: number;
}

/**
 * How many matching issues per value of one or two dimensions, largest first (weeks and months:
 * newest first). A ticket with several labels counts once under each. Lists: one count per list.
 */
export async function countTickets(db: Queryable, f: TicketFilter, labels: QueueLabels, by: Dimension[], max = 60): Promise<{ total: number; groups: CountGroup[] }> {
  if (!f.apps.length) return { total: 0, groups: [] };
  await settleClaims(db, f.workspaceId);
  const totalParams: unknown[] = [];
  const total = Number((await db.query<{ n: number }>(select(filtered(f, labels, totalParams), 'count(*) AS n'), totalParams)).rows[0]?.n ?? 0);
  if (by[0] === 'list') {
    const params: unknown[] = [];
    const now = Date.now();
    const sums = LISTS.map((k) => `COALESCE(sum(${queueWhere(k, now)}), 0) AS "${k}"`).join(', ');
    const r = (await db.query<Record<string, number>>(select(filtered(f, labels, params), sums), params)).rows[0] ?? {};
    return { total, groups: LISTS.map((k) => ({ key: [k], count: Number(r[k] ?? 0) })).sort((a, b) => b.count - a.count) };
  }
  const dims = by.filter((d): d is Exclude<Dimension, 'list'> => d !== 'list').slice(0, 2);
  const params: unknown[] = [];
  const sql = filtered(f, labels, params, { labelJoin: dims.includes('label') });
  const cols = dims.map((d, i) => `${KEY[d]} AS k${i}`).join(', ');
  const time = dims[0] === 'week' || dims[0] === 'month';
  params.push(max);
  const { rows } = await db.query<Record<string, string | number>>(
    select(sql, `${cols}, count(DISTINCT q.repo_id || '-' || q.number) AS n`, `GROUP BY ${dims.map((_, i) => `k${i}`).join(', ')} ORDER BY ${time ? 'k0 DESC' : 'n DESC'}, ${dims.map((_, i) => `k${i}`).join(', ')} LIMIT $${params.length}`),
    params,
  );
  const appName = (v: string) => {
    const [repo, name] = v.split('\u001f');
    const inRepo = f.apps.filter((a) => String(a.repo_id) === repo);
    return name || (inRepo.length === 1 ? inRepo[0]!.name : inRepo[0] ? `${inRepo[0].repo_owner}/${inRepo[0].repo_name}` : '(unknown)');
  };
  const groups = rows.map((r) => ({ key: dims.map((d, i) => (d === 'app' ? appName(String(r[`k${i}`])) : String(r[`k${i}`]))), count: Number(r.n) }));
  // Issues of an app's repository with no [App] prefix count under the app when it's the only one there.
  const merged = new Map<string, CountGroup>();
  for (const g of groups) {
    const k = g.key.join('\u0000');
    const prev = merged.get(k);
    if (prev) prev.count += g.count;
    else merged.set(k, { ...g });
  }
  return { total, groups: [...merged.values()].sort((a, b) => (time ? 0 : b.count - a.count)) };
}

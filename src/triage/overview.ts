/**
 * AI triage › Overview: what triage did over a window (tickets and issues it read, the actions
 * it applied or suggested, what it skipped, how sure it was, what it cost), for every app or one.
 * The labels on the open issues come from label-stats.
 */
import type { Queryable } from '../db/database.js';
import { bucketIndex, type Window } from '../analytics/time.js';

export interface TriageOverview {
  /** Read and done, per bucket: Discord tickets and issues opened on GitHub. */
  tickets: number[];
  issues: number[];
  total: number;
  /** The same over the period before (null for All). */
  prev: number | null;
  /** Actions applied (on GitHub) and still suggested, by kind; custom label categories by name. */
  actions: { kind: string; category: string | null; applied: number; suggested: number }[];
  /** Labels the applied actions and custom labels backfills added, closes among the actions, and the same before. */
  labelsAdded: number;
  prevLabelsAdded: number | null;
  closed: number;
  /** Priority Claude gave, and how sure it was of it, for what was read. */
  priority: Record<string, number>;
  confidence: { band: string; n: number }[];
  skipped: { reason: string; n: number }[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Waiting in Review now. */
  review: number;
  /** Per app (by repository for issues opened on GitHub): read in the window, actions applied. */
  byRepo: Map<number, { triaged: number; applied: number }>;
}

export interface OverviewScope {
  workspaceId: string;
  /** One app's tickets, and the issues in its repository. */
  appId: string | null;
  repoId: number | null;
}

const BANDS = [
  { band: '90–100%', min: 90 },
  { band: '70–89%', min: 70 },
  { band: '50–69%', min: 50 },
  { band: 'Below 50%', min: 0 },
];

/** Every triage result in scope, tickets and issues opened on GitHub, as one list (aliased x). */
function results(s: OverviewScope, $: (v: unknown) => string): string {
  const w = $(s.workspaceId);
  return `(SELECT 'ticket' AS src, r.completed_at AS at, r.status, r.applied_actions AS applied, r.suggestions AS sugg, r.verdict, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.skip_reason, r.suggestion_count, s.repo_id
      FROM triage_results r JOIN submissions s ON s.id = r.submission_id WHERE r.workspace_id = ${w}${s.appId ? ` AND s.app_id = ${$(s.appId)}` : ''}
    UNION ALL
    SELECT 'issue', t.completed_at, t.status, t.applied_actions, t.suggestions, t.verdict, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.skip_reason, t.suggestion_count, t.repo_id
      FROM issue_triage t WHERE t.workspace_id = ${w}${s.repoId !== null ? ` AND t.repo_id = ${$(s.repoId)}` : ''}
        AND EXISTS (SELECT 1 FROM apps a WHERE a.workspace_id = t.workspace_id AND a.repo_id = t.repo_id))`;
}

/** Labels an action adds: a custom category's picks, or its one label. */
const LABELS_OF = `CASE WHEN json_extract(a.value, '$.labels') IS NOT NULL THEN json_array_length(json_extract(a.value, '$.labels'))
  WHEN COALESCE(json_extract(a.value, '$.label'), '') <> '' THEN 1 ELSE 0 END`;

export async function triageOverview(db: Queryable, s: OverviewScope, w: Window): Promise<TriageOverview> {
  const lifetime = w.range.id === 'all';
  const query = async <T>(build: (x: string, $: (v: unknown) => string) => string): Promise<T[]> => {
    const params: unknown[] = [];
    const $ = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const sql = build(results(s, $), $);
    return (await db.query<T & Record<string, unknown>>(sql, params)).rows;
  };
  // Up to the period's end, not "now": nothing is later than now, and something done this very millisecond still counts.
  const inWindow = (x: string, $: (v: unknown) => string, from = w.start, to = w.end) => `${x}.at >= ${$(new Date(from))} AND ${x}.at < ${$(new Date(to))}`;

  // Custom labels backfills add labels without changing anyone's triage: counted from their runs.
  const backfilled = async (): Promise<{ period: string; labels: number }[]> => {
    const params: unknown[] = [s.workspaceId];
    const $ = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const when = (from: number, to: number) => `x.done_at >= ${$(new Date(from))} AND x.done_at < ${$(new Date(to))}`;
    const scope = s.appId ? `AND (i.submission_id IN (SELECT id FROM submissions WHERE app_id = ${$(s.appId)}) OR i.gh_repo_id = ${$(s.repoId)})` : '';
    const added = (list: string, extra = '') => `SELECT i.apply_done_at AS done_at, json_array_length(json_extract(a.value, '$.labels')) AS n
      FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id, json_each(${list}) a
      WHERE r.workspace_id = $1 AND json_extract(r.scope, '$.labels') IS NOT NULL AND i.apply_status = 'done' ${scope} ${extra}`;
    const now = when(w.start, w.end);
    const { rows } = await db.query<{ period: string; labels: number }>(
      `SELECT CASE WHEN ${now} THEN 'now' ELSE 'before' END AS period, sum(x.n) AS labels
       FROM (${added('i.auto_actions')} UNION ALL ${added('i.suggestions', 'AND i.apply_suggestions = 1')}) x
       WHERE (${now})${lifetime ? '' : ` OR (${when(w.prevStart, w.prevEnd)})`} GROUP BY period`,
      params,
    );
    return rows;
  };

  const [done, prev, actions, added, priority, confidence, skipped, tokens, review, byRepo, filled] = await Promise.all([
    query<{ src: string; at: Date }>((x, $) => `SELECT x.src, x.at FROM ${x} x WHERE x.status = 'done' AND ${inWindow('x', $)}`),
    lifetime ? Promise.resolve(null) : query<{ n: number }>((x, $) => `SELECT count(*) AS n FROM ${x} x WHERE x.status = 'done' AND ${inWindow('x', $, w.prevStart, w.prevEnd)}`),
    query<{ kind: string; category: string | null; applied: number; suggested: number }>((x, $) => `SELECT kind, min(category) AS category, sum(applied) AS applied, sum(1 - applied) AS suggested FROM (
        SELECT json_extract(a.value, '$.kind') AS kind, json_extract(a.value, '$.groupName') AS category, 1 AS applied FROM ${x} x, json_each(x.applied) a WHERE x.status = 'done' AND ${inWindow('x', $)}
        UNION ALL
        SELECT json_extract(a.value, '$.kind'), json_extract(a.value, '$.groupName'), 0 FROM ${x} x, json_each(x.sugg) a WHERE x.status = 'done' AND ${inWindow('x', $)}
      ) GROUP BY kind ORDER BY sum(applied) + sum(1 - applied) DESC`),
    query<{ period: string; labels: number; closed: number }>((x, $) => `SELECT CASE WHEN ${inWindow('x', $)} THEN 'now' ELSE 'before' END AS period,
        sum(${LABELS_OF}) AS labels, sum(json_extract(a.value, '$.close') = 1) AS closed
      FROM ${x} x, json_each(x.applied) a WHERE x.status = 'done' AND (${inWindow('x', $)}${lifetime ? '' : ` OR ${inWindow('x', $, w.prevStart, w.prevEnd)}`}) GROUP BY period`),
    query<{ priority: string; n: number }>((x, $) => `SELECT json_extract(x.verdict, '$.priority') AS priority, count(*) AS n FROM ${x} x WHERE x.status = 'done' AND ${inWindow('x', $)} AND x.verdict IS NOT NULL GROUP BY priority`),
    query<{ c: number | null }>((x, $) => `SELECT json_extract(x.verdict, '$.priority_confidence') AS c FROM ${x} x WHERE x.status = 'done' AND ${inWindow('x', $)} AND x.verdict IS NOT NULL`),
    query<{ reason: string; n: number }>((x, $) => `SELECT COALESCE(x.skip_reason, 'No reason given') AS reason, count(*) AS n FROM ${x} x WHERE x.status = 'skipped' AND ${inWindow('x', $)} GROUP BY reason ORDER BY n DESC LIMIT 8`),
    query<{ i: number | null; o: number | null; r: number | null; w: number | null }>((x, $) => `SELECT sum(x.input_tokens) AS i, sum(x.output_tokens) AS o, sum(x.cache_read_tokens) AS r, sum(x.cache_write_tokens) AS w FROM ${x} x WHERE ${inWindow('x', $)}`),
    query<{ n: number }>((x) => `SELECT count(*) AS n FROM ${x} x WHERE x.status = 'done' AND x.suggestion_count > 0`),
    query<{ repo_id: number; triaged: number; applied: number }>((x, $) => `SELECT x.repo_id, count(*) AS triaged, sum(json_array_length(COALESCE(x.applied, '[]'))) AS applied FROM ${x} x WHERE x.status = 'done' AND ${inWindow('x', $)} GROUP BY x.repo_id`),
    backfilled(),
  ]);

  const tickets = w.buckets.map(() => 0);
  const issues = w.buckets.map(() => 0);
  for (const r of done) {
    const i = bucketIndex(w, r.at.getTime());
    if (i >= 0) (r.src === 'ticket' ? tickets : issues)[i]!++;
  }
  const bands = BANDS.map((b) => ({ ...b, n: 0 }));
  for (const r of confidence) {
    if (typeof r.c !== 'number') continue;
    bands.find((b) => r.c! >= b.min)!.n++;
  }
  const period = (p: string) => added.find((a) => a.period === p);
  const filledIn = (p: string) => Number(filled.find((a) => a.period === p)?.labels ?? 0);
  return {
    tickets, issues,
    total: done.length,
    prev: prev ? Number(prev[0]?.n ?? 0) : null,
    actions: actions.map((a) => ({ kind: a.kind, category: a.category, applied: Number(a.applied ?? 0), suggested: Number(a.suggested ?? 0) })),
    labelsAdded: Number(period('now')?.labels ?? 0) + filledIn('now'),
    prevLabelsAdded: lifetime ? null : Number(period('before')?.labels ?? 0) + filledIn('before'),
    closed: Number(period('now')?.closed ?? 0),
    priority: Object.fromEntries(priority.filter((p) => p.priority).map((p) => [p.priority, Number(p.n)])),
    confidence: bands.map(({ band, n }) => ({ band, n })),
    skipped: skipped.map((r) => ({ reason: r.reason, n: Number(r.n) })),
    inputTokens: Number(tokens[0]?.i ?? 0),
    outputTokens: Number(tokens[0]?.o ?? 0),
    cacheReadTokens: Number(tokens[0]?.r ?? 0),
    cacheWriteTokens: Number(tokens[0]?.w ?? 0),
    review: Number(review[0]?.n ?? 0),
    byRepo: new Map(byRepo.map((r) => [r.repo_id, { triaged: Number(r.triaged), applied: Number(r.applied ?? 0) }])),
  };
}

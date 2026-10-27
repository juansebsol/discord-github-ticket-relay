/**
 * Labels on the open issues of a workspace's repositories, from our copy of every issue (kept
 * current by the issue sync): how many open issues have each label, and how many have none of a
 * custom label category's labels yet. Used by Custom labels, Re-run and Overview.
 */
import type { Queryable } from '../db/database.js';
import type { LabelGroup } from './settings.js';

export interface OpenLabels {
  /** Open issues in these repositories. */
  open: number;
  /** Open issues with each label, by lowercase name. */
  byLabel: Map<string, number>;
  /** The name as GitHub has it, by lowercase name. */
  names: Map<string, string>;
}

const OPEN = `i.repo_id IN (SELECT value FROM json_each($1)) AND i.state = 'open' AND i.gone = 0`;

export async function openLabels(db: Queryable, repoIds: readonly number[]): Promise<OpenLabels> {
  const ids = JSON.stringify([...new Set(repoIds)]);
  const [{ rows: total }, { rows }] = await Promise.all([
    db.query<{ n: number }>(`SELECT count(*) AS n FROM issue_index i WHERE ${OPEN}`, [ids]),
    db.query<{ name: string; n: number }>(
      `SELECT min(l.value) AS name, count(DISTINCT i.repo_id || ':' || i.number) AS n FROM issue_index i, json_each(i.labels) l WHERE ${OPEN} GROUP BY lower(l.value)`,
      [ids],
    ),
  ]);
  return {
    open: Number(total[0]?.n ?? 0),
    byLabel: new Map(rows.map((r) => [r.name.toLowerCase(), Number(r.n)])),
    names: new Map(rows.map((r) => [r.name.toLowerCase(), r.name])),
  };
}

/** Per category: open issues with none of its labels yet. */
export async function openMissing(db: Queryable, repoIds: readonly number[], groups: readonly Pick<LabelGroup, 'id' | 'options'>[]): Promise<Map<string, number>> {
  const ids = JSON.stringify([...new Set(repoIds)]);
  const out = new Map<string, number>();
  await Promise.all(groups.map(async (g) => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM issue_index i WHERE ${OPEN}
         AND NOT EXISTS (SELECT 1 FROM json_each(i.labels) l WHERE lower(l.value) IN (SELECT value FROM json_each($2)))`,
      [ids, JSON.stringify(g.options.map((o) => o.label.toLowerCase()))],
    );
    out.set(g.id, Number(rows[0]?.n ?? 0));
  }));
  return out;
}

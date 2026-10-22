/**
 * Analytics: what the page shows for a window (a range, a step, a time zone) and a set of
 * repositories: downloads per bucket and their breakdowns (app, platform, architecture, format,
 * version), tickets, issues opened and closed, pull requests merged and stars over the same
 * buckets, each with the period before, and release health (tickets per 1,000 downloads).
 */
import type { Queryable } from '../db/database.js';
import type { RepoRef } from '../repo-status/tracker.js';
import { ARCH_NAMES, PLATFORM_NAMES, type Platform } from './assets.js';
import { bucketIndex, SLOT_MS, type Window } from './time.js';

/** The download chart's series by platform, in fixed order (colour follows the platform). */
export const PLATFORM_SERIES: { key: string; name: string; platforms: Platform[] }[] = [
  { key: 'windows', name: 'Windows', platforms: ['windows'] },
  { key: 'macos', name: 'macOS', platforms: ['macos'] },
  { key: 'linux', name: 'Linux', platforms: ['linux'] },
  { key: 'other', name: 'Other', platforms: ['freebsd', 'web', 'other'] },
];

export interface Series {
  key: string;
  name: string;
  /** null: nothing known for that bucket (before recording began, or still to come). */
  values: (number | null)[];
}

export interface Breakdown {
  label: string;
  value: number;
  /** For platforms: the series colour slot (1–4). */
  slot?: number;
}

export interface Metric {
  total: number;
  /** The period before, or null when it isn't known (downloads before recording). */
  prev: number | null;
  values: (number | null)[];
}

export interface ReleaseHealth {
  repo: RepoRef;
  app: string;
  release: string;
  publishedAt: Date | null;
  prerelease: boolean;
  /** Until the next release (or now). */
  until: Date;
  downloads: number;
  tickets: number;
  perThousand: number | null;
  latest: boolean;
}

export interface AnalyticsData {
  /** When recording began for these repositories (the earliest), or null when it hasn't. */
  recordingSince: Date | null;
  lastRead: Date | null;
  downloads: Metric & { series: Series[]; byApp: Breakdown[]; platforms: Breakdown[]; archs: Breakdown[]; formats: Breakdown[]; versions: Breakdown[] };
  tickets: Metric;
  /** Every new issue in the repositories; fromDiscord of them were filed from a Discord ticket, the rest opened on GitHub. */
  issuesOpened: Metric & { fromDiscord: number };
  issuesClosed: Metric;
  pullsMerged: Metric;
  stars: Metric;
  /** Per app: its star total as GitHub last counted it (every 30 minutes), and the stars given in the period. */
  starsByApp: { label: string; total: number | null; gained: number }[];
  releases: ReleaseHealth[];
}

const ids = (repos: RepoRef[]) => repos.map((r) => r.id);

/** Counts per 30-minute slot into the window's buckets; buckets past `until` are null. */
function bucketed(w: Window, rows: { at: Date | number; n: number }[], knownFrom: number | null = null): (number | null)[] {
  const out: (number | null)[] = w.buckets.map((b, i) => {
    const end = w.buckets[i + 1] ?? w.end;
    if (b >= w.until) return null;
    if (knownFrom !== null && end <= knownFrom) return null;
    return 0;
  });
  for (const r of rows) {
    const i = bucketIndex(w, typeof r.at === 'number' ? r.at : r.at.getTime());
    if (i >= 0 && out[i] !== null) out[i] = (out[i] ?? 0) + Number(r.n);
  }
  return out;
}

const sum = (rows: { n: number }[]) => rows.reduce((s, r) => s + Number(r.n), 0);

/** Per-slot counts of a timestamp column in [from, to), for these repositories. */
async function perSlot(q: Queryable, sql: string, params: unknown[]): Promise<{ at: number; n: number }[]> {
  const { rows } = await q.query<{ at: number; n: number }>(sql, params);
  return rows.map((r) => ({ at: Number(r.at), n: Number(r.n) }));
}

export async function analyticsData(q: Queryable, workspaceId: string, repos: RepoRef[], w: Window, appNames: Map<number, string>): Promise<AnalyticsData> {
  const repoIds = ids(repos);
  const span = [new Date(Math.min(w.start, w.prevStart)), new Date(w.end)];
  const { rows: syncRows } = await q.query<{ started_at: Date; checked_at: Date | null }>('SELECT started_at, checked_at FROM download_sync WHERE repo_id IN (SELECT value FROM json_each($1))', [repoIds]);
  const recordingSince = syncRows.length ? new Date(Math.min(...syncRows.map((r) => r.started_at.getTime()))) : null;
  const lastReadMs = Math.max(0, ...syncRows.map((r) => r.checked_at?.getTime() ?? 0));
  // Downloads become known from the first slot after recording began.
  const knownFrom = recordingSince ? Math.floor(recordingSince.getTime() / SLOT_MS) * SLOT_MS + SLOT_MS : Infinity;

  // ---- Downloads ------------------------------------------------------------------------------
  const { rows: dl } = await q.query<{ at: number; asset_id: number; n: number }>(
    `SELECT c.slot_at AS at, c.asset_id, c.downloads AS n FROM download_counts c JOIN download_assets a ON a.id = c.asset_id
      WHERE a.repo_id IN (SELECT value FROM json_each($1)) AND a.kind <> 'meta' AND c.slot_at >= $2 AND c.slot_at < $3
     UNION ALL
     SELECT d.day_at AS at, d.asset_id, d.downloads AS n FROM download_days d JOIN download_assets a ON a.id = d.asset_id
      WHERE a.repo_id IN (SELECT value FROM json_each($1)) AND a.kind <> 'meta' AND d.day_at >= $2 AND d.day_at < $3`,
    [repoIds, span[0], span[1]],
  );
  const { rows: assets } = await q.query<{ id: number; repo_id: number; release: string; platform: Platform; arch: string | null; format: string | null; kind: string; total: number; published_at: Date | null; prerelease: number }>(
    'SELECT id, repo_id, release, platform, arch, format, kind, total, published_at, prerelease FROM download_assets WHERE repo_id IN (SELECT value FROM json_each($1))',
    [repoIds],
  );
  const byAsset = new Map(assets.map((a) => [a.id, a]));
  const rows = dl.map((r) => ({ at: Number(r.at), n: Number(r.n), a: byAsset.get(r.asset_id)! })).filter((r) => r.a);
  const inWindow = rows.filter((r) => r.at >= w.start && r.at < w.end);
  const inPrev = rows.filter((r) => r.at >= w.prevStart && r.at < w.prevEnd);
  const single = repos.length === 1;
  const series: Series[] = single
    ? PLATFORM_SERIES.map((s) => ({ key: s.key, name: s.name, values: bucketed(w, inWindow.filter((r) => s.platforms.includes(r.a.platform)), knownFrom) }))
    : [{ key: 'all', name: 'Downloads', values: bucketed(w, inWindow, knownFrom) }];
  const tally = (key: (r: (typeof inWindow)[number]) => string | null) => {
    const m = new Map<string, number>();
    for (const r of inWindow) {
      const k = key(r);
      if (k) m.set(k, (m.get(k) ?? 0) + r.n);
    }
    return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  };
  const platforms = PLATFORM_SERIES.map((s, i) => ({ label: s.name, value: inWindow.filter((r) => s.platforms.includes(r.a.platform)).reduce((t, r) => t + r.n, 0), slot: i + 1 })).filter((b) => b.value > 0);
  const versionsAll = tally((r) => (single ? r.a.release : `${appNames.get(r.a.repo_id) ?? 'App'} ${r.a.release}`));
  const versions = versionsAll.length > 8 ? [...versionsAll.slice(0, 7), { label: 'Other versions', value: versionsAll.slice(7).reduce((t, v) => t + v.value, 0) }] : versionsAll;
  const prevKnown = recordingSince !== null && knownFrom <= w.prevStart;
  const downloads = {
    total: sum(inWindow),
    prev: prevKnown ? sum(inPrev) : null,
    values: bucketed(w, inWindow, knownFrom),
    series,
    byApp: single ? [] : tally((r) => appNames.get(r.a.repo_id) ?? 'Other'),
    platforms,
    archs: tally((r) => (r.a.arch ? ARCH_NAMES[r.a.arch] ?? r.a.arch : 'Any (web builds, scripts)')),
    formats: tally((r) => (r.a.kind === 'cli' ? 'Command line (zip)' : r.a.kind === 'web' ? 'Web (zip)' : r.a.format ?? 'Other')),
    versions,
  };

  // ---- Tickets, issues, pull requests, stars ----------------------------------------------------
  const slot = (col: string) => `(${col} / ${SLOT_MS}) * ${SLOT_MS}`;
  const metric = async (rowsAll: { at: number; n: number }[]): Promise<Metric> => {
    const cur = rowsAll.filter((r) => r.at >= w.start && r.at < w.end);
    return { total: sum(cur), prev: sum(rowsAll.filter((r) => r.at >= w.prevStart && r.at < w.prevEnd)), values: bucketed(w, cur) };
  };
  const tickets = await metric(await perSlot(q,
    `SELECT ${slot('created_at')} AS at, count(*) AS n FROM submissions
      WHERE workspace_id = $1 AND source = 'discord' AND repo_id IN (SELECT value FROM json_each($2)) AND created_at >= $3 AND created_at < $4 GROUP BY 1`,
    [workspaceId, repoIds, span[0], span[1]]));
  const issuesOpened = await metric(await perSlot(q,
    `SELECT ${slot('created_at')} AS at, count(*) AS n FROM issue_index WHERE repo_id IN (SELECT value FROM json_each($1)) AND gone = 0 AND created_at >= $2 AND created_at < $3 GROUP BY 1`,
    [repoIds, span[0], span[1]]));
  // Of those, the ones filed from a Discord ticket (any workspace's: an issue is one or the other).
  const { rows: filed } = await q.query<{ n: number }>(
    `SELECT count(*) AS n FROM issue_index i WHERE i.repo_id IN (SELECT value FROM json_each($1)) AND i.gone = 0 AND i.created_at >= $2 AND i.created_at < $3
       AND EXISTS (SELECT 1 FROM submissions s WHERE s.repo_id = i.repo_id AND s.issue_number = i.number)`,
    [repoIds, new Date(w.start), new Date(w.end)],
  );
  const issuesOpenedAll = { ...issuesOpened, fromDiscord: Number(filed[0]?.n ?? 0) };
  const issuesClosed = await metric(await perSlot(q,
    `SELECT ${slot('closed_at')} AS at, count(*) AS n FROM issue_index WHERE repo_id IN (SELECT value FROM json_each($1)) AND gone = 0 AND state = 'closed' AND closed_at >= $2 AND closed_at < $3 GROUP BY 1`,
    [repoIds, span[0], span[1]]));
  // Merged pull requests: the pull request index (90 days), and what Knowledge tracked (longer, default branch).
  const pullsMerged = await metric(await perSlot(q,
    `SELECT ${slot('merged_at')} AS at, count(*) AS n FROM (
       SELECT repo_id, number, merged_at FROM pull_index WHERE repo_id IN (SELECT value FROM json_each($1)) AND merged_at >= $2 AND merged_at < $3 AND noise IS NULL
       UNION
       SELECT repo_id, CAST(ref AS INTEGER), merged_at FROM repo_changes WHERE repo_id IN (SELECT value FROM json_each($1)) AND kind = 'pr' AND noise IS NULL AND merged_at >= $2 AND merged_at < $3
     ) GROUP BY 1`,
    [repoIds, span[0], span[1]]));
  const stars = await metric(await perSlot(q,
    `SELECT ${slot('starred_at')} AS at, count(*) AS n FROM repo_stars WHERE repo_id IN (SELECT value FROM json_each($1)) AND starred_at >= $2 AND starred_at < $3 GROUP BY 1`,
    [repoIds, span[0], span[1]]));

  const { rows: totals } = await q.query<{ repo_id: number; stars_total: number | null }>('SELECT repo_id, stars_total FROM download_sync WHERE repo_id IN (SELECT value FROM json_each($1))', [repoIds]);
  const { rows: given } = await q.query<{ repo_id: number; n: number }>(
    'SELECT repo_id, count(*) AS n FROM repo_stars WHERE repo_id IN (SELECT value FROM json_each($1)) AND starred_at >= $2 AND starred_at < $3 GROUP BY repo_id',
    [repoIds, new Date(w.start), new Date(w.end)],
  );
  const totalOf = new Map(totals.map((t) => [t.repo_id, t.stars_total === null ? null : Number(t.stars_total)]));
  const gainedOf = new Map(given.map((g) => [g.repo_id, Number(g.n)]));
  const starsByApp = repos
    .map((r) => ({ label: appNames.get(r.id) ?? r.name, total: totalOf.get(r.id) ?? null, gained: gainedOf.get(r.id) ?? 0 }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || b.gained - a.gained);

  // ---- Release health: tickets while each release was the latest, per 1,000 of its downloads ----
  const releases: ReleaseHealth[] = [];
  for (const repo of repos) {
    const mine = new Map<string, { publishedAt: Date | null; prerelease: boolean; downloads: number }>();
    for (const a of assets) {
      if (a.repo_id !== repo.id || a.kind === 'meta') continue;
      const r = mine.get(a.release) ?? { publishedAt: a.published_at, prerelease: Boolean(a.prerelease), downloads: 0 };
      r.downloads += Number(a.total);
      mine.set(a.release, r);
    }
    const list = [...mine].map(([release, r]) => ({ release, ...r })).filter((r) => r.publishedAt).sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime());
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      const until = i === 0 ? new Date() : list[i - 1]!.publishedAt!;
      const { rows: t } = await q.query<{ n: number }>(
        "SELECT count(*) AS n FROM submissions WHERE workspace_id = $1 AND source = 'discord' AND repo_id = $2 AND created_at >= $3 AND created_at < $4",
        [workspaceId, repo.id, r.publishedAt, until],
      );
      const ticketsN = Number(t[0]?.n ?? 0);
      releases.push({
        repo, app: appNames.get(repo.id) ?? repo.name, release: r.release, publishedAt: r.publishedAt, prerelease: r.prerelease, until, downloads: r.downloads,
        tickets: ticketsN, perThousand: r.downloads > 0 ? (ticketsN / r.downloads) * 1000 : null, latest: i === 0,
      });
    }
  }
  releases.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));

  return { recordingSince, lastRead: lastReadMs ? new Date(lastReadMs) : null, downloads, tickets, issuesOpened: issuesOpenedAll, issuesClosed, pullsMerged, stars, starsByApp, releases: releases.slice(0, 15) };
}

export { PLATFORM_NAMES };

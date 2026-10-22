/**
 * Analytics: records downloads and stars every 30 minutes. GitHub only keeps running totals (each
 * release file's downloads, the repository's stars), so each read keeps how much they changed since
 * the read before, per 30-minute slot; nothing is known from before recording began. Runs in the
 * triage worker's polling loop (next to the issue index and Repo status), with GitHub's GraphQL
 * API: two small queries per repository every 30 minutes (releases, and the star count), on the
 * budget filing doesn't use.
 *
 * Which repositories: the ones Repo status watches (its own list, else every app's), for every
 * workspace with Analytics on.
 */
import type { Queryable } from '../db/database.js';
import type { Deps } from '../domain/types.js';
import { GitHubApiError } from '../github/client.js';
import { getStatusSettings, statusRepos, type RepoRef } from '../repo-status/tracker.js';
import { classifyAsset } from './assets.js';
import { DETAIL_DAYS, SLOT_MS, slotOf } from './time.js';

const LEASE_MS = 3 * 60_000;
/** A failed read is tried again this soon (within the same slot). */
const RETRY_MS = 5 * 60_000;
/** Reads per round of the loop. */
const PER_ROUND = 4;
/** Past this gap (the process was off, or Analytics was), growth isn't spread over the gap: recording starts again. */
const MAX_GAP_MS = 24 * 3_600_000;
const RELEASE_PAGES = 4;
const ROLLUP_EVERY_MS = 6 * 3_600_000;

const RELEASES_QUERY = `
query AnalyticsReleases($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    releases(first: 50, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { tagName isDraft isPrerelease publishedAt createdAt releaseAssets(first: 100) { nodes { name downloadCount } } }
    }
  }
}`;

// Only the count: who starred (stargazers) is more than the app's permissions let it read.
const STARS_QUERY = `
query AnalyticsStars($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { stargazerCount }
}`;

export interface AnalyticsSettings {
  enabled: boolean;
  enabledAt: Date | null;
}

export async function getAnalyticsSettings(q: Queryable, workspaceId: string): Promise<AnalyticsSettings> {
  const { rows } = await q.query<{ enabled: boolean; enabled_at: Date | null }>('SELECT enabled, enabled_at FROM analytics_settings WHERE workspace_id = $1', [workspaceId]);
  return { enabled: Boolean(rows[0]?.enabled), enabledAt: rows[0]?.enabled_at ?? null };
}

export async function setAnalyticsEnabled(q: Queryable, workspaceId: string, enabled: boolean): Promise<void> {
  await q.query(
    `INSERT INTO analytics_settings (workspace_id, enabled, enabled_at, updated_at) VALUES ($1, $2, CASE WHEN $2 = 1 THEN now_ms() END, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled,
       enabled_at = CASE WHEN excluded.enabled = 1 THEN COALESCE(CASE WHEN analytics_settings.enabled = 1 THEN analytics_settings.enabled_at END, now_ms()) ELSE analytics_settings.enabled_at END,
       updated_at = now_ms()`,
    [workspaceId, enabled ? 1 : 0],
  );
}

/** The repositories Analytics covers for a workspace: the ones Repo status watches. */
export async function analyticsRepos(q: Queryable, workspaceId: string): Promise<RepoRef[]> {
  return statusRepos(q, workspaceId, await getStatusSettings(q, workspaceId));
}

export interface SyncRow {
  repo_id: number;
  owner: string;
  name: string;
  installation_id: number;
  started_at: Date;
  last_slot_at: Date | null;
  checked_at: Date | null;
  error: string | null;
  stars_started_at: Date | null;
  stars_slot_at: Date | null;
  stars_total: number | null;
  stars_error: string | null;
  lease_until_at: Date | null;
}

export class AnalyticsRecorder {
  private rolledUpAt = 0;

  constructor(readonly deps: Deps) {}

  /** Repositories of workspaces with Analytics on, each once. */
  private async tracked(): Promise<{ repo: RepoRef; installationId: number }[]> {
    const { db } = this.deps;
    const { rows } = await db.query<{ workspace_id: string; installation_id: number }>(
      `SELECT s.workspace_id, g.installation_id FROM analytics_settings s
         JOIN github_connections g ON g.workspace_id = s.workspace_id AND g.status = 'active' WHERE s.enabled = 1`,
    );
    const out = new Map<number, { repo: RepoRef; installationId: number }>();
    for (const w of rows) for (const repo of await analyticsRepos(db, w.workspace_id)) if (!out.has(repo.id)) out.set(repo.id, { repo, installationId: w.installation_id });
    return [...out.values()];
  }

  /** Reads the repositories whose 30-minute slot has come round, a few per round. Returns how many. */
  async tick(now = Date.now()): Promise<number> {
    const { db, github } = this.deps;
    if (!github) return 0;
    if (now - this.rolledUpAt > ROLLUP_EVERY_MS) {
      this.rolledUpAt = now;
      await rollUp(db, now).catch((err) => this.deps.log.warn({ err: (err as Error).message }, 'download roll-up failed'));
    }
    const tracked = await this.tracked();
    if (!tracked.length) return 0;
    const { rows } = await db.query<SyncRow>('SELECT * FROM download_sync WHERE repo_id IN (SELECT value FROM json_each($1))', [tracked.map((t) => t.repo.id)]);
    const known = new Map(rows.map((r) => [r.repo_id, r]));
    const slot = slotOf(now);
    const due = tracked
      .filter(({ repo }) => {
        const s = known.get(repo.id);
        if (!s) return true;
        if (s.lease_until_at && s.lease_until_at.getTime() > now) return false;
        if (s.last_slot_at && s.last_slot_at.getTime() >= slot) return false;
        return !s.error || !s.checked_at || now - s.checked_at.getTime() >= RETRY_MS;
      })
      .sort((a, b) => (known.get(a.repo.id)?.last_slot_at?.getTime() ?? 0) - (known.get(b.repo.id)?.last_slot_at?.getTime() ?? 0));
    let read = 0;
    for (const t of due.slice(0, PER_ROUND)) {
      if (!(await this.claim(t.repo, t.installationId, now))) continue;
      await this.read(t.repo.id, now);
      read++;
    }
    return read;
  }

  private async claim(repo: RepoRef, installationId: number, now: number): Promise<boolean> {
    const { db } = this.deps;
    await db.query(
      `INSERT INTO download_sync (repo_id, owner, name, installation_id, started_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (repo_id) DO NOTHING`,
      [repo.id, repo.owner, repo.name, installationId, new Date(now)],
    );
    const { rows } = await db.query(
      `UPDATE download_sync SET lease_until_at = $2, owner = $3, name = $4, installation_id = $5
        WHERE repo_id = $1 AND (lease_until_at IS NULL OR lease_until_at < $6) RETURNING repo_id`,
      [repo.id, new Date(now + LEASE_MS), repo.owner, repo.name, installationId, new Date(now)],
    );
    return rows.length > 0;
  }

  private async read(repoId: number, now: number): Promise<void> {
    const { db } = this.deps;
    const sync = (await db.query<SyncRow>('SELECT * FROM download_sync WHERE repo_id = $1', [repoId])).rows[0]!;
    let error: string | null = null;
    let lastSlot = sync.last_slot_at?.getTime() ?? null;
    let startedAt = sync.started_at.getTime();
    try {
      const slot = slotOf(now);
      // A long gap (off, or the process down): recording starts again rather than inventing the gap.
      if (lastSlot !== null && slot - lastSlot > MAX_GAP_MS) {
        lastSlot = null;
        startedAt = now;
      }
      await this.recordDownloads(sync, lastSlot, slot, now);
      lastSlot = slot;
    } catch (err) {
      error = readError(err, 'this repository’s releases');
      this.deps.log.warn({ repo: `${sync.owner}/${sync.name}`, err: (err as Error).message }, 'download recording failed');
    }
    // Stars on their own: a refusal there doesn't stop the downloads (skipped when the budget ran out).
    let starsError: string | null = null;
    if (!error?.startsWith('GitHub’s hourly budget')) {
      try {
        await this.recordStars(sync, now);
      } catch (err) {
        starsError = readError(err, 'the star count');
        this.deps.log.warn({ repo: `${sync.owner}/${sync.name}`, err: (err as Error).message }, 'star count read failed');
      }
    }
    await db.query(
      'UPDATE download_sync SET last_slot_at = $2, started_at = $3, checked_at = $4, error = $5, stars_error = $6, lease_until_at = NULL WHERE repo_id = $1',
      [repoId, lastSlot === null ? null : new Date(lastSlot), new Date(startedAt), new Date(now), error, starsError],
    );
  }

  /**
   * Keeps each release file's total, and how much it grew since the last read in the slots in
   * between (normally the one slot just ended; a short gap spreads it evenly). The first read is
   * only a starting point. A file that appears later (a new release) counts all its downloads.
   */
  private async recordDownloads(sync: SyncRow, lastSlot: number | null, slot: number, now: number): Promise<void> {
    const { db, github } = this.deps;
    const files: { release: string; name: string; publishedAt: Date | null; prerelease: boolean; downloads: number }[] = [];
    let after: string | null = null;
    for (let page = 0; page < RELEASE_PAGES; page++) {
      const d: any = await github!.graphql(sync.installation_id, RELEASES_QUERY, { owner: sync.owner, name: sync.name, after }, { strict: true });
      if (!d?.repository) throw new GitHubApiError(404, 'Repository not found', null, false, null);
      const conn = d.repository.releases;
      for (const r of conn?.nodes ?? []) {
        if (r.isDraft) continue;
        const publishedAt = r.publishedAt ? new Date(r.publishedAt) : r.createdAt ? new Date(r.createdAt) : null;
        for (const a of r.releaseAssets?.nodes ?? []) files.push({ release: String(r.tagName), name: String(a.name), publishedAt, prerelease: Boolean(r.isPrerelease), downloads: Number(a.downloadCount ?? 0) });
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    const { rows: prev } = await db.query<{ id: number; release: string; name: string; total: number }>('SELECT id, release, name, total FROM download_assets WHERE repo_id = $1', [sync.repo_id]);
    const byKey = new Map(prev.map((p) => [`${p.release}\u0000${p.name}`, p]));
    // The slots the growth happened in: from the last read's slot up to the one just ended.
    const slots: number[] = [];
    if (lastSlot !== null) for (let s = lastSlot; s < slot; s += SLOT_MS) slots.push(s);
    for (const f of files) {
      const info = classifyAsset(f.name);
      const old = byKey.get(`${f.release}\u0000${f.name}`);
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO download_assets (repo_id, release, name, published_at, prerelease, platform, arch, format, kind, total, first_seen_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         ON CONFLICT (repo_id, release, name) DO UPDATE SET total = excluded.total, published_at = excluded.published_at, prerelease = excluded.prerelease,
           platform = excluded.platform, arch = excluded.arch, format = excluded.format, kind = excluded.kind, updated_at = excluded.updated_at
         RETURNING id`,
        [sync.repo_id, f.release, f.name, f.publishedAt, f.prerelease ? 1 : 0, info.platform, info.arch, info.format, info.kind, f.downloads, new Date(now)],
      );
      if (!slots.length || info.kind === 'meta') continue;
      // A file seen before grew by the difference (one uploaded again starts from zero); a new one counts all of it.
      const grew = old ? (f.downloads >= old.total ? f.downloads - old.total : f.downloads) : f.downloads;
      if (grew <= 0) continue;
      // A new release's downloads go to the slots since it was published (it can't have any before).
      const from = old || !f.publishedAt ? slots : slots.filter((s) => s + SLOT_MS > f.publishedAt!.getTime());
      const spread = from.length ? from : [slots.at(-1)!];
      const each = Math.floor(grew / spread.length);
      const rest = grew - each * spread.length;
      for (let i = 0; i < spread.length; i++) {
        const n = each + (i >= spread.length - rest ? 1 : 0);
        if (n > 0) {
          await db.query(
            `INSERT INTO download_counts (asset_id, slot_at, downloads) VALUES ($1, $2, $3)
             ON CONFLICT (asset_id, slot_at) DO UPDATE SET downloads = download_counts.downloads + excluded.downloads`,
            [rows[0]!.id, new Date(spread[i]!), n],
          );
        }
      }
    }
  }

  /**
   * The repository's star total as GitHub counts it, and how much it changed since the last read in
   * the slots in between (like the downloads; a star taken back counts -1). The first read, and the
   * first after a long gap, is only a starting point.
   */
  private async recordStars(sync: SyncRow, now: number): Promise<void> {
    const { db, github } = this.deps;
    const d: any = await github!.graphql(sync.installation_id, STARS_QUERY, { owner: sync.owner, name: sync.name }, { strict: true });
    if (!d?.repository) throw new GitHubApiError(404, 'Repository not found', null, false, null);
    const total = Number(d.repository.stargazerCount);
    if (!Number.isInteger(total) || total < 0) throw new Error('GitHub gave no star count');
    const slot = slotOf(now);
    const last = sync.stars_slot_at?.getTime() ?? null;
    if (last !== null && sync.stars_total !== null && slot - last <= MAX_GAP_MS && total !== Number(sync.stars_total)) {
      // The slots since the last read (a second read in the same slot adds to that slot).
      const slots: number[] = [];
      for (let s = last; s < slot; s += SLOT_MS) slots.push(s);
      if (!slots.length) slots.push(last);
      const change = total - Number(sync.stars_total);
      const each = Math.trunc(change / slots.length);
      const rest = change - each * slots.length;
      for (let i = 0; i < slots.length; i++) {
        const n = each + (i >= slots.length - Math.abs(rest) ? Math.sign(rest) : 0);
        if (n !== 0) {
          await db.query(
            `INSERT INTO repo_star_changes (repo_id, slot_at, change) VALUES ($1, $2, $3)
             ON CONFLICT (repo_id, slot_at) DO UPDATE SET change = repo_star_changes.change + excluded.change`,
            [sync.repo_id, new Date(slots[i]!), n],
          );
        }
      }
    }
    await db.query(
      'UPDATE download_sync SET stars_total = $2, stars_slot_at = $3, stars_started_at = COALESCE(stars_started_at, $4) WHERE repo_id = $1',
      [sync.repo_id, total, new Date(slot), new Date(now)],
    );
  }
}

/** What went wrong reading something from GitHub, for the page. */
function readError(err: unknown, what: string): string {
  if (!(err instanceof GitHubApiError)) return `GitHub couldn’t be reached (${(err as Error).message.slice(0, 120)}).`;
  if (err.isRateLimit) return 'GitHub’s hourly budget ran out: reading again when it resets.';
  if (err.status === 404 || err.status === 403) return `GitHub didn’t let the app read ${what}.`;
  return `GitHub returned ${err.status}.`;
}

/** 30-minute detail older than DETAIL_DAYS is added up per UTC day. */
export async function rollUp(q: Queryable, now = Date.now()): Promise<void> {
  const cutoff = Math.floor((now - DETAIL_DAYS * 86_400_000) / 86_400_000) * 86_400_000;
  await q.query(
    `INSERT INTO download_days (asset_id, day_at, downloads)
       SELECT asset_id, (slot_at / 86400000) * 86400000, sum(downloads) FROM download_counts WHERE slot_at < $1 GROUP BY 1, 2
     ON CONFLICT (asset_id, day_at) DO UPDATE SET downloads = download_days.downloads + excluded.downloads`,
    [new Date(cutoff)],
  );
  await q.query('DELETE FROM download_counts WHERE slot_at < $1', [new Date(cutoff)]);
}

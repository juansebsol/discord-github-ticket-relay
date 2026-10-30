/**
 * GitHub's side of the issues opened in Ticket management (the issue and its timeline), kept in the
 * database so a ticket shows at once. A copy older than a minute is shown while it's read again in
 * the background, and the next tickets in a list are read ahead.
 */
import type { Queryable } from '../db/database.js';
import { getGitHubConnection, listApps } from '../domain/store.js';
import type { AppRow, Deps } from '../domain/types.js';
import { GitHubApiError, type IssueDetail, type TimelineEvent } from '../github/client.js';
import { GITHUB_RESERVE } from '../triage/engine.js';
import type { IssueKey } from './queue.js';

export const FRESH_MS = 60_000;
const TIMEOUT_MS = 10_000;
export const KEEP_DAYS = 30;

export type Live = { issue: IssueDetail; events: TimelineEvent[]; more: boolean } | { error: 'missing' | 'error' };
export interface StoredLive {
  live: Live;
  fetchedAt: Date;
}

const DATES = new Set(['at', 'createdAt', 'updatedAt', 'closedAt']);
const revive = (k: string, v: unknown) => (DATES.has(k) && typeof v === 'string' ? new Date(v) : v);

/** The copy kept here, at any age (null: none, or it can't be read with this server's key). */
export async function storedLive(deps: Pick<Deps, 'db' | 'box'>, key: IssueKey): Promise<StoredLive | null> {
  const { rows } = await deps.db.query<{ missing: number; issue_enc: string | null; events_enc: string | null; more: number; fetched_at: Date }>(
    'SELECT missing, issue_enc, events_enc, more, fetched_at FROM issue_live WHERE repo_id = $1 AND number = $2',
    [key.repoId, key.number],
  );
  const r = rows[0];
  if (!r || (!r.missing && !r.issue_enc)) return null;
  if (r.missing) return { live: { error: 'missing' }, fetchedAt: r.fetched_at };
  try {
    const issue = JSON.parse(deps.box.decrypt(r.issue_enc!), revive) as IssueDetail;
    const events = r.events_enc ? (JSON.parse(deps.box.decrypt(r.events_enc), revive) as TimelineEvent[]) : [];
    return { live: { issue, events, more: Boolean(r.more) }, fetchedAt: r.fetched_at };
  } catch {
    return null;
  }
}

export function isFresh(s: StoredLive | null, now = Date.now()): boolean {
  return Boolean(s && now - s.fetchedAt.getTime() < FRESH_MS);
}

/** After a moderator changes an issue: read again when it's next opened, and reads already under way are dropped. */
export async function forgetLive(db: Queryable, key: IssueKey): Promise<void> {
  await db.query(
    `INSERT INTO issue_live (repo_id, number, fetched_at, forgot_at) VALUES ($1, $2, 0, now_ms())
     ON CONFLICT (repo_id, number) DO UPDATE SET missing = 0, issue_enc = NULL, events_enc = NULL, more = 0, fetched_at = 0, forgot_at = excluded.forgot_at`,
    [key.repoId, key.number],
  );
}

const reading = new Map<string, Promise<Live>>();

/** Reads the issue and its timeline from GitHub and keeps them. One read per issue at a time. */
export function refreshLive(deps: Deps, installationId: number, app: Pick<AppRow, 'repo_id' | 'repo_owner' | 'repo_name'>, number: number): Promise<Live> {
  const k = `${app.repo_id}-${number}`;
  let p = reading.get(k);
  if (!p) {
    p = readLive(deps, installationId, app, number).finally(() => reading.delete(k));
    reading.set(k, p);
  }
  return p;
}

async function readLive(deps: Deps, installationId: number, app: Pick<AppRow, 'repo_id' | 'repo_owner' | 'repo_name'>, number: number): Promise<Live> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let live: Live;
  try {
    const gh = deps.github;
    if (!gh) return { error: 'error' };
    const [issue, timeline] = await Promise.race([
      Promise.all([gh.getIssueDetail(installationId, app.repo_owner, app.repo_name, number), gh.listIssueTimeline(installationId, app.repo_owner, app.repo_name, number)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); }),
    ]);
    live = { issue, events: timeline.events, more: timeline.more };
  } catch (err) {
    live = { error: err instanceof GitHubApiError && (err.status === 404 || err.status === 410) ? 'missing' : 'error' };
  } finally {
    clearTimeout(timer);
  }
  if ('error' in live && live.error === 'error') return live;
  const ok = 'error' in live ? null : live;
  await deps.db.query(
    `INSERT INTO issue_live (repo_id, number, missing, issue_enc, events_enc, more, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, now_ms())
     ON CONFLICT (repo_id, number) DO UPDATE SET missing = excluded.missing, issue_enc = excluded.issue_enc, events_enc = excluded.events_enc, more = excluded.more, fetched_at = excluded.fetched_at, forgot_at = NULL
     WHERE issue_live.forgot_at IS NULL OR issue_live.forgot_at < $7`,
    [app.repo_id, number, ok ? 0 : 1, ok ? deps.box.encryptJson(ok.issue) : null, ok ? deps.box.encryptJson(ok.events) : null, ok?.more ? 1 : 0, started],
  );
  return live;
}

/** The workspace is low on GitHub requests: background reads stop, and agents get the copies kept here. */
export function lowOnRequests(deps: Deps, installationId: number): boolean {
  const rl = deps.github?.rateLimitFor(installationId);
  return Boolean(rl && rl.remaining < Math.max(GITHUB_RESERVE.min, Math.round(rl.limit * GITHUB_RESERVE.share)));
}

/**
 * In the background, never waited for: the open ticket when its copy is out of date, then the next
 * ones in the list, so moving through it is instant. Reading ahead stops where background work does
 * when the workspace is low on GitHub requests.
 */
export function warmLive(deps: Deps, workspaceId: string, o: { now: IssueKey | null; ahead: IssueKey[] }): void {
  if (!deps.github || (!o.now && !o.ahead.length)) return;
  const run = (async () => {
    const [conn, apps] = await Promise.all([getGitHubConnection(deps.db, workspaceId), listApps(deps.db, workspaceId)]);
    if (!conn) return;
    for (const key of [...(o.now ? [o.now] : []), ...o.ahead]) {
      const app = apps.find((a) => a.repo_id === key.repoId);
      if (!app || isFresh(await storedLive(deps, key))) continue;
      if (key !== o.now && lowOnRequests(deps, conn.installation_id)) return;
      await refreshLive(deps, conn.installation_id, app, key.number);
    }
  })()
    .catch((err: unknown) => deps.log.warn({ err: (err as Error).message }, 'reading ahead for Ticket management failed'))
    .finally(() => warming.delete(run));
  warming.add(run);
}

const warming = new Set<Promise<void>>();

/** Resolves once nothing is being read in the background (for tests). */
export async function liveIdle(): Promise<void> {
  while (warming.size || reading.size) await Promise.allSettled([...warming, ...reading.values()]);
}

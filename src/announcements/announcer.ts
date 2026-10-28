/**
 * Release announcements: checks each announced repository for new releases every few minutes
 * (GraphQL, on the budget filing doesn't use), has Claude write friendlier notes, and posts them in
 * Discord: right away in Automatic mode, or when someone posts them in Review first. Runs in the
 * triage worker's polling loop, like Repo status and Analytics. A release counts once per
 * workspace and repository; only releases published after GitHub releases was turned on are new.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/client.js';
import { resolveClaudeKey } from '../domain/claude-key.js';
import { listApps } from '../domain/store.js';
import { UserFacingError, type AppRow, type Deps } from '../domain/types.js';
import { GitHubApiError, type GitHubClient } from '../github/client.js';
import { classifyAiError, type TriageAi } from '../triage/ai.js';
import { getTriageSettings } from '../triage/settings.js';
import { announcementPayload, cleanClaudeNotes, EMPTY_NOTES, githubNotes, notesPrompt, type ReleaseView } from './message.js';
import {
  announcedRepos,
  appAnnounceSettings,
  getAnnouncement,
  getAnnouncementSettings,
  targetFor,
  type AnnouncementRow,
  type AnnouncementSettings,
  type ReleaseFile,
} from './settings.js';

/** Each repository is checked for new releases this often. */
export const CHECK_MS = 5 * 60_000;
const LEASE_MS = 3 * 60_000;
const CHECKS_PER_ROUND = 4;
const WRITES_PER_ROUND = 2;
const POSTS_PER_ROUND = 5;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_POST_ATTEMPTS = 5;

const RELEASES_QUERY = `
query AnnouncementReleases($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    releases(first: $first, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { tagName name url isDraft isPrerelease publishedAt description releaseAssets(first: 100) { nodes { name downloadUrl } } }
    }
  }
}`;

export interface GitHubRelease {
  tag: string;
  name: string | null;
  url: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: Date | null;
  notes: string;
  files: ReleaseFile[];
}

/** A repository's newest releases, newest first. */
export async function readReleases(github: GitHubClient, installationId: number, owner: string, name: string, first = 10): Promise<GitHubRelease[]> {
  const d: any = await github.graphql(installationId, RELEASES_QUERY, { owner, name, first }, { strict: true });
  if (!d?.repository) throw new GitHubApiError(404, 'Repository not found', null, false, null);
  return (d.repository.releases?.nodes ?? []).map((r: any) => ({
    tag: String(r.tagName),
    name: r.name ? String(r.name) : null,
    url: String(r.url),
    draft: Boolean(r.isDraft),
    prerelease: Boolean(r.isPrerelease),
    publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
    notes: String(r.description ?? '').slice(0, 20_000),
    files: (r.releaseAssets?.nodes ?? []).filter((a: any) => a?.name && a?.downloadUrl).map((a: any) => ({ name: String(a.name), url: String(a.downloadUrl) })),
  }));
}

/** Adds a release to announce (nothing when it's already there). Returns its id. */
export async function addAnnouncement(q: Queryable, workspaceId: string, app: AppRow, r: GitHubRelease, o: { manual: boolean; now?: number }): Promise<{ id: string; added: boolean }> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO announcements (id, workspace_id, app_id, app_name, repo_id, repo_owner, repo_name, tag, release_name, release_url, published_at, prerelease,
       github_notes, release_files, manual, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'writing', $16)
     ON CONFLICT (workspace_id, repo_id, tag) DO NOTHING RETURNING id`,
    [randomUUID().replace(/-/g, ''), workspaceId, app.id, app.name, app.repo_id, app.repo_owner, app.repo_name, r.tag, r.name, r.url, r.publishedAt,
      r.prerelease ? 1 : 0, r.notes, JSON.stringify(r.files), o.manual ? 1 : 0, new Date(o.now ?? Date.now())],
  );
  if (rows[0]) return { id: rows[0].id, added: true };
  const { rows: had } = await q.query<{ id: string }>('SELECT id FROM announcements WHERE workspace_id = $1 AND repo_id = $2 AND tag = $3', [workspaceId, app.repo_id, r.tag]);
  return { id: had[0]!.id, added: false };
}

/** A release as the message builder takes it (the notes GitHub wrote, until there are others). */
export function viewOf(row: AnnouncementRow): ReleaseView {
  return {
    appId: row.app_id, appName: row.app_name, tag: row.tag, releaseName: row.release_name, releaseUrl: row.release_url, publishedAt: row.published_at,
    notes: row.notes ?? (githubNotes(row.github_notes) || EMPTY_NOTES), files: row.release_files ?? [],
  };
}

/** Why Discord didn't take a post, and whether trying again could help. */
function postError(err: unknown): { message: string; retry: boolean } {
  if (err instanceof DiscordApiError) {
    if (err.code === DiscordErrorCode.MissingAccess || err.code === DiscordErrorCode.MissingPermissions) {
      return { message: 'The bot can’t post in that channel. It needs View Channel, Send Messages and Embed Links there.', retry: false };
    }
    if (err.code === DiscordErrorCode.UnknownChannel) return { message: 'The channel no longer exists. Choose another one in Settings.', retry: false };
    if (err.status === 429 || err.status >= 500) return { message: 'Discord was busy. Trying again shortly.', retry: true };
    return { message: `Discord didn’t accept the post: ${err.discordMessage.slice(0, 200)}`, retry: false };
  }
  return { message: 'Discord couldn’t be reached. Trying again shortly.', retry: true };
}

/**
 * Posts an announcement that's been claimed (status posting): into its app's channel, pinging its
 * role. A nonce makes Discord drop a second copy if the same post is sent again after a timeout.
 * `by`: who posted it (null: automatic, which tries again on its own after a busy Discord).
 */
export async function deliverAnnouncement(deps: Deps, row: AnnouncementRow, by: string | null, now = Date.now()): Promise<{ ok: true } | { ok: false; error: string }> {
  const { db } = deps;
  const settings = await getAnnouncementSettings(db, row.workspace_id);
  const app = row.app_id ? (await appAnnounceSettings(db, row.workspace_id)).get(row.app_id) : undefined;
  const target = targetFor(settings, app);
  const fail = async (message: string, retry: boolean) => {
    const attempts = row.attempts + 1;
    const again = retry && !by && attempts < MAX_POST_ATTEMPTS;
    await db.query(
      `UPDATE announcements SET status = $2, error = $3, attempts = $4, next_attempt_at = $5, lease_until_at = NULL, updated_at = now_ms() WHERE id = $1`,
      [row.id, again ? 'posting' : 'failed', message, attempts, again ? new Date(now + 60_000 * 2 ** (attempts - 1)) : null],
    );
    deps.log.warn({ announcement: row.id, release: `${row.repo_owner}/${row.repo_name}@${row.tag}`, err: message }, 'announcement post failed');
    return { ok: false as const, error: message };
  };
  if (!deps.discord) return fail('Discord isn’t configured on this deployment.', false);
  if (!target.channelId) return fail('No channel is chosen. Choose one in Settings.', false);
  const payload = announcementPayload(viewOf(row), settings, target.roleId);
  let messageId: string;
  try {
    messageId = (await deps.discord.createMessage(target.channelId, { ...payload, nonce: row.id.slice(0, 25), enforce_nonce: true })).id;
  } catch (err) {
    const e = postError(err);
    return fail(e.message, e.retry);
  }
  await db.query(
    `UPDATE announcements SET status = 'posted', channel_id = $2, message_id = $3, posted_at = $4, posted_by = $5, error = NULL, attempts = 0,
       next_attempt_at = NULL, lease_until_at = NULL, updated_at = now_ms() WHERE id = $1`,
    [row.id, target.channelId, messageId, new Date(now), by],
  );
  // In an announcement channel, also publish it to the servers following the channel.
  await deps.discord.crosspostMessage(target.channelId, messageId).catch(() => {});
  deps.log.info({ announcement: row.id, release: `${row.repo_owner}/${row.repo_name}@${row.tag}` }, 'release announced');
  return { ok: true };
}

/** Posts an announcement now (someone pressed Post). Only one press posts it. */
export async function postNow(deps: Deps, workspaceId: string, id: string, userId: string): Promise<void> {
  const { rows } = await deps.db.query<AnnouncementRow>(
    `UPDATE announcements SET status = 'posting', lease_until_at = $3, updated_at = now_ms() WHERE workspace_id = $1 AND id = $2 AND status IN ('waiting', 'failed') RETURNING *`,
    [workspaceId, id, new Date(Date.now() + LEASE_MS)],
  );
  if (!rows[0]) throw new UserFacingError('This announcement was already posted, or is being posted.');
  const res = await deliverAnnouncement(deps, rows[0], userId);
  if (!res.ok) throw new UserFacingError(res.error);
}

/** Changes a post in Discord to the notes and settings as they are now (no one is pinged again). */
export async function updatePost(deps: Deps, row: AnnouncementRow): Promise<void> {
  if (!deps.discord || !row.channel_id || !row.message_id) throw new UserFacingError('This announcement isn’t posted.');
  const settings = await getAnnouncementSettings(deps.db, row.workspace_id);
  const app = row.app_id ? (await appAnnounceSettings(deps.db, row.workspace_id)).get(row.app_id) : undefined;
  try {
    await deps.discord.editMessage(row.channel_id, row.message_id, announcementPayload(viewOf(row), settings, targetFor(settings, app).roleId));
  } catch (err) {
    if (err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMessage) {
      await unpost(deps.db, row.id);
      throw new UserFacingError('The post was deleted in Discord. Post it again.');
    }
    throw new UserFacingError(postError(err).message);
  }
}

/** Deletes the post in Discord; the announcement waits to be posted again. */
export async function deletePost(deps: Deps, row: AnnouncementRow): Promise<void> {
  if (deps.discord && row.channel_id && row.message_id) {
    try {
      await deps.discord.deleteMessage(row.channel_id, row.message_id);
    } catch (err) {
      if (!(err instanceof DiscordApiError && (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.UnknownChannel))) throw new UserFacingError(postError(err).message);
    }
  }
  await unpost(deps.db, row.id);
}

async function unpost(q: Queryable, id: string): Promise<void> {
  await q.query(`UPDATE announcements SET status = 'waiting', channel_id = NULL, message_id = NULL, posted_at = NULL, posted_by = NULL, updated_at = now_ms() WHERE id = $1`, [id]);
}

/** Someone announces a release by hand (an older one, or to try it out): it waits to be posted. */
export async function announceManually(deps: Deps, workspaceId: string, installationId: number, app: AppRow, tag: string): Promise<string> {
  if (!deps.github) throw new UserFacingError('GitHub isn’t configured on this deployment.');
  let releases: GitHubRelease[];
  try {
    releases = await readReleases(deps.github, installationId, app.repo_owner, app.repo_name, 20);
  } catch {
    throw new UserFacingError(`Couldn’t read ${app.repo_owner}/${app.repo_name}’s releases from GitHub. Try again in a moment.`);
  }
  const r = releases.find((x) => x.tag === tag && !x.draft);
  if (!r) throw new UserFacingError('That release isn’t on GitHub anymore.');
  const { id, added } = await addAnnouncement(deps.db, workspaceId, app, r, { manual: true });
  // Skipped before: bring it back.
  if (!added) await deps.db.query(`UPDATE announcements SET status = 'waiting', updated_at = now_ms() WHERE id = $1 AND status = 'skipped'`, [id]);
  return id;
}

export class Announcer {
  constructor(
    readonly deps: Deps,
    private readonly ai: TriageAi,
  ) {}

  async tick(now = Date.now()): Promise<void> {
    if (!this.deps.github) return;
    await this.checkReleases(now);
    await this.writeNotes(now);
    await this.postDue(now);
  }

  /** The announced repositories whose check is due, a few per round, oldest check first. */
  private async checkReleases(now: number): Promise<void> {
    const { db } = this.deps;
    const { rows: workspaces } = await db.query<{ workspace_id: string; installation_id: number }>(
      `SELECT s.workspace_id, g.installation_id FROM announcement_settings s
         JOIN github_connections g ON g.workspace_id = s.workspace_id AND g.status = 'active' WHERE s.enabled = 1`,
    );
    const due: { workspaceId: string; installationId: number; app: AppRow; last: number }[] = [];
    for (const w of workspaces) {
      const repos = announcedRepos(await listApps(db, w.workspace_id), await appAnnounceSettings(db, w.workspace_id));
      const { rows: checks } = await db.query<{ repo_id: number; checked_at: Date | null; lease_until_at: Date | null }>(
        'SELECT repo_id, checked_at, lease_until_at FROM announcement_checks WHERE workspace_id = $1',
        [w.workspace_id],
      );
      const byRepo = new Map(checks.map((c) => [c.repo_id, c]));
      for (const app of repos) {
        const c = byRepo.get(app.repo_id);
        if (c?.lease_until_at && c.lease_until_at.getTime() > now) continue;
        if (c?.checked_at && now - c.checked_at.getTime() < CHECK_MS) continue;
        due.push({ workspaceId: w.workspace_id, installationId: w.installation_id, app, last: c?.checked_at?.getTime() ?? 0 });
      }
    }
    due.sort((a, b) => a.last - b.last);
    for (const d of due.slice(0, CHECKS_PER_ROUND)) {
      await db.query('INSERT INTO announcement_checks (workspace_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [d.workspaceId, d.app.repo_id]);
      const { rows } = await db.query(
        'UPDATE announcement_checks SET lease_until_at = $3 WHERE workspace_id = $1 AND repo_id = $2 AND (lease_until_at IS NULL OR lease_until_at < $4) RETURNING repo_id',
        [d.workspaceId, d.app.repo_id, new Date(now + LEASE_MS), new Date(now)],
      );
      if (rows.length) await this.check(d.workspaceId, d.installationId, d.app, now);
    }
  }

  private async check(workspaceId: string, installationId: number, app: AppRow, now: number): Promise<void> {
    const { db } = this.deps;
    const settings = await getAnnouncementSettings(db, workspaceId);
    let error: string | null = null;
    try {
      const since = settings.enabledAt?.getTime() ?? now;
      for (const r of await readReleases(this.deps.github!, installationId, app.repo_owner, app.repo_name)) {
        if (r.draft || (r.prerelease && !settings.includePrereleases) || !r.publishedAt || r.publishedAt.getTime() < since) continue;
        const { added } = await addAnnouncement(db, workspaceId, app, r, { manual: false, now });
        if (added) this.deps.log.info({ workspace: workspaceId, release: `${app.repo_owner}/${app.repo_name}@${r.tag}` }, 'new release to announce');
      }
    } catch (err) {
      const e = err as Error;
      error = err instanceof GitHubApiError
        ? err.isRateLimit ? 'GitHub’s hourly budget ran out: checking again when it resets.'
          : err.status === 404 || err.status === 403 ? 'GitHub didn’t let the app read this repository’s releases.' : `GitHub returned ${err.status}.`
        : `GitHub couldn’t be reached (${e.message.slice(0, 120)}).`;
      this.deps.log.warn({ repo: `${app.repo_owner}/${app.repo_name}`, err: e.message }, 'release check failed');
    }
    await db.query('UPDATE announcement_checks SET checked_at = $3, error = $4, lease_until_at = NULL WHERE workspace_id = $1 AND repo_id = $2', [workspaceId, app.repo_id, new Date(now), error]);
  }

  /** Notes for new releases (and rewrites someone asked for), a couple per round. */
  private async writeNotes(now: number): Promise<void> {
    const { db } = this.deps;
    const { rows } = await db.query<AnnouncementRow>(
      `SELECT * FROM announcements WHERE status = 'writing' AND (next_attempt_at IS NULL OR next_attempt_at <= $1) AND (lease_until_at IS NULL OR lease_until_at < $1)
        ORDER BY created_at LIMIT $2`,
      [new Date(now), WRITES_PER_ROUND],
    );
    for (const row of rows) {
      const { rows: claimed } = await db.query(
        `UPDATE announcements SET lease_until_at = $2 WHERE id = $1 AND status = 'writing' AND (lease_until_at IS NULL OR lease_until_at < $3) RETURNING id`,
        [row.id, new Date(now + LEASE_MS), new Date(now)],
      );
      if (claimed.length) await this.write(row, now);
    }
  }

  /**
   * Claude's notes, or GitHub's when that's the choice, there's no key, or Claude can't (tried a
   * few times when it's busy). A new release is then posted in Automatic mode, or waits.
   */
  private async write(row: AnnouncementRow, now: number): Promise<void> {
    const { db } = this.deps;
    const settings = await getAnnouncementSettings(db, row.workspace_id);
    const fromGitHub = githubNotes(row.github_notes) || EMPTY_NOTES;
    let notes = fromGitHub;
    let by: 'claude' | 'github' = 'github';
    let notesError: string | null = null;
    if (settings.notesSource === 'claude') {
      const key = await resolveClaudeKey(this.deps, row.workspace_id);
      if (!key) notesError = 'There’s no Claude API key (Settings › Claude API), so GitHub’s notes are used.';
      else {
        try {
          const model = (await getTriageSettings(db, row.workspace_id)).config.model;
          const p = notesPrompt({ appName: row.app_name, tag: row.tag, releaseName: row.release_name, githubNotes: row.github_notes }, settings.notesInstructions);
          const res = await this.ai.writeText(key.key, model, p.system, p.user, { maxTokens: 8_000 });
          const text = cleanClaudeNotes(res.text);
          if (!text) throw new Error('Claude wrote nothing.');
          [notes, by] = [text, 'claude'];
        } catch (err) {
          const e = classifyAiError(err);
          if (e.action === 'retry' && row.attempts + 1 < MAX_WRITE_ATTEMPTS) {
            const wait = (e.retryAfterSeconds ?? 60 * 2 ** row.attempts) * 1000;
            await db.query('UPDATE announcements SET attempts = attempts + 1, next_attempt_at = $2, lease_until_at = NULL WHERE id = $1', [row.id, new Date(now + wait)]);
            return;
          }
          notesError = `Claude couldn’t write the notes (${e.message.replace(/\.$/, '')}), so GitHub’s are used.`;
          this.deps.log.warn({ announcement: row.id, err: e.message }, 'announcement notes failed');
        }
      }
    }
    const post = autoPosts(settings, row);
    await db.query(
      `UPDATE announcements SET notes = $2, notes_by = $3, notes_error = $4, status = $5, attempts = 0, next_attempt_at = $6, lease_until_at = NULL, updated_at = now_ms()
        WHERE id = $1 AND status = 'writing'`,
      [row.id, notes, by, notesError, post ? 'posting' : 'waiting', post ? new Date(now) : null],
    );
  }

  /** Automatic posts that are due (new, or trying again after a busy Discord). */
  private async postDue(now: number): Promise<void> {
    const { db } = this.deps;
    const { rows } = await db.query<AnnouncementRow>(
      `SELECT * FROM announcements WHERE status = 'posting' AND (next_attempt_at IS NULL OR next_attempt_at <= $1) AND (lease_until_at IS NULL OR lease_until_at < $1)
        ORDER BY created_at LIMIT $2`,
      [new Date(now), POSTS_PER_ROUND],
    );
    for (const row of rows) {
      const { rows: claimed } = await db.query<AnnouncementRow>(
        `UPDATE announcements SET lease_until_at = $2 WHERE id = $1 AND status = 'posting' AND (lease_until_at IS NULL OR lease_until_at < $3) RETURNING *`,
        [row.id, new Date(now + LEASE_MS), new Date(now)],
      );
      if (!claimed[0]) continue;
      // Turned off since: it waits instead.
      const settings = await getAnnouncementSettings(db, row.workspace_id);
      if (!settings.enabled) {
        await db.query(`UPDATE announcements SET status = 'waiting', lease_until_at = NULL WHERE id = $1`, [row.id]);
        continue;
      }
      await deliverAnnouncement(this.deps, claimed[0], null, now);
    }
  }
}

/** A new release is posted on its own only in Automatic mode, and only the first time (not one added by hand, or rewritten). */
function autoPosts(s: AnnouncementSettings, row: AnnouncementRow): boolean {
  return s.enabled && s.mode === 'auto' && !row.manual && row.notes === null;
}

/** Someone asked Claude to write the notes again (it then waits to be posted). */
export async function rewriteNotes(q: Queryable, workspaceId: string, id: string): Promise<void> {
  const row = await getAnnouncement(q, workspaceId, id);
  if (!row || !['waiting', 'failed', 'skipped'].includes(row.status)) throw new UserFacingError('Only an announcement that isn’t posted can be rewritten.');
  await q.query(`UPDATE announcements SET status = 'writing', attempts = 0, next_attempt_at = now_ms(), error = NULL, lease_until_at = NULL, updated_at = now_ms() WHERE id = $1`, [id]);
}

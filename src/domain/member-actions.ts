/**
 * Discord tickets › My tickets: what members can do on one of their own open tickets, from its page
 * in My tickets:
 * - Add details: posted on the issue as a comment, inside the admins' text.
 * - Add screenshots: added to the issue's Attachments section like the ones sent with the ticket,
 *   with the admins' comment so the team hears about them.
 * - Close it: "It works now" (closed as completed) or "I don't need it anymore" (not planned), with
 *   the admins' comment. It's in the Mod log as the reporter's, and moderators can undo it.
 * Each is off until an admin turns it on in Panel. Everything the app posts on GitHub is text an
 * admin wrote, with the member's own words only where an admin put {details}.
 */
import { z } from 'zod';
import type { Queryable } from '../db/database.js';
import { neutralizeGitHubMentions } from '../github/issue-content.js';
import type { CloseReason } from '../github/client.js';
import { memberCloseOne, modTarget, type CloseResult } from '../moderation/actions.js';
import { forgetLive } from '../moderation/live.js';
import { listTicketFiles, recordIncomingFiles, storePendingFiles, syncIssueFiles } from './files.js';
import { getGitHubConnection } from './store.js';
import { addEvent, normalizeForDuplicateCheck, type IncomingFile } from './submissions.js';
import { UserFacingError, type Deps, type SubmissionRow, type WorkspaceRow } from './types.js';

export const MEMBER_LIMITS = { details: 2000, comment: 1000 } as const;
/** Details and screenshots one member can add in an hour, across their tickets. */
export const UPDATES_PER_HOUR = 5;
/** Screenshots added at a time (the ticket's 10 MB total still applies). */
export const MAX_NEW_FILES = 5;

/** The comments the app posts on GitHub, until an admin writes their own. */
export const DEFAULT_MEMBER_TEXT = {
  details: '**Update from the reporter on Discord:**\n\n{details}',
  files: 'The reporter added {screenshots} from Discord. They’re in the Attachments section of the issue.',
  works: 'Closed by the reporter from Discord: it works for them now.',
  notNeeded: 'Closed by the reporter from Discord: they don’t need this anymore.',
};
export type MemberTextKey = keyof typeof DEFAULT_MEMBER_TEXT;
export const MEMBER_TEXT_KEYS = Object.keys(DEFAULT_MEMBER_TEXT) as MemberTextKey[];

/** How a member can close their ticket: the button, how GitHub closes it, the Mod log's reason. */
export const MEMBER_CLOSE: Record<'works' | 'notNeeded', { label: string; github: CloseReason; reason: string; name: string; story: string }> = {
  works: { label: 'It works now', github: 'completed', reason: 'member:works', name: 'It works now', story: 'it works now' },
  notNeeded: { label: 'I don’t need it anymore', github: 'not_planned', reason: 'member:notNeeded', name: 'Not needed anymore', story: 'you don’t need it anymore' },
};
export type MemberCloseKey = keyof typeof MEMBER_CLOSE;

/** The Mod log's name for a reason a member closed their ticket with. */
export function memberReasonName(reason: string | null): string | null {
  return Object.values(MEMBER_CLOSE).find((c) => c.reason === reason)?.name ?? null;
}

export interface MemberActions {
  details: boolean;
  files: boolean;
  close: boolean;
  /** The comments posted on GitHub: empty posts none (details always has one, with {details}). */
  text: Record<MemberTextKey, string>;
}

const Stored = z.object({
  details: z.boolean().catch(false),
  files: z.boolean().catch(false),
  close: z.boolean().catch(false),
  /** null or missing: the default. */
  text: z.record(z.string(), z.string().nullable()).catch({}),
}).partial();

/** The workspace's member actions, with the default comments for the ones never written. */
export function memberActions(ws: Pick<WorkspaceRow, 'member_actions'>): MemberActions {
  const parsed = Stored.safeParse(ws.member_actions ?? {});
  const s = parsed.success ? parsed.data : {};
  const text = Object.fromEntries(MEMBER_TEXT_KEYS.map((k) => {
    const v = s.text?.[k];
    return [k, typeof v === 'string' && (k !== 'details' || v.includes('{details}')) ? v : DEFAULT_MEMBER_TEXT[k]];
  })) as Record<MemberTextKey, string>;
  return { details: s.details ?? false, files: s.files ?? false, close: s.close ?? false, text };
}

/** Whether any action is on (My tickets shows its buttons). */
export function anyMemberAction(a: Pick<MemberActions, 'details' | 'files' | 'close'>): boolean {
  return a.details || a.files || a.close;
}

/**
 * What to store from the Panel form: a comment that's still the default is stored as null, so a
 * better default later reaches it. Details must keep {details}, where the member's words go.
 */
export function memberActionsToStore(o: { details: boolean; files: boolean; close: boolean; text: Partial<Record<MemberTextKey, string>> }, current: MemberActions) {
  const text: Partial<Record<MemberTextKey, string | null>> = {};
  for (const k of MEMBER_TEXT_KEYS) {
    const v = (o.text[k] ?? current.text[k]).replace(/\r\n/g, '\n').trim().slice(0, MEMBER_LIMITS.comment);
    if (k === 'details' && !v.includes('{details}')) {
      throw new UserFacingError('Keep {details} in the comment for Add details: that’s where the member’s words go.');
    }
    text[k] = v === DEFAULT_MEMBER_TEXT[k] ? null : v;
  }
  return { details: o.details, files: o.files, close: o.close, text };
}

/** A comment with its placeholders filled: {details} the member's words, {screenshots} "2 screenshots", {app} the app. */
export function fillMemberText(template: string, v: { details?: string; screenshots?: number; app?: string | null }): string {
  return template
    .replace(/\{app\}/g, () => v.app ?? 'the app')
    .replace(/\{screenshots\}/g, () => `${v.screenshots ?? 0} screenshot${v.screenshots === 1 ? '' : 's'}`)
    // Last, so the member's words are never read for placeholders.
    .replace(/\{details\}/g, () => neutralizeGitHubMentions((v.details ?? '').trim()))
    .trim();
}

// ---- Limits ---------------------------------------------------------------------------------------------

/** Minutes until this member can add details or screenshots again (0: now). */
export async function waitMinutes(db: Queryable, workspaceId: string, discordUserId: string, now = Date.now()): Promise<number> {
  // "_at" names come back as dates.
  const { rows } = await db.query<{ n: number; oldest_at: Date | null }>(
    `SELECT count(*) AS n, min(e.at) AS oldest_at FROM submission_events e JOIN submissions s ON s.id = e.submission_id
     WHERE s.workspace_id = $1 AND s.reporter_discord_id = $2 AND e.kind IN ('member_details', 'member_files') AND e.at > $3`,
    [workspaceId, discordUserId, new Date(now - 3_600_000)],
  );
  const r = rows[0];
  if (!r || Number(r.n) < UPDATES_PER_HOUR || !r.oldest_at) return 0;
  return Math.max(1, Math.ceil((r.oldest_at.getTime() + 3_600_000 - now) / 60_000));
}

/** The member's own ticket by its reference (a filed Discord ticket of theirs, or null). */
export async function ownSubmission(db: Queryable, workspaceId: string, discordUserId: string, ref: string): Promise<SubmissionRow | null> {
  const { rows } = await db.query<SubmissionRow>(
    `SELECT * FROM submissions WHERE workspace_id = $1 AND ref = $2 AND reporter_discord_id = $3 AND source = 'discord' AND status = 'created' AND issue_number IS NOT NULL`,
    [workspaceId, ref, discordUserId],
  );
  return rows[0] ?? null;
}

async function installation(deps: Deps, sub: SubmissionRow): Promise<number> {
  if (!deps.github) throw new UserFacingError('GitHub isn’t connected.');
  const conn = await getGitHubConnection(deps.db, sub.workspace_id);
  if (!conn || conn.status !== 'active') throw new UserFacingError('GitHub isn’t connected.');
  return conn.installation_id;
}

// ---- The actions ----------------------------------------------------------------------------------------

/** Posts the member's details on the issue, inside the admins' comment. */
export async function addDetails(deps: Deps, ws: Pick<WorkspaceRow, 'member_actions'>, sub: SubmissionRow, details: string): Promise<'added' | 'repeat'> {
  const text = details.replace(/\r\n/g, '\n').trim().slice(0, MEMBER_LIMITS.details);
  const hash = deps.box.mac(normalizeForDuplicateCheck(text));
  // The same words twice (a double press, or sent again after a slow reply): posted once.
  const { rows } = await deps.db.query<{ n: number }>(
    `SELECT count(*) AS n FROM submission_events WHERE submission_id = $1 AND kind = 'member_details' AND json_extract(detail, '$.hash') = $2`,
    [sub.id, hash],
  );
  if (Number(rows[0]?.n ?? 0) > 0) return 'repeat';
  const inst = await installation(deps, sub);
  const body = fillMemberText(memberActions(ws).text.details, { details: text, app: sub.app_name });
  const commentId = await deps.github!.createComment(inst, sub.repo_owner, sub.repo_name, sub.issue_number!, body);
  await deps.db.query('UPDATE issue_index SET updated_at = now_ms() WHERE repo_id = $1 AND number = $2', [sub.repo_id, sub.issue_number]);
  await forgetLive(deps.db, { repoId: sub.repo_id, number: sub.issue_number! });
  await addEvent(deps.db, sub.id, 'member_details', { hash, comment_id: commentId });
  return 'added';
}

/**
 * Saves the member's new screenshots and adds them to the issue's Attachments section, then posts
 * the admins' comment about them. Ones that can't be saved aren't kept: the member is told why.
 */
export async function addScreenshots(deps: Deps, ws: Pick<WorkspaceRow, 'member_actions'>, sub: SubmissionRow, files: IncomingFile[]): Promise<{ added: number; failed: { filename: string; error: string }[] }> {
  const inst = await installation(deps, sub);
  const before = new Set((await listTicketFiles(deps.db, sub.id)).map((f) => f.id));
  const { rows } = await deps.db.query<{ n: number }>(`SELECT coalesce(sum(size), 0) AS n FROM ticket_files WHERE submission_id = $1 AND source = 'member' AND status = 'stored'`, [sub.id]);
  await recordIncomingFiles(deps.db, deps.box, sub, files.slice(0, MAX_NEW_FILES), Number(rows[0]?.n ?? 0));
  await storePendingFiles(deps, sub, { event: false });
  const fresh = (await listTicketFiles(deps.db, sub.id)).filter((f) => !before.has(f.id));
  const failed = fresh.filter((f) => f.status === 'failed');
  if (failed.length) await deps.db.query('DELETE FROM ticket_files WHERE id IN (SELECT value FROM json_each($1))', [JSON.stringify(failed.map((f) => f.id))]);
  const added = fresh.filter((f) => f.status === 'stored').length;
  if (added) {
    await syncIssueFiles(deps, sub);
    const template = memberActions(ws).text.files;
    if (template) await deps.github!.createComment(inst, sub.repo_owner, sub.repo_name, sub.issue_number!, fillMemberText(template, { screenshots: added, app: sub.app_name }));
    await deps.db.query('UPDATE issue_index SET updated_at = now_ms() WHERE repo_id = $1 AND number = $2', [sub.repo_id, sub.issue_number]);
    await forgetLive(deps.db, { repoId: sub.repo_id, number: sub.issue_number! });
    await addEvent(deps.db, sub.id, 'member_files', { count: added, failed: failed.length });
  }
  return { added, failed: failed.map((f) => ({ filename: f.filename, error: f.error ?? 'It couldn’t be saved.' })) };
}

/** Closes the member's ticket on GitHub for their reason, with the admins' comment for it. */
export async function closeMine(deps: Deps, ws: Pick<WorkspaceRow, 'id' | 'member_actions'>, sub: SubmissionRow, why: MemberCloseKey, member: string): Promise<CloseResult> {
  await installation(deps, sub);
  const c = MEMBER_CLOSE[why];
  const t = await modTarget(deps, ws.id, { repoId: sub.repo_id, number: sub.issue_number! });
  const comment = fillMemberText(memberActions(ws).text[why], { app: sub.app_name });
  const r = await memberCloseOne(deps, { ...t, ticket: t.ticket ?? sub }, { reason: c.reason, github: c.github, comment, member });
  if (r.status === 'closed') {
    await addEvent(deps.db, sub.id, 'member_closed', { why });
    await forgetLive(deps.db, t);
  }
  return r;
}

/**
 * What moderators do from Ticket management, done on GitHub by the app: close (with an admin's
 * comment and label for the reason), reopen and undo, mark or unmark duplicates, post a saved
 * reply and change labels. Each is checked live on GitHub first and logged in mod_actions.
 * Closing several at once is a job the worker runs one issue at a time.
 */
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/database.js';
import { cleanUpSpam } from '../domain/files.js';
import { getIndexed, setDuplicateOf } from '../domain/issue-index.js';
import { getGitHubConnection, listApps } from '../domain/store.js';
import { addEvent, getSubmission } from '../domain/submissions.js';
import { labelColor } from '../domain/ticket-types.js';
import { UserFacingError, type AppRow, type Deps, type SubmissionRow } from '../domain/types.js';
import { GitHubApiError, type CloseReason, type IssueDetail } from '../github/client.js';
import { GITHUB_RESERVE } from '../triage/engine.js';
import { fillTemplate, getModerationSettings, LIMITS, REASON_DEFAULTS, type ModerationSettings, type ReasonKey } from './settings.js';
import type { IssueKey } from './queue.js';

/** Undo is offered this long after a close or a reply. */
export const UNDO_MS = 15 * 60_000;
/** Most issues one bulk close takes. */
export const MAX_JOB = 500;
const LEASE_SECONDS = 120;

export interface ModTarget {
  workspaceId: string;
  installationId: number;
  repoId: number;
  owner: string;
  repo: string;
  number: number;
  app: AppRow;
  ticket: SubmissionRow | null;
}

export interface ModActionRow {
  id: string;
  workspace_id: string;
  kind: 'close' | 'reopen' | 'duplicate' | 'not_duplicate' | 'reply' | 'labels' | 'pin';
  repo_id: number;
  number: number;
  submission_id: string | null;
  title: string;
  reason: string | null;
  duplicate_of: number | null;
  note: string | null;
  comment_id: number | null;
  detail: { labels?: string[]; added?: string[]; removed?: string[]; reply?: string; closedAs?: CloseReason; commented?: boolean };
  job_id: string | null;
  user_id: string | null;
  at: Date;
  undone_at: Date | null;
  undone_by: string | null;
}

/** The first filed ticket for an issue, if it came from Discord. */
export async function ticketFor(db: Queryable, workspaceId: string, repoId: number, number: number): Promise<SubmissionRow | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM submissions WHERE workspace_id = $1 AND repo_id = $2 AND issue_number = $3 AND status = 'created' ORDER BY created_at LIMIT 1`,
    [workspaceId, repoId, number],
  );
  return rows[0] ? getSubmission(db, workspaceId, rows[0].id) : null;
}

/** An issue in one of the workspace's repositories, ready to act on (throws when it isn't one). */
export async function modTarget(deps: Deps, workspaceId: string, key: IssueKey): Promise<ModTarget> {
  const [apps, conn] = await Promise.all([listApps(deps.db, workspaceId), getGitHubConnection(deps.db, workspaceId)]);
  const inRepo = apps.filter((a) => a.repo_id === key.repoId);
  if (!inRepo.length) throw new UserFacingError('That repository isn’t connected to this workspace.', 404);
  if (!deps.github || !conn) throw new UserFacingError('GitHub isn’t connected.');
  const ticket = await ticketFor(deps.db, workspaceId, key.repoId, key.number);
  const indexed = (await getIndexed(deps.db, key.repoId, [key.number])).get(key.number);
  const app = inRepo.find((a) => a.id === ticket?.app_id) ?? inRepo.find((a) => a.name === indexed?.app_name) ?? inRepo[0]!;
  return { workspaceId, installationId: conn.installation_id, repoId: key.repoId, owner: app.repo_owner, repo: app.repo_name, number: key.number, app, ticket };
}

type Skipped = { status: 'skipped'; note: string };

/** The issue as GitHub has it now, or why it can't be acted on. */
async function liveIssue(deps: Deps, t: ModTarget): Promise<IssueDetail | Skipped> {
  try {
    const live = await deps.github!.getIssueDetail(t.installationId, t.owner, t.repo, t.number);
    if (live.isPullRequest) return { status: 'skipped', note: 'It’s a pull request' };
    return live;
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 410)) {
      await deps.db.query('UPDATE issue_index SET gone = 1 WHERE repo_id = $1 AND number = $2', [t.repoId, t.number]);
      return { status: 'skipped', note: 'It’s no longer on GitHub' };
    }
    throw err;
  }
}

/** Keeps our copy of the issue in step with what the app just did on GitHub. */
async function saveState(db: Queryable, t: ModTarget, o: { state: 'open' | 'closed'; reason: string | null; labels?: string[] }): Promise<void> {
  const closedAt = o.state === 'closed' ? new Date() : null;
  await db.query(
    `UPDATE issue_index SET state = $3, state_reason = $4, closed_at = $5, labels = COALESCE($6, labels), updated_at = now_ms() WHERE repo_id = $1 AND number = $2`,
    [t.repoId, t.number, o.state, o.reason, closedAt, o.labels ? JSON.stringify(o.labels) : null],
  );
  if (t.ticket) {
    await db.query('UPDATE submissions SET issue_state = $2, issue_state_reason = $3, issue_closed_at = $4, issue_checked_at = now_ms() WHERE id = $1', [t.ticket.id, o.state, o.reason, closedAt]);
  }
}

async function record(db: Queryable, t: ModTarget, a: Partial<Omit<ModActionRow, 'id' | 'workspace_id' | 'repo_id' | 'number' | 'submission_id' | 'at'>> & { kind: ModActionRow['kind']; title: string }): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO mod_actions (id, workspace_id, kind, repo_id, number, submission_id, title, reason, duplicate_of, note, comment_id, detail, job_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, t.workspaceId, a.kind, t.repoId, t.number, t.ticket?.id ?? null, a.title.slice(0, 300), a.reason ?? null, a.duplicate_of ?? null, a.note ?? null, a.comment_id ?? null, a.detail ?? {}, a.job_id ?? null, a.user_id ?? null],
  );
  return id;
}

/** The original a duplicate points to: an issue in the same repository, not itself and not a pull request. */
export async function checkOriginal(deps: Deps, t: ModTarget, original: unknown): Promise<IssueDetail> {
  const n = Number(original);
  if (!Number.isInteger(n) || n < 1) throw new UserFacingError('Enter the number of the original issue.');
  if (n === t.number) throw new UserFacingError('An issue can’t be a duplicate of itself.');
  try {
    const live = await deps.github!.getIssueDetail(t.installationId, t.owner, t.repo, n);
    if (live.isPullRequest) throw new UserFacingError(`#${n} is a pull request. Pick the original issue.`);
    return live;
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 410)) throw new UserFacingError(`There’s no issue #${n} in ${t.owner}/${t.repo}.`);
    throw err;
  }
}

/** Adds labels on the issue, creating any the repository doesn't have yet. */
async function addLabels(deps: Deps, t: ModTarget, labels: string[]): Promise<void> {
  if (!labels.length) return;
  const gh = deps.github!;
  const existing = new Set((await gh.listLabels(t.installationId, t.owner, t.repo)).map((l) => l.toLowerCase()));
  for (const name of labels) if (!existing.has(name.toLowerCase())) await gh.createLabel(t.installationId, t.owner, t.repo, name, labelColor(name));
  await gh.addLabels(t.installationId, t.owner, t.repo, t.number, labels);
}

/** Triage suggestions still waiting on an issue someone just closed: they no longer apply. */
async function clearSuggestions(db: Queryable, t: ModTarget): Promise<void> {
  const set = `suggestions = '[]', dismissed_count = dismissed_count + suggestion_count, suggestion_count = 0, updated_at = now_ms()`;
  if (t.ticket) await db.query(`UPDATE triage_results SET ${set} WHERE submission_id = $1 AND suggestion_count > 0`, [t.ticket.id]);
  else await db.query(`UPDATE issue_triage SET ${set} WHERE workspace_id = $1 AND repo_id = $2 AND number = $3 AND suggestion_count > 0`, [t.workspaceId, t.repoId, t.number]);
}

export interface CloseInput {
  reason: ReasonKey;
  duplicateOf: number | null;
  /** Post the reason's comment (when it has one). */
  postComment: boolean;
  note: string;
  userId: string | null;
  jobId?: string | null;
}

export type CloseResult = { status: 'closed'; closedAs: CloseReason; commented: boolean; actionId: string } | Skipped;

/** Closes one issue for a reason: its label, its comment, then closing it on GitHub. */
export async function closeOne(deps: Deps, t: ModTarget, settings: ModerationSettings, input: CloseInput): Promise<CloseResult> {
  const reason = settings.reasons.find((r) => r.key === input.reason);
  if (!reason?.on) throw new UserFacingError('That reason is turned off. Pick another one.');
  const live = await liveIssue(deps, t);
  if ('status' in live) return live;
  if (live.state === 'closed') {
    await saveState(deps.db, t, { state: 'closed', reason: live.stateReason, labels: live.labels });
    return { status: 'skipped', note: 'It was already closed' };
  }
  const duplicateOf = reason.key === 'duplicate' ? (await checkOriginal(deps, t, input.duplicateOf)).number : null;
  const gh = deps.github!;
  const labels = reason.label && !live.labels.some((l) => l.toLowerCase() === reason.label.toLowerCase()) ? [reason.label] : [];
  await addLabels(deps, t, labels);
  const text = input.postComment ? fillTemplate(reason.comment, { duplicate: duplicateOf, app: t.app.name }) : '';
  const commentId = text ? await gh.createComment(t.installationId, t.owner, t.repo, t.number, text) : null;
  const closedAs = await gh.closeIssue(t.installationId, t.owner, t.repo, t.number, reason.github);

  await saveState(deps.db, t, { state: 'closed', reason: closedAs, labels: [...live.labels, ...labels] });
  if (duplicateOf) await setDuplicateOf(deps.db, t.repoId, t.number, duplicateOf);
  await clearSuggestions(deps.db, t);
  const note = input.note.trim().slice(0, LIMITS.note) || null;
  const actionId = await record(deps.db, t, {
    kind: 'close', title: live.title, reason: reason.key, duplicate_of: duplicateOf, note, comment_id: commentId,
    detail: { labels, closedAs, commented: Boolean(text) }, job_id: input.jobId ?? null, user_id: input.userId,
  });
  if (t.ticket) {
    await addEvent(deps.db, t.ticket.id, 'mod_closed', { by: input.userId, reason: reason.name, duplicate_of: duplicateOf, note });
    if (reason.key === 'spam') await cleanUpSpam(deps, t.ticket).catch((err) => deps.log.warn({ submission: t.ticket!.ref, err: (err as Error).message }, 'could not delete spam files'));
  }
  return { status: 'closed', closedAs, commented: Boolean(text), actionId };
}

export async function getAction(db: Queryable, workspaceId: string, id: string): Promise<ModActionRow | null> {
  const { rows } = await db.query<ModActionRow>('SELECT * FROM mod_actions WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
  return rows[0] ?? null;
}

/** Whether an action can still be undone: a close or a reply, not undone, in the last 15 minutes. */
export function canUndo(a: Pick<ModActionRow, 'kind' | 'undone_at' | 'at'>, now = Date.now()): boolean {
  return (a.kind === 'close' || a.kind === 'reply') && !a.undone_at && now - a.at.getTime() < UNDO_MS;
}

/** Reopens a closed issue. */
export async function reopenOne(deps: Deps, t: ModTarget, userId: string): Promise<'reopened' | 'already'> {
  const live = await liveIssue(deps, t);
  if ('status' in live) throw new UserFacingError(`${live.note}.`);
  if (live.state === 'open') {
    await saveState(deps.db, t, { state: 'open', reason: live.stateReason, labels: live.labels });
    return 'already';
  }
  await deps.github!.reopenIssue(t.installationId, t.owner, t.repo, t.number);
  await saveState(deps.db, t, { state: 'open', reason: 'reopened' });
  await record(deps.db, t, { kind: 'reopen', title: live.title, user_id: userId });
  if (t.ticket) await addEvent(deps.db, t.ticket.id, 'mod_reopened', { by: userId });
  return 'reopened';
}

/**
 * Undoes a close (reopens it, deletes the comment the app posted and takes off the label it
 * added) or a reply (deletes it), within 15 minutes.
 */
export async function undoAction(deps: Deps, workspaceId: string, actionId: string, userId: string): Promise<{ action: ModActionRow; t: ModTarget }> {
  const a = await getAction(deps.db, workspaceId, actionId);
  if (!a) throw new UserFacingError('That action wasn’t found.', 404);
  if (!canUndo(a)) throw new UserFacingError(a.undone_at ? 'That was already undone.' : 'It’s too late to undo that. Reopen the issue instead.', 409);
  const t = await modTarget(deps, workspaceId, { repoId: a.repo_id, number: a.number });
  const gh = deps.github!;
  if (a.kind === 'close') {
    const live = await liveIssue(deps, t);
    if ('status' in live) throw new UserFacingError(`${live.note}.`);
    if (live.state === 'closed') await gh.reopenIssue(t.installationId, t.owner, t.repo, t.number);
    if (a.comment_id) await gh.deleteComment(t.installationId, t.owner, t.repo, a.comment_id);
    for (const l of a.detail.labels ?? []) await gh.removeLabel(t.installationId, t.owner, t.repo, t.number, l);
    const taken = new Set((a.detail.labels ?? []).map((l) => l.toLowerCase()));
    await saveState(deps.db, t, { state: 'open', reason: 'reopened', labels: live.labels.filter((l) => !taken.has(l.toLowerCase())) });
    if (a.duplicate_of) await deps.db.query('UPDATE issue_index SET duplicate_of = NULL WHERE repo_id = $1 AND number = $2 AND duplicate_of = $3', [t.repoId, t.number, a.duplicate_of]);
    if (t.ticket) await addEvent(deps.db, t.ticket.id, 'mod_reopened', { by: userId, undo: true });
  } else if (a.comment_id) {
    await gh.deleteComment(t.installationId, t.owner, t.repo, a.comment_id);
  }
  await deps.db.query('UPDATE mod_actions SET undone_at = now_ms(), undone_by = $2 WHERE id = $1', [a.id, userId]);
  return { action: a, t };
}

/** Marks an issue as a duplicate in Ticket Relay (Repeat bugs and triage learn it); nothing changes on GitHub. */
export async function markDuplicate(deps: Deps, t: ModTarget, original: unknown, userId: string): Promise<number> {
  const o = await checkOriginal(deps, t, original);
  const indexed = (await getIndexed(deps.db, t.repoId, [t.number])).get(t.number);
  await setDuplicateOf(deps.db, t.repoId, t.number, o.number);
  await deps.db.query(`UPDATE mod_actions SET undone_at = now_ms(), undone_by = $4 WHERE workspace_id = $1 AND repo_id = $2 AND number = $3 AND kind IN ('not_duplicate', 'duplicate') AND undone_at IS NULL`, [t.workspaceId, t.repoId, t.number, userId]);
  await record(deps.db, t, { kind: 'duplicate', title: indexed?.title ?? '', duplicate_of: o.number, user_id: userId });
  return o.number;
}

/**
 * Not a duplicate: triage's suggestion is dismissed, the link to the original is dropped, and a
 * duplicate label someone or triage added is taken off. The issue stays open.
 */
export async function notDuplicate(deps: Deps, t: ModTarget, settings: ModerationSettings, o: { dismiss: () => Promise<void>; triageLabel: string | null; userId: string }): Promise<{ removed: string[] }> {
  const live = await liveIssue(deps, t);
  if ('status' in live) throw new UserFacingError(`${live.note}.`);
  const dupLabels = new Set([settings.reasons.find((r) => r.key === 'duplicate')?.label || REASON_DEFAULTS.duplicate.label, o.triageLabel ?? ''].filter(Boolean).map((l) => l.toLowerCase()));
  const removed = live.labels.filter((l) => dupLabels.has(l.toLowerCase()));
  for (const l of removed) await deps.github!.removeLabel(t.installationId, t.owner, t.repo, t.number, l);
  await o.dismiss();
  await deps.db.query('UPDATE issue_index SET duplicate_of = NULL, labels = $3 WHERE repo_id = $1 AND number = $2', [t.repoId, t.number, JSON.stringify(live.labels.filter((l) => !removed.includes(l)))]);
  await deps.db.query(`UPDATE mod_actions SET undone_at = now_ms(), undone_by = $4 WHERE workspace_id = $1 AND repo_id = $2 AND number = $3 AND kind IN ('not_duplicate', 'duplicate') AND undone_at IS NULL`, [t.workspaceId, t.repoId, t.number, o.userId]);
  await record(deps.db, t, { kind: 'not_duplicate', title: live.title, detail: { removed }, user_id: o.userId });
  return { removed };
}

/** Posts one of the admins' saved replies as a comment. */
export async function postReply(deps: Deps, t: ModTarget, settings: ModerationSettings, replyId: unknown, userId: string): Promise<string> {
  const reply = settings.replies.find((r) => r.id === replyId);
  if (!reply) throw new UserFacingError('Pick one of the saved replies.');
  const live = await liveIssue(deps, t);
  if ('status' in live) throw new UserFacingError(`${live.note}.`);
  const commentId = await deps.github!.createComment(t.installationId, t.owner, t.repo, t.number, fillTemplate(reply.text, { app: t.app.name }));
  await deps.db.query('UPDATE issue_index SET updated_at = now_ms() WHERE repo_id = $1 AND number = $2', [t.repoId, t.number]);
  await record(deps.db, t, { kind: 'reply', title: live.title, comment_id: commentId, detail: { reply: reply.name }, user_id: userId });
  return reply.name;
}

/** Adds labels the repository already has, and takes labels off. */
export async function changeLabels(deps: Deps, t: ModTarget, o: { add: string[]; remove: string[]; userId: string }): Promise<{ added: string[]; removed: string[] }> {
  const live = await liveIssue(deps, t);
  if ('status' in live) throw new UserFacingError(`${live.note}.`);
  const gh = deps.github!;
  const on = new Map(live.labels.map((l) => [l.toLowerCase(), l]));
  const repoLabels = new Map((o.add.length ? await gh.listLabels(t.installationId, t.owner, t.repo) : []).map((l) => [l.toLowerCase(), l]));
  const added: string[] = [];
  for (const raw of o.add.map((l) => l.trim()).filter(Boolean)) {
    const name = repoLabels.get(raw.toLowerCase());
    if (!name) throw new UserFacingError(`There’s no label “${raw}” in ${t.owner}/${t.repo}. Labels are made on GitHub.`);
    if (!on.has(name.toLowerCase()) && !added.includes(name)) added.push(name);
  }
  const removed = o.remove.map((l) => on.get(l.toLowerCase())).filter((l): l is string => Boolean(l) && !added.includes(l!));
  if (!added.length && !removed.length) throw new UserFacingError('Nothing to change: pick a label to add or take off.');
  if (added.length) await gh.addLabels(t.installationId, t.owner, t.repo, t.number, added);
  for (const l of removed) await gh.removeLabel(t.installationId, t.owner, t.repo, t.number, l);
  const labels = [...live.labels.filter((l) => !removed.includes(l)), ...added];
  await deps.db.query('UPDATE issue_index SET labels = $3, updated_at = now_ms() WHERE repo_id = $1 AND number = $2', [t.repoId, t.number, JSON.stringify(labels)]);
  await record(deps.db, t, { kind: 'labels', title: live.title, detail: { added, removed }, user_id: o.userId });
  return { added, removed };
}

export async function recordPin(db: Queryable, t: ModTarget, title: string, userId: string): Promise<void> {
  await record(db, t, { kind: 'pin', title, user_id: userId });
}

// ---- Closing several at once ----------------------------------------------------------------------

export interface JobRow {
  id: string;
  workspace_id: string;
  reason: ReasonKey;
  duplicate_of: number | null;
  post_comment: number;
  note: string | null;
  description: string;
  status: 'running' | 'done' | 'stopped';
  waiting_until_at: Date | null;
  created_by: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface JobProgress extends JobRow {
  total: number;
  pending: number;
  done: number;
  skipped: number;
  failed: number;
}

export async function startCloseJob(db: Db, workspaceId: string, userId: string, keys: IssueKey[], input: Omit<CloseInput, 'userId' | 'jobId'>, description: string): Promise<{ id: string; count: number }> {
  const unique = [...new Map(keys.map((k) => [`${k.repoId}-${k.number}`, k])).values()].slice(0, MAX_JOB);
  if (!unique.length) throw new UserFacingError('Pick the tickets to close.');
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO mod_jobs (id, workspace_id, reason, duplicate_of, post_comment, note, description, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, workspaceId, input.reason, input.duplicateOf, input.postComment, input.note.trim().slice(0, LIMITS.note) || null, description, userId]);
    for (const [i, k] of unique.entries()) await tx.query('INSERT INTO mod_job_items (job_id, repo_id, number, position) VALUES ($1, $2, $3, $4)', [id, k.repoId, k.number, i]);
  });
  return { id, count: unique.length };
}

/** Bulk closes running, and ones that finished in the last few minutes. */
export async function activeJobs(db: Queryable, workspaceId: string): Promise<JobProgress[]> {
  const { rows } = await db.query<JobProgress>(
    `SELECT j.*, count(i.number) AS total, sum(i.status = 'pending') AS pending, sum(i.status = 'done') AS done, sum(i.status = 'skipped') AS skipped, sum(i.status = 'failed') AS failed
     FROM mod_jobs j JOIN mod_job_items i ON i.job_id = j.id
     WHERE j.workspace_id = $1 AND (j.status = 'running' OR j.finished_at > $2)
     GROUP BY j.id ORDER BY j.created_at DESC LIMIT 5`,
    [workspaceId, new Date(Date.now() - 10 * 60_000)],
  );
  return rows.map((r) => ({ ...r, total: Number(r.total ?? 0), pending: Number(r.pending ?? 0), done: Number(r.done ?? 0), skipped: Number(r.skipped ?? 0), failed: Number(r.failed ?? 0) }));
}

/** Stops a bulk close: what's closed stays closed. */
export async function stopJob(db: Queryable, workspaceId: string, jobId: string): Promise<number> {
  const res = await db.query(`UPDATE mod_jobs SET status = 'stopped', finished_at = now_ms() WHERE workspace_id = $1 AND id = $2 AND status = 'running'`, [workspaceId, jobId]);
  if (!res.rowCount) throw new UserFacingError('That already finished.', 409);
  const items = await db.query(`UPDATE mod_job_items SET status = 'skipped', note = 'Stopped before this one', lease_until_at = NULL WHERE job_id = $1 AND status = 'pending'`, [jobId]);
  return items.rowCount;
}

async function claimItem(db: Queryable): Promise<{ job_id: string; repo_id: number; number: number } | null> {
  const { rows } = await db.query<{ job_id: string; repo_id: number; number: number }>(
    `UPDATE mod_job_items SET lease_until_at = now_ms() + ($1 * 1000)
     WHERE rowid = (
       SELECT i.rowid FROM mod_job_items i JOIN mod_jobs j ON j.id = i.job_id
       WHERE i.status = 'pending' AND j.status = 'running' AND (i.lease_until_at IS NULL OR i.lease_until_at < now_ms())
         AND (j.waiting_until_at IS NULL OR j.waiting_until_at <= now_ms())
       ORDER BY j.created_at, i.position LIMIT 1
     )
     RETURNING job_id, repo_id, number`,
    [LEASE_SECONDS],
  );
  return rows[0] ?? null;
}

async function processItem(deps: Deps, item: { job_id: string; repo_id: number; number: number }): Promise<void> {
  const { db } = deps;
  const { rows } = await db.query<JobRow>('SELECT * FROM mod_jobs WHERE id = $1', [item.job_id]);
  const job = rows[0];
  if (!job) return;
  const finish = (status: 'done' | 'skipped' | 'failed', note: string | null) =>
    db.query('UPDATE mod_job_items SET status = $4, note = $5, lease_until_at = NULL, done_at = now_ms() WHERE job_id = $1 AND repo_id = $2 AND number = $3', [job.id, item.repo_id, item.number, status, note]);
  const wait = async (until: Date) => {
    await db.query('UPDATE mod_jobs SET waiting_until_at = $2 WHERE id = $1', [job.id, until]);
    await db.query('UPDATE mod_job_items SET lease_until_at = NULL WHERE job_id = $1 AND repo_id = $2 AND number = $3', [job.id, item.repo_id, item.number]);
  };
  try {
    const t = await modTarget(deps, job.workspace_id, { repoId: item.repo_id, number: item.number });
    // Filing new tickets comes first: wait when little of GitHub's hourly budget is left.
    const rl = deps.github?.rateLimitFor(t.installationId);
    if (rl && rl.remaining < Math.max(GITHUB_RESERVE.min, Math.round(rl.limit * GITHUB_RESERVE.share))) return await wait(new Date(rl.resetAt.getTime() + 5_000));
    if (job.waiting_until_at) await db.query('UPDATE mod_jobs SET waiting_until_at = NULL WHERE id = $1', [job.id]);
    const settings = await getModerationSettings(db, job.workspace_id);
    if (!settings.enabled) return void (await finish('skipped', 'Moderation was turned off'));
    const r = await closeOne(deps, t, settings, { reason: job.reason, duplicateOf: job.duplicate_of, postComment: Boolean(job.post_comment), note: job.note ?? '', userId: job.created_by, jobId: job.id });
    await finish(r.status === 'closed' ? 'done' : 'skipped', r.status === 'closed' ? null : r.note);
  } catch (err) {
    if (err instanceof GitHubApiError && err.isRateLimit) return await wait(new Date(Date.now() + (err.retryAfterSeconds ?? 60) * 1000));
    const note = err instanceof UserFacingError ? err.message : err instanceof GitHubApiError ? `GitHub didn’t accept it: ${err.status} ${err.githubMessage}` : 'Unexpected error';
    if (!(err instanceof UserFacingError) && !(err instanceof GitHubApiError)) deps.log.error({ err: (err as Error).message, job: job.id }, 'bulk close failed unexpectedly');
    await finish('failed', note.slice(0, 300));
  } finally {
    await db.query(
      `UPDATE mod_jobs SET status = 'done', finished_at = now_ms(), waiting_until_at = NULL WHERE id = $1 AND status = 'running'
         AND NOT EXISTS (SELECT 1 FROM mod_job_items WHERE job_id = $1 AND status = 'pending')`,
      [job.id],
    );
  }
}

/** Closes waiting items of bulk closes, up to `max` per call (the worker calls it every loop). */
export async function drainModerationJobs(deps: Deps, max = 20): Promise<number> {
  let n = 0;
  while (n < max) {
    const item = await claimItem(deps.db);
    if (!item) break;
    await processItem(deps, item);
    n++;
  }
  return n;
}

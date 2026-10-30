/**
 * Claims: "I'm on it", so two people (or their agents) don't fix the same bug. One person per
 * ticket, a few tickets per person, kept here only: nothing is written to GitHub. A claim ends
 * when it's released, when the issue closes, or after a few days without the claimer reading it,
 * unless a pull request for it is open.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { UserFacingError } from '../domain/types.js';
import type { IssueKey } from '../moderation/queue.js';

export const CLAIM_DAYS = 3;
export const MAX_CLAIMS = 5;
const NOTE_MAX = 200;

export interface Claim {
  id: string;
  repo_id: number;
  number: number;
  user_id: string | null;
  user_name: string | null;
  note: string | null;
  claimed_at: Date;
  active_at: Date;
  title: string | null;
  /** An open pull request that fixes or names it (the claim doesn't lapse meanwhile). */
  pr: number | null;
}

/** An open pull request that fixes or names the claimed issue (SQL, on ticket_claims c). */
const OPEN_PR = `(SELECT max(p.number) FROM pull_index p WHERE p.repo_id = c.repo_id AND p.state = 'open' AND p.noise IS NULL
  AND (EXISTS (SELECT 1 FROM json_each(p.closes) x WHERE x.value = c.number) OR EXISTS (SELECT 1 FROM json_each(p.mentions) x WHERE x.value = c.number)))`;

/** Ends claims whose issue closed, and those quiet for CLAIM_DAYS without an open pull request. */
export async function settleClaims(q: Queryable, workspaceId: string, now = Date.now()): Promise<void> {
  await q.query(
    `UPDATE ticket_claims AS c SET ended_at = $2, end_reason = 'closed' WHERE c.workspace_id = $1 AND c.ended_at IS NULL
       AND EXISTS (SELECT 1 FROM issue_index i WHERE i.repo_id = c.repo_id AND i.number = c.number AND (i.state = 'closed' OR i.gone = 1))`,
    [workspaceId, now],
  );
  await q.query(
    `UPDATE ticket_claims AS c SET ended_at = $2, end_reason = 'expired' WHERE c.workspace_id = $1 AND c.ended_at IS NULL AND c.active_at < $3 AND ${OPEN_PR} IS NULL`,
    [workspaceId, now, now - CLAIM_DAYS * 86_400_000],
  );
}

/** Claims that are on: everyone's, one person's, or for some issues. */
export async function activeClaims(q: Queryable, workspaceId: string, o: { userId?: string; keys?: IssueKey[] } = {}): Promise<Claim[]> {
  await settleClaims(q, workspaceId);
  const params: unknown[] = [workspaceId];
  const where = ['c.workspace_id = $1', 'c.ended_at IS NULL'];
  if (o.userId) {
    params.push(o.userId);
    where.push(`c.user_id = $${params.length}`);
  }
  if (o.keys) {
    if (!o.keys.length) return [];
    params.push(JSON.stringify(o.keys.map((k) => `${k.repoId}-${k.number}`)));
    where.push(`(c.repo_id || '-' || c.number) IN (SELECT value FROM json_each($${params.length}))`);
  }
  const { rows } = await q.query<Claim>(
    `SELECT c.id, c.repo_id, c.number, c.user_id, COALESCE(u.display_name, u.username) AS user_name, c.note, c.claimed_at, c.active_at, i.title, ${OPEN_PR} AS pr
     FROM ticket_claims c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN issue_index i ON i.repo_id = c.repo_id AND i.number = c.number
     WHERE ${where.join(' AND ')} ORDER BY c.claimed_at DESC`,
    params,
  );
  return rows;
}

export async function claimOf(q: Queryable, workspaceId: string, key: IssueKey): Promise<Claim | null> {
  return (await activeClaims(q, workspaceId, { keys: [key] }))[0] ?? null;
}

/** Claims an issue for this person (claiming one's own again keeps it going). */
export async function claimTicket(q: Queryable, workspaceId: string, key: IssueKey, userId: string, note: string | null): Promise<{ claim: Claim; renewed: boolean }> {
  const current = await claimOf(q, workspaceId, key);
  if (current && current.user_id !== userId) throw new UserFacingError(`${current.user_name ?? 'Someone'} claimed it ${new Date(current.claimed_at).toISOString().slice(0, 10)}. Pick another ticket, or ask them.`, 409);
  const text = note?.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) || null;
  if (current) {
    await q.query('UPDATE ticket_claims SET active_at = now_ms(), note = COALESCE($2, note) WHERE id = $1', [current.id, text]);
    return { claim: (await claimOf(q, workspaceId, key))!, renewed: true };
  }
  if ((await activeClaims(q, workspaceId, { userId })).length >= MAX_CLAIMS) throw new UserFacingError(`You have ${MAX_CLAIMS} tickets claimed already. Release one first (release_ticket).`, 409);
  await q.query('INSERT INTO ticket_claims (id, workspace_id, repo_id, number, user_id, note) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), workspaceId, key.repoId, key.number, userId, text]);
  return { claim: (await claimOf(q, workspaceId, key))!, renewed: false };
}

/** Lets a claim go: one's own, or anyone's for admins (`admin`). */
export async function releaseClaim(q: Queryable, workspaceId: string, key: IssueKey, userId: string, o: { admin?: boolean } = {}): Promise<Claim> {
  const current = await claimOf(q, workspaceId, key);
  if (!current) throw new UserFacingError('Nobody has it claimed.', 404);
  if (current.user_id !== userId && !o.admin) throw new UserFacingError(`${current.user_name ?? 'Someone else'} has it claimed, not you.`, 403);
  await q.query('UPDATE ticket_claims SET ended_at = now_ms(), end_reason = $2, ended_by = $3 WHERE id = $1', [current.id, current.user_id === userId ? 'released' : 'released_by_admin', userId]);
  return current;
}

/** The claimer read their ticket: it stays claimed for another CLAIM_DAYS. */
export async function touchClaim(q: Queryable, workspaceId: string, key: IssueKey, userId: string): Promise<void> {
  await q.query('UPDATE ticket_claims SET active_at = now_ms() WHERE workspace_id = $1 AND repo_id = $2 AND number = $3 AND user_id = $4 AND ended_at IS NULL', [workspaceId, key.repoId, key.number, userId]);
}

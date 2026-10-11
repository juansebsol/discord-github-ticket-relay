import type { Queryable } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export type StatePurpose = 'discord_login' | 'discord_bot' | 'github_install';

export interface StateRow {
  purpose: StatePurpose;
  session_id: string | null;
  workspace_id: string | null;
  data: Record<string, unknown>;
}

/** Creates a one-time, expiring OAuth `state` bound to a session and (optionally) workspace. */
export async function createState(
  q: Queryable,
  purpose: StatePurpose,
  sessionId: string | null,
  workspaceId: string | null,
  data: Record<string, unknown> = {},
  ttlMinutes = 15,
): Promise<string> {
  const token = randomToken(24);
  await q.query(
    `INSERT INTO oauth_states (state_hash, purpose, session_id, workspace_id, data, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [sha256(token), purpose, sessionId, workspaceId, data, ttlMinutes],
  );
  return token;
}

/** Consumes a state exactly once. Returns null if unknown, expired, reused or of another purpose. */
export async function consumeState(q: Queryable, token: string | undefined, purposes: StatePurpose[]): Promise<StateRow | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await q.query<StateRow>(
    `UPDATE oauth_states SET used_at = now()
     WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() AND purpose = ANY($2)
     RETURNING purpose, session_id, workspace_id, data`,
    [sha256(token), purposes],
  );
  return rows[0] ?? null;
}

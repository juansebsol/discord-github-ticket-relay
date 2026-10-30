/**
 * MCP: whether it's on for a workspace, and the personal tokens coding agents connect with. A
 * token is shown once when it's made; only its hash is kept. Every call checks the token, that
 * MCP is on and that the person is still a member, so turning MCP off, revoking a token or
 * removing someone takes effect on their agent's next call.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { getMembership, type Membership } from '../domain/workspaces.js';
import { UserFacingError } from '../domain/types.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export const TOKEN_PREFIX = 'trm_';
/** How long a new token lasts (days); admins can also make one that never expires. */
export const EXPIRY_DAYS = [30, 90, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;
export const TOKEN_NAME_MAX = 60;
/** Tokens one person can have in a workspace at once (one per device). */
export const MAX_TOKENS = 10;

export interface McpSettings {
  enabled: boolean;
  enabledAt: Date | null;
}

export async function getMcpSettings(q: Queryable, workspaceId: string): Promise<McpSettings> {
  const { rows } = await q.query<{ enabled: boolean; enabled_at: Date | null }>('SELECT enabled, enabled_at FROM mcp_settings WHERE workspace_id = $1', [workspaceId]);
  return { enabled: Boolean(rows[0]?.enabled), enabledAt: rows[0]?.enabled_at ?? null };
}

export async function setMcpEnabled(q: Queryable, workspaceId: string, on: boolean, userId: string): Promise<void> {
  await q.query(
    `INSERT INTO mcp_settings (workspace_id, enabled, enabled_at, updated_by, updated_at) VALUES ($1, $2, CASE WHEN $2 THEN now_ms() END, $3, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = CASE WHEN excluded.enabled AND NOT mcp_settings.enabled THEN now_ms() ELSE mcp_settings.enabled_at END,
       updated_by = excluded.updated_by, updated_at = now_ms()`,
    [workspaceId, on, userId],
  );
}

export interface McpToken {
  id: string;
  workspace_id: string;
  user_id: string;
  user_name: string;
  name: string;
  hint: string;
  read_only: boolean;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  last_client: string | null;
  calls: number;
  revoked_at: Date | null;
}

const SELECT = `SELECT t.id, t.workspace_id, t.user_id, COALESCE(u.display_name, u.username) AS user_name, t.name, t.hint, t.read_only, t.created_at, t.expires_at,
    t.last_used_at, t.last_client, t.calls, t.revoked_at
  FROM mcp_tokens t JOIN users u ON u.id = t.user_id`;

const toToken = (r: McpToken & { read_only: unknown }): McpToken => ({ ...r, read_only: Boolean(r.read_only), calls: Number(r.calls) });

export function isExpired(t: Pick<McpToken, 'expires_at'>, now = Date.now()): boolean {
  return Boolean(t.expires_at && t.expires_at.getTime() <= now);
}

/** Tokens that still work, newest first: everyone's, or one person's. */
export async function listTokens(q: Queryable, workspaceId: string, userId?: string): Promise<McpToken[]> {
  const params: unknown[] = [workspaceId, Date.now()];
  const where = ['t.workspace_id = $1', 't.revoked_at IS NULL', '(t.expires_at IS NULL OR t.expires_at > $2)'];
  if (userId) {
    params.push(userId);
    where.push(`t.user_id = $${params.length}`);
  }
  const { rows } = await q.query<McpToken & { read_only: unknown }>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC`, params);
  return rows.map(toToken);
}

/** Makes a token for this person. Returns the token itself, which is never shown again. */
export async function createToken(q: Queryable, workspaceId: string, userId: string, o: { name: string; readOnly: boolean; days: number | null }): Promise<{ token: string; row: McpToken }> {
  const name = o.name.replace(/\s+/g, ' ').trim().slice(0, TOKEN_NAME_MAX) || 'Coding agent';
  if ((await listTokens(q, workspaceId, userId)).length >= MAX_TOKENS) throw new UserFacingError(`You have ${MAX_TOKENS} tokens already. Revoke one you no longer use first.`);
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const id = randomUUID();
  await q.query(
    'INSERT INTO mcp_tokens (id, workspace_id, user_id, name, token_hash, hint, read_only, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, workspaceId, userId, name, sha256(token), token.slice(-4), o.readOnly, o.days ? new Date(Date.now() + o.days * 86_400_000) : null],
  );
  const row = (await listTokens(q, workspaceId, userId)).find((t) => t.id === id)!;
  return { token, row };
}

/** Revokes a token: anyone's (admins), or only one's own when `ownerId` is given. */
export async function revokeToken(q: Queryable, workspaceId: string, id: string, by: string, o: { ownerId?: string } = {}): Promise<McpToken> {
  const t = (await listTokens(q, workspaceId)).find((x) => x.id === id && (!o.ownerId || x.user_id === o.ownerId));
  if (!t) throw new UserFacingError('That token wasn’t found. It may be revoked or expired already.', 404);
  await q.query('UPDATE mcp_tokens SET revoked_at = now_ms(), revoked_by = $2 WHERE id = $1', [id, by]);
  return t;
}

export interface McpCaller {
  token: McpToken;
  membership: Membership;
}

/** Why a token isn't let in, for the agent (nothing about whether such a token exists). */
export type AuthFailure = 'missing' | 'invalid' | 'off';

/** The person and workspace behind a bearer token, while it works and MCP is on there. */
export async function authenticate(q: Queryable, bearer: string | null): Promise<McpCaller | AuthFailure> {
  if (!bearer) return 'missing';
  if (!bearer.startsWith(TOKEN_PREFIX) || bearer.length > 100) return 'invalid';
  const { rows } = await q.query<McpToken & { read_only: unknown }>(`${SELECT} WHERE t.token_hash = $1`, [sha256(bearer)]);
  const t = rows[0] ? toToken(rows[0]) : null;
  if (!t || t.revoked_at || isExpired(t)) return 'invalid';
  const membership = await getMembership(q, t.user_id, t.workspace_id);
  if (!membership) return 'invalid';
  if (!(await getMcpSettings(q, t.workspace_id)).enabled) return 'off';
  return { token: t, membership };
}

/** Counts a call, and remembers what connected ("claude-code 2.1.3") when it said. */
export async function touchToken(q: Queryable, id: string, client: string | null): Promise<void> {
  await q.query('UPDATE mcp_tokens SET last_used_at = now_ms(), calls = calls + 1, last_client = COALESCE($2, last_client) WHERE id = $1', [id, client ? client.slice(0, 80) : null]);
}

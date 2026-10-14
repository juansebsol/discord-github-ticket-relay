/**
 * The workspace's Claude API key: one place (Settings › Claude API) for every feature that
 * uses Claude. Stored encrypted and never shown again; only a hint (sk-ant-…abcd) is.
 * Without a workspace key, ANTHROPIC_API_KEY on the server is used as a fallback.
 */
import type { Queryable } from '../db/database.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Deps } from './types.js';

export type KeyState = 'working' | 'rejected' | 'credits' | 'unreachable';

export interface ClaudeKeyInfo {
  hint: string;
  addedBy: string | null;
  addedAt: Date | null;
  check: { at: Date; state: KeyState; detail: string | null } | null;
}

export interface ClaudeKeyStatus {
  /** Where the key in use comes from; null when there is none. */
  source: 'workspace' | 'server' | null;
  key: ClaudeKeyInfo | null;
  state: KeyState | 'missing' | 'unchecked';
  detail: string | null;
  checkedAt: Date | null;
}

export const KEY_STATE_TEXT: Record<ClaudeKeyStatus['state'], string> = {
  working: 'Working',
  rejected: 'Key rejected',
  credits: 'Out of credits',
  unreachable: 'Couldn’t check',
  missing: 'Not set',
  unchecked: 'Not checked yet',
};

/** A short, non-secret reminder of which key is stored. */
export function keyHint(key: string): string {
  return key.startsWith('sk-ant-') ? `sk-ant-…${key.slice(-4)}` : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function looksLikeApiKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
}

interface Row {
  key_enc: string | null;
  key_hint: string | null;
  added_by_name: string | null;
  key_added_at: Date | null;
  checked_at: Date | null;
  check_state: KeyState | null;
  check_detail: string | null;
}

async function row(q: Queryable, workspaceId: string): Promise<Row | null> {
  const { rows } = await q.query<Row>(
    `SELECT a.*, COALESCE(u.display_name, u.username) AS added_by_name FROM workspace_ai a
     LEFT JOIN users u ON u.id = a.key_added_by WHERE a.workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function getClaudeKey(q: Queryable, workspaceId: string): Promise<ClaudeKeyInfo | null> {
  const r = await row(q, workspaceId);
  if (!r?.key_enc) return null;
  return {
    hint: r.key_hint ?? 'sk-ant-…',
    addedBy: r.added_by_name,
    addedAt: r.key_added_at,
    check: r.checked_at && r.check_state ? { at: r.checked_at, state: r.check_state, detail: r.check_detail } : null,
  };
}

/** Stores a new key (encrypted). A paused triage resumes, since the key was usually why. */
export async function setClaudeKey(q: Queryable, box: SecretBox, workspaceId: string, key: string, userId: string, check: { state: KeyState; detail: string | null } | null): Promise<void> {
  await q.query(
    `INSERT INTO workspace_ai (workspace_id, key_enc, key_hint, key_added_by, key_added_at, checked_at, check_state, check_detail)
     VALUES ($1, $2, $3, $4, now_ms(), CASE WHEN $5 IS NULL THEN NULL ELSE now_ms() END, $5, $6)
     ON CONFLICT (workspace_id) DO UPDATE SET key_enc = $2, key_hint = $3, key_added_by = $4, key_added_at = now_ms(),
       checked_at = CASE WHEN $5 IS NULL THEN NULL ELSE now_ms() END, check_state = $5, check_detail = $6, updated_at = now_ms()`,
    [workspaceId, box.encrypt(key), keyHint(key), userId, check?.state ?? null, check?.detail ?? null],
  );
  await q.query(`UPDATE triage_settings SET paused_reason = NULL, paused_detail = NULL, paused_at = NULL, updated_at = now_ms() WHERE workspace_id = $1`, [workspaceId]);
}

export async function removeClaudeKey(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(
    `UPDATE workspace_ai SET key_enc = NULL, key_hint = NULL, key_added_by = NULL, key_added_at = NULL, checked_at = NULL, check_state = NULL, check_detail = NULL, updated_at = now_ms()
     WHERE workspace_id = $1`,
    [workspaceId],
  );
}

/** Remembers the latest check, from a test or from a real call (triage reports its own errors). */
export async function recordKeyCheck(q: Queryable, workspaceId: string, state: KeyState, detail: string | null): Promise<void> {
  await q.query(
    `UPDATE workspace_ai SET checked_at = now_ms(), check_state = $2, check_detail = $3 WHERE workspace_id = $1 AND key_enc IS NOT NULL`,
    [workspaceId, state, detail ? detail.slice(0, 300) : null],
  );
}

/** The workspace's own key, or the deployment's fallback key from ANTHROPIC_API_KEY. */
export async function resolveClaudeKey(deps: Pick<Deps, 'db' | 'box' | 'config'>, workspaceId: string): Promise<{ key: string; source: 'workspace' | 'server' } | null> {
  const r = await row(deps.db, workspaceId);
  if (r?.key_enc) {
    try {
      return { key: deps.box.decrypt(r.key_enc), source: 'workspace' };
    } catch {
      return null;
    }
  }
  return deps.config.anthropicApiKey ? { key: deps.config.anthropicApiKey, source: 'server' } : null;
}

/** How a check failure is described, from the triage error classification. */
export function stateFromPause(reason: string | null): KeyState {
  return reason === 'key_invalid' ? 'rejected' : reason === 'credits' ? 'credits' : 'unreachable';
}

const serverChecks = new Map<string, { at: number; state: KeyState; detail: string | null }>();
const STALE_CHECK_MS = 10 * 60_000;

/**
 * The status shown in Settings, Triage and Deployment. Checks the key with Claude (listing
 * models costs nothing) when the last check is older than 10 minutes, or when `fresh`.
 */
export async function claudeKeyStatus(
  deps: Pick<Deps, 'db' | 'box' | 'config'>,
  check: (key: string) => Promise<{ state: KeyState; detail: string | null }>,
  workspaceId: string,
  o: { fresh?: boolean; live?: boolean } = {},
): Promise<ClaudeKeyStatus> {
  const key = await getClaudeKey(deps.db, workspaceId);
  const resolved = await resolveClaudeKey(deps, workspaceId);
  if (!resolved) return { source: null, key: null, state: 'missing', detail: null, checkedAt: null };
  const live = o.live ?? true;
  if (resolved.source === 'workspace') {
    const last = key?.check ?? null;
    if (live && (o.fresh || !last || Date.now() - last.at.getTime() > STALE_CHECK_MS)) {
      const r = await check(resolved.key);
      await recordKeyCheck(deps.db, workspaceId, r.state, r.detail);
      return { source: 'workspace', key, state: r.state, detail: r.detail, checkedAt: new Date() };
    }
    return { source: 'workspace', key, state: last?.state ?? 'unchecked', detail: last?.detail ?? null, checkedAt: last?.at ?? null };
  }
  // The server's fallback key: remembered in memory per process.
  let last = serverChecks.get('server');
  if (live && (o.fresh || !last || Date.now() - last.at > STALE_CHECK_MS)) {
    const r = await check(resolved.key);
    last = { at: Date.now(), ...r };
    serverChecks.set('server', last);
  }
  return { source: 'server', key: null, state: last?.state ?? 'unchecked', detail: last?.detail ?? null, checkedAt: last ? new Date(last.at) : null };
}

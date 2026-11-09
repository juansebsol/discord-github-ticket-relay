/**
 * Install links: a workspace's admins send one to someone who owns the GitHub organization (often
 * a linked workspace's), who installs the GitHub App through it without an account here. GitHub
 * still asks them to sign in, so only installations they can access can be connected. One link
 * per workspace at a time; it works once and expires after 7 days. It's kept encrypted, so admins
 * can copy it again until it's used.
 */
import type { Queryable } from '../db/database.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { Deps, WorkspaceRow } from './types.js';

export const GITHUB_LINK_DAYS = 7;

/** Makes a new link (the old one stops working) and returns its token. */
export async function createGitHubLink(deps: Pick<Deps, 'db' | 'box'>, workspaceId: string): Promise<string> {
  const token = randomToken(24);
  await deps.db.query(
    'UPDATE workspaces SET github_link_hash = $2, github_link_enc = $3, github_link_expires_at = now_ms() + $4, updated_at = now_ms() WHERE id = $1',
    [workspaceId, sha256(token), deps.box.encrypt(token), GITHUB_LINK_DAYS * 86_400_000],
  );
  return token;
}

/** The workspace's link while it works: its token (for the address) and when it expires. */
export function currentGitHubLink(deps: Pick<Deps, 'box'>, ws: WorkspaceRow): { token: string; expiresAt: Date } | null {
  if (!ws.github_link_enc || !ws.github_link_expires_at || ws.github_link_expires_at.getTime() <= Date.now()) return null;
  try {
    return { token: deps.box.decrypt(ws.github_link_enc), expiresAt: ws.github_link_expires_at };
  } catch {
    return null;
  }
}

export async function clearGitHubLink(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('UPDATE workspaces SET github_link_hash = NULL, github_link_enc = NULL, github_link_expires_at = NULL, updated_at = now_ms() WHERE id = $1', [workspaceId]);
}

/** The workspace a link belongs to, while it works. */
export async function findGitHubLink(q: Queryable, token: string): Promise<WorkspaceRow | null> {
  if (!token || token.length > 200) return null;
  const { rows } = await q.query<WorkspaceRow>('SELECT * FROM workspaces WHERE github_link_hash = $1 AND github_link_expires_at > now_ms()', [sha256(token)]);
  return rows[0] ?? null;
}

/** Whether a link (by its hash, as kept in the OAuth state) still belongs to this workspace and works. */
export async function gitHubLinkValid(q: Queryable, workspaceId: string, hash: unknown): Promise<boolean> {
  if (typeof hash !== 'string') return false;
  const { rows } = await q.query('SELECT 1 FROM workspaces WHERE id = $1 AND github_link_hash = $2 AND github_link_expires_at > now_ms()', [workspaceId, hash]);
  return rows.length > 0;
}

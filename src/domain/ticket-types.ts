import { randomUUID } from 'node:crypto';
import { isUniqueViolation, type Queryable } from '../db/database.js';
import { randomCode } from '../lib/crypto.js';
import { UserFacingError } from './types.js';

/**
 * Ticket types: members pick one (e.g. Bug report) after choosing the app. Each type can add
 * a GitHub label and a title prefix to the issue, and has its own form guidance.
 */
export interface TicketType {
  id: string;
  workspace_id: string;
  public_id: string;
  name: string;
  description: string | null;
  label: string | null;
  title_prefix: string | null;
  guidance: string | null;
  placeholder: string | null;
  enabled: boolean;
  position: number;
}

export interface TicketTypeInput {
  name: string;
  description: string | null;
  label: string | null;
  title_prefix: string | null;
  guidance: string | null;
  placeholder: string | null;
  enabled: boolean;
}

/** Discord select menus hold at most 25 options. */
export const MAX_TICKET_TYPES = 25;

export async function listTicketTypes(q: Queryable, workspaceId: string): Promise<TicketType[]> {
  const { rows } = await q.query<TicketType>('SELECT * FROM ticket_types WHERE workspace_id = $1 ORDER BY position, lower(name)', [workspaceId]);
  return rows;
}

export async function enabledTicketTypes(q: Queryable, workspaceId: string): Promise<TicketType[]> {
  return (await listTicketTypes(q, workspaceId)).filter((t) => t.enabled);
}

export async function getTicketType(q: Queryable, workspaceId: string, id: string): Promise<TicketType | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await q.query<TicketType>('SELECT * FROM ticket_types WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
  return rows[0] ?? null;
}

export async function getTicketTypeByPublicId(q: Queryable, workspaceId: string, publicId: string): Promise<TicketType | null> {
  const { rows } = await q.query<TicketType>('SELECT * FROM ticket_types WHERE workspace_id = $1 AND public_id = $2', [workspaceId, publicId]);
  return rows[0] ?? null;
}

export async function createTicketType(q: Queryable, workspaceId: string, input: TicketTypeInput): Promise<void> {
  const count = (await listTicketTypes(q, workspaceId)).length;
  if (count >= MAX_TICKET_TYPES) throw new UserFacingError(`Discord allows at most ${MAX_TICKET_TYPES} ticket types.`);
  try {
    await q.query(
      `INSERT INTO ticket_types (id, workspace_id, public_id, name, description, label, title_prefix, guidance, placeholder, enabled, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [randomUUID(), workspaceId, randomCode(8), input.name, input.description, input.label, input.title_prefix, input.guidance, input.placeholder, input.enabled, count],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserFacingError(`A ticket type named “${input.name}” already exists.`, 409);
    throw err;
  }
}

export async function updateTicketType(q: Queryable, workspaceId: string, id: string, input: TicketTypeInput): Promise<void> {
  try {
    await q.query(
      `UPDATE ticket_types SET name = $3, description = $4, label = $5, title_prefix = $6, guidance = $7, placeholder = $8,
         enabled = $9, updated_at = now_ms() WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id, input.name, input.description, input.label, input.title_prefix, input.guidance, input.placeholder, input.enabled],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserFacingError(`A ticket type named “${input.name}” already exists.`, 409);
    throw err;
  }
}

export async function deleteTicketType(q: Queryable, workspaceId: string, id: string): Promise<void> {
  await q.query('DELETE FROM ticket_types WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
}

export async function moveTicketType(q: Queryable, workspaceId: string, id: string, direction: 'up' | 'down'): Promise<void> {
  const types = await listTicketTypes(q, workspaceId);
  const i = types.findIndex((t) => t.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= types.length) return;
  [types[i], types[j]] = [types[j]!, types[i]!];
  for (let n = 0; n < types.length; n++) {
    await q.query('UPDATE ticket_types SET position = $3 WHERE workspace_id = $1 AND id = $2', [workspaceId, types[n]!.id, n]);
  }
}

/** Suggested colors for common labels when the admin asks us to create them. */
export function labelColor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('bug')) return 'd73a4a';
  if (n.includes('feature') || n.includes('enhancement')) return 'a2eeef';
  if (n.includes('question')) return 'd876e3';
  if (n.includes('doc')) return '0075ca';
  return 'ededed';
}

// ---- GitHub label coverage -------------------------------------------------------------------

export interface LabelGap {
  label: string;
  repos: { owner: string; name: string }[];
}

/**
 * For each type label, the enabled apps' repositories that don't have it yet. Missing labels
 * are skipped when filing (we never create labels silently), so admins see them here.
 */
export async function findMissingTypeLabels(
  github: { listLabels(installationId: number, owner: string, repo: string): Promise<string[]> },
  installationId: number,
  types: TicketType[],
  repos: { id: number; owner: string; name: string }[],
): Promise<LabelGap[]> {
  const wanted = [...new Set(types.filter((t) => t.enabled && t.label).map((t) => t.label!))];
  if (!wanted.length) return [];
  const gaps = new Map<string, LabelGap>();
  for (const repo of repos) {
    const existing = new Set(await github.listLabels(installationId, repo.owner, repo.name));
    for (const label of wanted) {
      if (existing.has(label)) continue;
      const gap = gaps.get(label) ?? { label, repos: [] };
      gap.repos.push({ owner: repo.owner, name: repo.name });
      gaps.set(label, gap);
    }
  }
  return [...gaps.values()];
}

export function distinctRepos(apps: { repo_id: number; repo_owner: string; repo_name: string; enabled: boolean }[]) {
  const seen = new Map<number, { id: number; owner: string; name: string }>();
  for (const a of apps) if (a.enabled && !seen.has(a.repo_id)) seen.set(a.repo_id, { id: a.repo_id, owner: a.repo_owner, name: a.repo_name });
  return [...seen.values()];
}

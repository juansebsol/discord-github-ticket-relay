import { withTransaction, type Queryable } from '../db/pool.js';
import { newSubmissionRef, type SecretBox } from '../lib/crypto.js';
import type { AppRow, Deps, SubmissionRow, SubmissionStatus, TicketPayload, WorkspaceRow } from './types.js';

/** Discord interaction tokens stay valid for 15 minutes. */
export const INTERACTION_TOKEN_TTL_MS = 15 * 60_000;
export const LEASE_SECONDS = 90;

export function normalizeForDuplicateCheck(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function contentHash(box: SecretBox, title: string, description: string): string {
  return box.mac(`${normalizeForDuplicateCheck(title)}\n${normalizeForDuplicateCheck(description)}`);
}

export async function addEvent(q: Queryable, submissionId: string, kind: string, detail: Record<string, unknown> = {}) {
  await q.query('INSERT INTO submission_events (submission_id, kind, detail) VALUES ($1, $2, $3)', [submissionId, kind, detail]);
}

export interface AcceptInput {
  workspace: WorkspaceRow;
  app: AppRow;
  installationId: number;
  source: 'discord' | 'admin_test';
  interactionId: string | null;
  interactionToken: string | null;
  guildId: string | null;
  guildName: string | null;
  channelId: string | null;
  reporter: { id: string; displayName: string; username: string | null };
  title: string;
  description: string;
}

export type AcceptResult =
  | { kind: 'accepted'; submission: SubmissionRow }
  | { kind: 'duplicate_delivery'; submission: SubmissionRow }
  | { kind: 'duplicate_content'; existing: SubmissionRow }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

/**
 * Records a new submission and freezes its routing (repository, labels, installation).
 * Runs under a per-reporter advisory lock so concurrent submissions from the same person
 * are checked for duplicates and rate limits one at a time; the unique interaction ID
 * makes repeated deliveries of the same Discord interaction a no-op.
 */
export async function acceptSubmission(deps: Pick<Deps, 'db' | 'box'>, input: AcceptInput): Promise<AcceptResult> {
  const { box } = deps;
  const hash = contentHash(box, input.title, input.description);
  return withTransaction(deps.db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`submit:${input.workspace.id}:${input.reporter.id}`]);

    if (input.interactionId) {
      const { rows } = await c.query<SubmissionRow>('SELECT * FROM submissions WHERE discord_interaction_id = $1', [input.interactionId]);
      if (rows[0]) return { kind: 'duplicate_delivery', submission: rows[0] };
    }

    if (input.source === 'discord') {
      if (input.workspace.duplicate_window_minutes > 0) {
        const { rows } = await c.query<SubmissionRow>(
          `SELECT * FROM submissions
           WHERE workspace_id = $1 AND reporter_discord_id = $2 AND app_id = $3 AND content_hash = $4
             AND status NOT IN ('failed', 'dismissed') AND created_at > now() - make_interval(mins => $5)
           ORDER BY created_at DESC LIMIT 1`,
          [input.workspace.id, input.reporter.id, input.app.id, hash, input.workspace.duplicate_window_minutes],
        );
        if (rows[0]) return { kind: 'duplicate_content', existing: rows[0] };
      }

      const { rows } = await c.query<{ count: number; oldest: Date | null }>(
        `SELECT count(*)::int AS count, min(created_at) AS oldest FROM submissions
         WHERE workspace_id = $1 AND reporter_discord_id = $2 AND source = 'discord'
           AND created_at > now() - make_interval(mins => $3)`,
        [input.workspace.id, input.reporter.id, input.workspace.rate_limit_window_minutes],
      );
      const { count, oldest } = rows[0]!;
      if (count >= input.workspace.rate_limit_count && oldest) {
        const resetAt = oldest.getTime() + input.workspace.rate_limit_window_minutes * 60_000;
        return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
      }
    }

    const payload: TicketPayload = { title: input.title, description: input.description };
    const { rows } = await c.query<SubmissionRow>(
      `INSERT INTO submissions (
         workspace_id, ref, source, app_id, app_name, installation_id, repo_id, repo_owner, repo_name, repo_private, labels,
         discord_interaction_id, discord_guild_id, discord_guild_name, discord_channel_id,
         reporter_discord_id, reporter_display_name, reporter_username,
         payload_enc, content_hash, status, next_attempt_at, interaction_token_enc, interaction_token_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'pending', now(), $21, $22)
       ON CONFLICT (discord_interaction_id) DO NOTHING
       RETURNING *`,
      [
        input.workspace.id,
        newSubmissionRef(),
        input.source,
        input.app.id,
        input.app.name,
        input.installationId,
        input.app.repo_id,
        input.app.repo_owner,
        input.app.repo_name,
        input.app.repo_private,
        input.app.labels,
        input.interactionId,
        input.guildId,
        input.guildName,
        input.channelId,
        input.reporter.id,
        input.reporter.displayName,
        input.reporter.username,
        box.encryptJson(payload),
        hash,
        input.interactionToken ? box.encrypt(input.interactionToken) : null,
        input.interactionToken ? new Date(Date.now() + INTERACTION_TOKEN_TTL_MS - 30_000) : null,
      ],
    );
    if (!rows[0]) {
      const existing = await c.query<SubmissionRow>('SELECT * FROM submissions WHERE discord_interaction_id = $1', [input.interactionId]);
      return { kind: 'duplicate_delivery', submission: existing.rows[0]! };
    }
    await addEvent(c, rows[0].id, 'accepted', {
      source: input.source,
      repo: `${input.app.repo_owner}/${input.app.repo_name}`,
      labels: input.app.labels,
    });
    return { kind: 'accepted', submission: rows[0] };
  });
}

// ---- Work queue ---------------------------------------------------------------------------

const CLAIMABLE = `(
  (status = 'pending' AND next_attempt_at <= now())
  OR (status = 'uncertain' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
  OR (status = 'processing' AND lease_until < now())
)`;

/**
 * Atomically claims the next due submission. FOR UPDATE SKIP LOCKED plus the lease make
 * this safe with many workers: each row is processed by one worker at a time, and a row
 * whose worker died becomes claimable again once its lease expires.
 */
export async function claimNext(q: Queryable, owner: string): Promise<SubmissionRow | null> {
  const { rows } = await q.query<SubmissionRow>(
    `WITH next AS (
       SELECT id FROM submissions WHERE ${CLAIMABLE}
       ORDER BY next_attempt_at NULLS FIRST, created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE submissions s SET status = 'processing', lease_owner = $1,
       lease_until = now() + make_interval(secs => $2), updated_at = now()
     FROM next WHERE s.id = next.id
     RETURNING s.*`,
    [owner, LEASE_SECONDS],
  );
  return rows[0] ?? null;
}

export async function claimById(q: Queryable, id: string, owner: string, opts: { force?: boolean } = {}): Promise<SubmissionRow | null> {
  const condition = opts.force ? `status IN ('pending', 'uncertain', 'failed') OR (status = 'processing' AND lease_until < now())` : CLAIMABLE;
  const { rows } = await q.query<SubmissionRow>(
    `WITH next AS (SELECT id FROM submissions WHERE id = $3 AND (${condition}) FOR UPDATE SKIP LOCKED)
     UPDATE submissions s SET status = 'processing', lease_owner = $1,
       lease_until = now() + make_interval(secs => $2), updated_at = now()
     FROM next WHERE s.id = next.id
     RETURNING s.*`,
    [owner, LEASE_SECONDS, id],
  );
  return rows[0] ?? null;
}

/**
 * Updates a submission only while this worker still holds its lease. Returns false if the
 * lease was lost, in which case the caller must stop working on it.
 */
export async function updateLeased(
  q: Queryable,
  sub: Pick<SubmissionRow, 'id'>,
  owner: string,
  fields: Partial<Record<keyof SubmissionRow, unknown>>,
  releaseLease: boolean,
): Promise<boolean> {
  const entries = Object.entries(fields);
  if (releaseLease) entries.push(['lease_owner', null], ['lease_until', null]);
  const sets = entries.map(([k], i) => `${k} = $${i + 3}`);
  sets.push('updated_at = now()');
  const res = await q.query(
    `UPDATE submissions SET ${sets.join(', ')} WHERE id = $1 AND lease_owner = $2 AND status = 'processing'`,
    [sub.id, owner, ...entries.map(([, v]) => v)],
  );
  return (res.rowCount ?? 0) === 1;
}

// ---- Admin queries ------------------------------------------------------------------------

export async function getSubmission(q: Queryable, workspaceId: string, id: string): Promise<SubmissionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await q.query<SubmissionRow>('SELECT * FROM submissions WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
  return rows[0] ?? null;
}

export async function listSubmissions(
  q: Queryable,
  workspaceId: string,
  opts: { status?: SubmissionStatus | 'attention'; search?: string; limit: number; offset: number },
): Promise<{ rows: SubmissionRow[]; total: number }> {
  const where = ['workspace_id = $1'];
  const params: unknown[] = [workspaceId];
  if (opts.status === 'attention') where.push(`status IN ('failed', 'uncertain')`);
  else if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search.replace(/[%_\\]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    where.push(`(ref ILIKE ${p} OR reporter_display_name ILIKE ${p} OR reporter_username ILIKE ${p} OR reporter_discord_id ILIKE ${p} OR app_name ILIKE ${p})`);
  }
  const clause = where.join(' AND ');
  const total = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM submissions WHERE ${clause}`, params)).rows[0]!.n;
  params.push(opts.limit, opts.offset);
  const { rows } = await q.query<SubmissionRow>(
    `SELECT * FROM submissions WHERE ${clause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total };
}

export async function countByStatus(q: Queryable, workspaceId: string): Promise<Record<SubmissionStatus, number>> {
  const { rows } = await q.query<{ status: SubmissionStatus; n: number }>(
    'SELECT status, count(*)::int AS n FROM submissions WHERE workspace_id = $1 GROUP BY status',
    [workspaceId],
  );
  const out = { pending: 0, processing: 0, created: 0, failed: 0, uncertain: 0, dismissed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function listEvents(q: Queryable, submissionId: string) {
  const { rows } = await q.query<{ id: number; at: Date; kind: string; detail: Record<string, unknown> }>(
    'SELECT id, at, kind, detail FROM submission_events WHERE submission_id = $1 ORDER BY id',
    [submissionId],
  );
  return rows;
}

export function decryptPayload(box: SecretBox, sub: Pick<SubmissionRow, 'payload_enc'>): TicketPayload | null {
  if (!sub.payload_enc) return null;
  try {
    return box.decryptJson<TicketPayload>(sub.payload_enc);
  } catch {
    return null;
  }
}

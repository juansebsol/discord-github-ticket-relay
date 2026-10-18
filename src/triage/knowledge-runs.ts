/**
 * AI triage › Knowledge, live. Every "Write all", "Update now" or scheduled update is a run: its
 * apps are written one at a time by the triage worker, which saves what's happening as it goes
 * (each app's live state below), so the console can show it (the Live studio, and its pill on
 * every page) and stop it.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

/** The steps of one app's write, in order (answers only when it had questions). */
export const LIVE_STEPS = ['repo', 'issues', 'thinking', 'writing', 'answers'] as const;
/** The steps of an update with merged changes. */
export const CHANGE_STEPS = ['changes', 'thinking', 'writing'] as const;
export type LiveStep = (typeof LIVE_STEPS)[number] | 'changes';
export type LiveTag = 'github' | 'issues' | 'tickets' | 'claude' | 'answer' | 'change' | 'done' | 'error' | 'stop';
/** A full rewrite, or an update of the parts merged changes touch. */
export type WriteMode = 'full' | 'changes';

/** What the live view shows of one app's write (app_knowledge.auto_live). Times are ms since it started. */
export interface LiveState {
  steps: { key: LiveStep; from: number; to?: number }[];
  log: { at: number; tag: LiveTag; text: string }[];
  /** What Claude has written so far; emptied once saved (the TRIAGE.md has it then). */
  text: string;
  /** The questions from triage it was asked, and its answers as they come in. */
  answers: { question: string; answer: string | null; done: boolean }[];
  inputTokens?: number;
  /** Exact once it's done. */
  outputTokens?: number;
  result?: 'done' | 'failed' | 'stopped';
  error?: string;
  /** It ran out of room; what it wrote until then was kept. */
  cutOff?: boolean;
}

export function emptyLive(): LiveState {
  return { steps: [], log: [], text: '', answers: [] };
}

export interface KnowledgeRun {
  id: string;
  workspace_id: string;
  /** null: Keep them up to date started it. */
  started_by: string | null;
  started_by_name: string | null;
  started_at: Date;
  finished_at: Date | null;
  stopped_at: Date | null;
}

const RUN_SELECT = `SELECT r.id, r.workspace_id, r.started_by, COALESCE(u.display_name, u.username) AS started_by_name, r.started_at, r.finished_at, r.stopped_at
  FROM knowledge_runs r LEFT JOIN users u ON u.id = r.started_by`;

/** The run in progress, if any. */
export async function activeRun(q: Queryable, workspaceId: string): Promise<KnowledgeRun | null> {
  const { rows } = await q.query<KnowledgeRun>(`${RUN_SELECT} WHERE r.workspace_id = $1 AND r.finished_at IS NULL ORDER BY r.started_at DESC LIMIT 1`, [workspaceId]);
  return rows[0] ?? null;
}

/** The latest run, finished or not. */
export async function latestRun(q: Queryable, workspaceId: string): Promise<KnowledgeRun | null> {
  const { rows } = await q.query<KnowledgeRun>(`${RUN_SELECT} WHERE r.workspace_id = $1 ORDER BY r.started_at DESC LIMIT 1`, [workspaceId]);
  return rows[0] ?? null;
}

/** A finished run's summary stays on every page for this long. */
export const RUN_SHOWN_AFTER_MS = 2 * 60_000;

/** Whether pages show the run (in progress, or just finished). */
export async function runShown(q: Queryable, workspaceId: string, now = Date.now()): Promise<boolean> {
  const { rows } = await q.query('SELECT 1 FROM knowledge_runs WHERE workspace_id = $1 AND (finished_at IS NULL OR finished_at > $2) LIMIT 1', [workspaceId, new Date(now - RUN_SHOWN_AFTER_MS)]);
  return rows.length > 0;
}

/**
 * Asks the triage worker to write (or rewrite) these apps' TRIAGE.md, in the run in progress or
 * a new one. Apps already waiting or being written are left as they are. Returns how many were
 * queued.
 */
export async function requestWrites(q: Queryable, workspaceId: string, appIds: string[], userId: string | null, mode: WriteMode = 'full'): Promise<number> {
  if (!appIds.length) return 0;
  const active = await activeRun(q, workspaceId);
  const runId = active?.id ?? randomUUID();
  if (!active) await q.query('INSERT INTO knowledge_runs (id, workspace_id, started_by) VALUES ($1, $2, $3)', [runId, workspaceId, userId]);
  let queued = 0;
  for (const appId of appIds) {
    const { rows } = await q.query(
      `INSERT INTO app_knowledge (app_id, workspace_id, auto_status, auto_requested_at, auto_requested_by, auto_run_id, auto_mode)
       SELECT a.id, a.workspace_id, 'queued', now_ms(), $3, $4, $5 FROM apps a WHERE a.id = $1 AND a.workspace_id = $2
       ON CONFLICT (app_id) DO UPDATE SET auto_status = 'queued', auto_requested_at = now_ms(), auto_requested_by = excluded.auto_requested_by,
         auto_run_id = excluded.auto_run_id, auto_mode = excluded.auto_mode, auto_attempts = 0, auto_error = NULL, auto_live = NULL, auto_cancel = 0,
         auto_started_at = NULL, auto_finished_at = NULL, updated_at = now_ms()
       WHERE app_knowledge.auto_status IS NULL OR app_knowledge.auto_status NOT IN ('queued', 'running')
       RETURNING app_id`,
      [appId, workspaceId, userId, runId, mode],
    );
    queued += rows.length;
    // Already waiting for an update with changes: a full rewrite covers those too.
    if (!rows.length && mode === 'full') await q.query("UPDATE app_knowledge SET auto_mode = 'full' WHERE app_id = $1 AND workspace_id = $2 AND auto_status = 'queued'", [appId, workspaceId]);
  }
  if (!active && !queued) await q.query('DELETE FROM knowledge_runs WHERE id = $1', [runId]);
  return queued;
}

/** Ends a run once none of its apps is waiting or being written. */
export async function finishRunIfDone(q: Queryable, runId: string | null): Promise<void> {
  if (!runId) return;
  await q.query(
    `UPDATE knowledge_runs SET finished_at = now_ms() WHERE id = $1 AND finished_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM app_knowledge WHERE auto_run_id = $1 AND auto_status IN ('queued', 'running'))`,
    [runId],
  );
}

/** A stopped app goes back to what it was: its last TRIAGE.md, or none. */
const RESTORED = `CASE WHEN auto_at IS NOT NULL AND auto_body <> '' THEN 'done' ELSE NULL END`;

/**
 * Stop: waiting apps leave the queue at once; the one being written is let go at the worker's
 * next update (within a second or two) and keeps its previous TRIAGE.md. 'all' stops the run.
 */
export async function stopWrites(q: Queryable, workspaceId: string, which: string[] | 'all', userId: string): Promise<{ unqueued: number; cancelled: number }> {
  const run = await activeRun(q, workspaceId);
  if (!run) return { unqueued: 0, cancelled: 0 };
  const only = which === 'all' ? [] : [JSON.stringify(which)];
  const unqueued = await q.query(
    `UPDATE app_knowledge SET auto_status = ${RESTORED}, auto_live = $3, auto_finished_at = now_ms(), updated_at = now_ms()
      WHERE workspace_id = $1 AND auto_run_id = $2 AND auto_status = 'queued'${only.length ? ' AND app_id IN (SELECT value FROM json_each($4))' : ''} RETURNING app_id`,
    [workspaceId, run.id, { ...emptyLive(), result: 'stopped' }, ...only],
  );
  const cancelled = await q.query(
    `UPDATE app_knowledge SET auto_cancel = 1 WHERE workspace_id = $1 AND auto_run_id = $2 AND auto_status = 'running'${only.length ? ' AND app_id IN (SELECT value FROM json_each($3))' : ''} RETURNING app_id`,
    [workspaceId, run.id, ...only],
  );
  if (which === 'all') await q.query('UPDATE knowledge_runs SET stopped_at = now_ms(), stopped_by = $2 WHERE id = $1', [run.id, userId]);
  await finishRunIfDone(q, run.id);
  return { unqueued: unqueued.rows.length, cancelled: cancelled.rows.length };
}

/** Runs left open with nothing in them (an app removed while it waited): closed. */
export async function closeIdleRuns(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE knowledge_runs SET finished_at = now_ms() WHERE finished_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM app_knowledge k WHERE k.auto_run_id = knowledge_runs.id AND k.auto_status IN ('queued', 'running'))`,
  );
}

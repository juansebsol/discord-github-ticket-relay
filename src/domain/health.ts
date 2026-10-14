/**
 * Server health: every process (web, filing workers, triage) reports its memory every 30
 * seconds, so the console can show how close each one is to the limit at which PM2 restarts
 * it. The limit comes from MEMORY_LIMIT_MB, set next to max_memory_restart in ecosystem.config.cjs.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { Db, Queryable } from '../db/database.js';

const BEAT_MS = 30_000;
/** A process that hasn't reported for this long has stopped (or was restarted). */
export const STALE_MS = 2 * 60_000;

export type ProcessRole = 'web' | 'worker' | 'triage';

/** Total and available memory of the machine (MemAvailable counts reclaimable cache, like `free`). */
export function hostMemory(): { total: number; available: number } {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN) * 1024;
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (Number.isFinite(total) && Number.isFinite(available)) return { total, available };
  } catch {
    // Not Linux.
  }
  return { total: os.totalmem(), available: os.freemem() };
}

function limitFromEnv(): number | null {
  const n = Number(process.env.MEMORY_LIMIT_MB);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

async function beat(q: Queryable, id: string, role: ProcessRole, startedAt: Date): Promise<void> {
  const mem = process.memoryUsage();
  const host = hostMemory();
  await q.query(
    `INSERT INTO process_status (id, role, pid, rss_bytes, heap_bytes, limit_mb, host_total_bytes, host_available_bytes, started_at, seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now_ms())
     ON CONFLICT (id) DO UPDATE SET rss_bytes = excluded.rss_bytes, heap_bytes = excluded.heap_bytes, limit_mb = excluded.limit_mb,
       host_total_bytes = excluded.host_total_bytes, host_available_bytes = excluded.host_available_bytes, seen_at = now_ms()`,
    [id, role, process.pid, mem.rss, mem.heapUsed, limitFromEnv(), host.total, host.available, startedAt],
  );
  // A week of history is enough to count restarts.
  await q.query('DELETE FROM process_status WHERE seen_at < now_ms() - 604800000');
}

/** Starts reporting this process; returns a function that stops it. Never throws. */
export function startHeartbeat(db: Db, o: { id: string; role: ProcessRole; log?: { warn(obj: object, msg?: string): void } }): () => void {
  const startedAt = new Date();
  const run = () => beat(db, o.id, o.role, startedAt).catch((err) => o.log?.warn({ err: (err as Error).message }, 'health report failed'));
  void run();
  const timer = setInterval(run, BEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface ProcessRow {
  id: string;
  role: ProcessRole;
  pid: number;
  rss_bytes: number;
  heap_bytes: number;
  limit_mb: number | null;
  host_total_bytes: number | null;
  host_available_bytes: number | null;
  started_at: Date;
  seen_at: Date;
}

export interface HealthView {
  host: { total: number; available: number; reportedAt: Date } | null;
  running: ProcessRow[];
  /** Processes of each role that stopped in the last 24 hours (restarts, crashes or deploys). */
  restarts: Record<ProcessRole, number>;
}

export async function healthView(q: Queryable): Promise<HealthView> {
  const { rows } = await q.query<ProcessRow>('SELECT * FROM process_status WHERE seen_at > now_ms() - 86400000 ORDER BY role, started_at');
  const now = Date.now();
  const order: Record<string, number> = { web: 0, worker: 1, triage: 2 };
  const running = rows.filter((r) => now - r.seen_at.getTime() < STALE_MS).sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.started_at.getTime() - b.started_at.getTime());
  const restarts: Record<ProcessRole, number> = { web: 0, worker: 0, triage: 0 };
  for (const r of rows) if (now - r.seen_at.getTime() >= STALE_MS && r.role in restarts) restarts[r.role]++;
  const latest = [...rows].filter((r) => r.host_total_bytes).sort((a, b) => b.seen_at.getTime() - a.seen_at.getTime())[0];
  return {
    host: latest ? { total: latest.host_total_bytes!, available: latest.host_available_bytes ?? 0, reportedAt: latest.seen_at } : null,
    running,
    restarts,
  };
}

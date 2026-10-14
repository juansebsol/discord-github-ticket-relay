/**
 * Server health: every process (web, filing workers, triage) reports its memory every 30
 * seconds, so the console can show how close each one is to the limit at which PM2 restarts
 * it. The limit comes from MEMORY_LIMIT_MB, set next to max_memory_restart in ecosystem.config.cjs.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
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

/** The GitHub API rate limit this process saw last, for the heartbeat. */
export function githubStats(deps: { github: { rateLimit: { limit: number; remaining: number; resetAt: Date; at: Date } | null } | null }): Partial<ProcessStats> {
  const r = deps.github?.rateLimit;
  return { github: r ? { limit: r.limit, remaining: r.remaining, resetAt: r.resetAt.toISOString(), at: r.at.toISOString() } : null };
}

/** Extra numbers a process reports (shown on the Server health page). */
export interface ProcessStats {
  cpuPct: number;
  /** Event-loop delay: how long work waits before it runs (milliseconds). */
  lagMeanMs: number;
  lagP99Ms: number;
  heapTotalBytes: number;
  node: string;
  github?: { limit: number; remaining: number; resetAt: string; at: string } | null;
}

/** Starts reporting this process; returns a function that stops it. Never throws. */
export function startHeartbeat(
  db: Db,
  o: { id: string; role: ProcessRole; log?: { warn(obj: object, msg?: string): void }; extra?: () => Partial<ProcessStats> },
): () => void {
  const startedAt = new Date();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let cpu = process.cpuUsage();
  let last = Date.now();
  const run = async () => {
    const mem = process.memoryUsage();
    const host = hostMemory();
    const now = Date.now();
    const used = process.cpuUsage(cpu);
    const cpuPct = Math.round(((used.user + used.system) / 1000 / Math.max(1, now - last)) * 1000) / 10;
    cpu = process.cpuUsage();
    last = now;
    const lag = (n: number) => (Number.isFinite(n) ? Math.round((n / 1e6) * 10) / 10 : 0);
    const stats: ProcessStats = { cpuPct, lagMeanMs: lag(loop.mean), lagP99Ms: lag(loop.percentile(99)), heapTotalBytes: mem.heapTotal, node: process.version, ...o.extra?.() };
    loop.reset();
    await db.query(
      `INSERT INTO process_status (id, role, pid, rss_bytes, heap_bytes, limit_mb, host_total_bytes, host_available_bytes, started_at, seen_at, stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now_ms(), $10)
       ON CONFLICT (id) DO UPDATE SET rss_bytes = excluded.rss_bytes, heap_bytes = excluded.heap_bytes, limit_mb = excluded.limit_mb,
         host_total_bytes = excluded.host_total_bytes, host_available_bytes = excluded.host_available_bytes, seen_at = now_ms(), stats = excluded.stats`,
      [o.id, o.role, process.pid, mem.rss, mem.heapUsed, limitFromEnv(), host.total, host.available, startedAt, stats],
    );
    await db.query(
      'INSERT INTO process_samples (process_id, role, at, rss_bytes, cpu_pct, lag_ms, host_available_bytes) VALUES ($1, $2, now_ms(), $3, $4, $5, $6)',
      [o.id, o.role, mem.rss, cpuPct, stats.lagP99Ms, host.available],
    );
    // Two days of samples for the charts, a week of process records to count restarts.
    await db.query('DELETE FROM process_samples WHERE at < now_ms() - 172800000');
    await db.query('DELETE FROM process_status WHERE seen_at < now_ms() - 604800000');
  };
  const safe = () => run().catch((err) => o.log?.warn({ err: (err as Error).message }, 'health report failed'));
  void safe();
  const timer = setInterval(safe, BEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    loop.disable();
  };
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
  stats: ProcessStats | null;
}

export interface Sample {
  process_id: string;
  role: ProcessRole;
  at: Date;
  rss_bytes: number;
  cpu_pct: number | null;
  lag_ms: number | null;
  host_available_bytes: number | null;
}

export async function samplesSince(q: Queryable, sinceMs: number): Promise<Sample[]> {
  const { rows } = await q.query<Sample>('SELECT * FROM process_samples WHERE at >= $1 ORDER BY at', [Date.now() - sinceMs]);
  return rows;
}

export interface HealthView {
  host: { total: number; available: number; reportedAt: Date } | null;
  running: ProcessRow[];
  /** Processes of each role that stopped in the last 24 hours (restarts, crashes or deploys). */
  restarts: Record<ProcessRole, number>;
  /** Roles that ran in the last 24 hours but have no process reporting now. */
  missing: { role: ProcessRole; lastSeen: Date }[];
}

export async function healthView(q: Queryable): Promise<HealthView> {
  const { rows } = await q.query<ProcessRow>('SELECT * FROM process_status WHERE seen_at > now_ms() - 86400000 ORDER BY role, started_at');
  const now = Date.now();
  const order: Record<string, number> = { web: 0, worker: 1, triage: 2 };
  const running = rows.filter((r) => now - r.seen_at.getTime() < STALE_MS).sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.started_at.getTime() - b.started_at.getTime());
  const restarts: Record<ProcessRole, number> = { web: 0, worker: 0, triage: 0 };
  for (const r of rows) if (now - r.seen_at.getTime() >= STALE_MS && r.role in restarts) restarts[r.role]++;
  const latest = [...rows].filter((r) => r.host_total_bytes).sort((a, b) => b.seen_at.getTime() - a.seen_at.getTime())[0];
  const missing: HealthView['missing'] = [];
  for (const role of ['web', 'worker', 'triage'] as ProcessRole[]) {
    if (running.some((r) => r.role === role)) continue;
    const seen = rows.filter((r) => r.role === role).sort((a, b) => b.seen_at.getTime() - a.seen_at.getTime())[0];
    if (seen) missing.push({ role, lastSeen: seen.seen_at });
  }
  return {
    host: latest ? { total: latest.host_total_bytes!, available: latest.host_available_bytes ?? 0, reportedAt: latest.seen_at } : null,
    running,
    restarts,
    missing,
  };
}

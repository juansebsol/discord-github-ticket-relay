import { drainModerationJobs } from '../moderation/actions.js';
import { runFileCleanup } from './files.js';
import { claimNext } from './submissions.js';
import type { Processor } from './processor.js';
import type { Deps } from './types.js';

/**
 * Background worker. Polls the submissions table for due work (new submissions,
 * scheduled retries, reconciliation checks and rows whose previous worker died), closes what
 * moderators asked to close in bulk, and runs periodic maintenance. Any number of instances
 * can run concurrently.
 */
export class Worker {
  private running = false;
  private loop: Promise<void> | null = null;
  private lastMaintenance = 0;
  private wake: (() => void) | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly processor: Processor,
    private readonly opts: { pollMs?: number; concurrency?: number; maintenanceMs?: number } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** Processes due work until the queue is empty. Exposed for tests. */
  async drain(): Promise<number> {
    let processed = 0;
    for (;;) {
      const sub = await claimNext(this.deps.db, this.deps.instanceId);
      if (!sub) return processed;
      await this.processor.processClaimed(sub);
      processed++;
    }
  }

  private async run(): Promise<void> {
    const concurrency = this.opts.concurrency ?? 2;
    while (this.running) {
      try {
        await Promise.all(Array.from({ length: concurrency }, () => this.drain()));
        // Moderators' bulk closes, one issue at a time, after the tickets waiting to be filed.
        await drainModerationJobs(this.deps);
        if (Date.now() - this.lastMaintenance > (this.opts.maintenanceMs ?? 10 * 60_000)) {
          this.lastMaintenance = Date.now();
          await runMaintenance(this.deps);
          // Daily per workspace, only where an admin turned automatic cleanup on.
          await runFileCleanup(this.deps);
        }
      } catch (err) {
        this.deps.log.error({ err: (err as Error).message }, 'worker loop error');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.pollMs ?? 1000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

/**
 * Housekeeping: expires one-time states and sessions, drops interaction tokens once
 * Discord no longer accepts them, and purges stored ticket text after each workspace's
 * retention period. Unresolved (failed/uncertain) text is kept up to 90 days so admins
 * can still recover it.
 */
export async function runMaintenance(deps: Pick<Deps, 'db' | 'log'>): Promise<void> {
  const { db } = deps;
  await db.query(`DELETE FROM oauth_states WHERE expires_at < now_ms() - 86400000`);
  await db.query(`DELETE FROM sessions WHERE expires_at < now_ms()`);
  await db.query(
    `UPDATE submissions SET interaction_token_enc = NULL WHERE interaction_token_enc IS NOT NULL AND interaction_token_expires_at < now_ms()`,
  );
  const purged = await db.query(
    `UPDATE submissions SET payload_enc = NULL, payload_purged_at = now_ms()
     WHERE payload_enc IS NOT NULL AND (
       (status IN ('created', 'dismissed') AND updated_at < now_ms() - (SELECT retention_days FROM workspaces w WHERE w.id = workspace_id) * 86400000)
       OR (status IN ('failed', 'uncertain') AND updated_at < now_ms() - max((SELECT retention_days FROM workspaces w WHERE w.id = workspace_id), 90) * 86400000)
     )`,
  );
  if (purged.rowCount) deps.log.info({ count: purged.rowCount }, 'purged stored ticket text past retention');
}

import type { TriageEngine } from './engine.js';

/**
 * Background loop for AI triage. Runs in its own process in production (ecosystem.config.cjs),
 * separate from the filing workers, so nothing it does can delay or break filing.
 */
export class TriageWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private indexLoop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private wakeIndex: (() => void) | null = null;

  constructor(
    readonly engine: TriageEngine,
    private readonly opts: { pollMs?: number; indexMs?: number } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.indexLoop = this.runIndex();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    this.wakeIndex?.();
    await Promise.all([this.loop, this.indexLoop]);
  }

  /**
   * Keeps the issue index (used for duplicate search) current in its own loop, so a long first
   * load of a big repository never holds up triage.
   */
  private async runIndex(): Promise<void> {
    while (this.running) {
      try {
        await this.engine.indexer.tick();
      } catch (err) {
        this.engine.deps.log.error({ err: (err as Error).message }, 'issue index loop error');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.indexMs ?? 15_000);
        this.wakeIndex = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /**
   * Queues newly filed tickets and new issues opened on GitHub, and triages everything due.
   * Re-runs only use the time left over: new tickets and issues always go first. Exposed for tests.
   */
  private prunedAt = 0;
  private pauseCheckedAt = 0;
  private knowledgeCheckedAt = 0;

  async drain(): Promise<number> {
    // The activity log keeps 90 days; old entries go once an hour.
    if (Date.now() - this.prunedAt > 3600_000) {
      this.prunedAt = Date.now();
      await this.engine.pruneLog().catch(() => 0);
    }
    // A workspace paused because it ran out of credits carries on by itself once they're added.
    if (Date.now() - this.pauseCheckedAt > 60_000) {
      this.pauseCheckedAt = Date.now();
      await this.engine.checkPaused().catch((err) => this.engine.deps.log.warn({ err: (err as Error).message }, 'pause check failed'));
    }
    // AI triage › Knowledge with Keep up to date on: TRIAGE.md files that are due get queued.
    if (Date.now() - this.knowledgeCheckedAt > 600_000) {
      this.knowledgeCheckedAt = Date.now();
      await this.engine.knowledge.scheduleUpdates().catch((err) => this.engine.deps.log.warn({ err: (err as Error).message }, 'TRIAGE.md schedule failed'));
    }
    await this.engine.enqueueNew();
    let processed = 0;
    for (;;) {
      const row = await this.engine.claim();
      if (row) {
        await this.engine.process(row);
        processed++;
        continue;
      }
      // Then new issues opened on GitHub, then re-runs.
      const issue = await this.engine.claimIssue();
      if (issue) {
        await this.engine.processIssue(issue);
        processed++;
        continue;
      }
      // Then an app's TRIAGE.md (one at a time, so new tickets never wait long).
      const knowledge = await this.engine.knowledge.claim();
      if (knowledge) {
        await this.engine.knowledge.process(knowledge);
        processed++;
        continue;
      }
      // Then bulk Apply someone started, then re-runs.
      const bulk = await this.engine.claimBulkItem();
      if (bulk) {
        await this.engine.processBulkItem(bulk);
        processed++;
        continue;
      }
      const item = await this.engine.claimRunItem();
      if (!item) return processed;
      await this.engine.processRunItem(item);
      processed++;
      // New tickets filed meanwhile come first.
      await this.engine.enqueueNew();
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.drain();
      } catch (err) {
        this.engine.deps.log.error({ err: (err as Error).message }, 'triage loop error');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.pollMs ?? 3000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

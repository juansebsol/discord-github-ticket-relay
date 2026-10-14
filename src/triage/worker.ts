import type { TriageEngine } from './engine.js';

/**
 * Background loop for AI triage. Runs in its own process in production (ecosystem.config.cjs),
 * separate from the filing workers, so nothing it does can delay or break filing.
 */
export class TriageWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    readonly engine: TriageEngine,
    private readonly opts: { pollMs?: number } = {},
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

  /** Queues newly filed tickets and triages everything due. Exposed for tests. */
  async drain(): Promise<number> {
    await this.engine.enqueueNew();
    let processed = 0;
    for (;;) {
      const row = await this.engine.claim();
      if (!row) return processed;
      await this.engine.process(row);
      processed++;
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

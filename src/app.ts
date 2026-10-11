import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/database.js';
import { DiscordClient } from './discord/client.js';
import { Processor } from './domain/processor.js';
import type { Deps, Logger } from './domain/types.js';
import { Worker } from './domain/worker.js';
import { GitHubClient } from './github/client.js';
import { SecretBox } from './lib/crypto.js';
import type { FetchLike } from './lib/http.js';
import { buildServer } from './web/server.js';

export interface AppOptions {
  config: Config;
  db: Db;
  log?: Logger;
  /** Override HTTP for provider APIs (tests use a fake GitHub/Discord). */
  fetch?: FetchLike;
  logger?: boolean | object;
  instanceId?: string;
  githubTimeouts?: { request: number; createIssue: number };
  /** Tickets one worker process files in parallel (default 2). */
  workerConcurrency?: number;
}

export interface AppInstance {
  server: FastifyInstance;
  deps: Deps;
  processor: Processor;
  worker: Worker;
}

export async function createApp(opts: AppOptions): Promise<AppInstance> {
  const { config } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  const deps: Deps = {
    config,
    db: opts.db,
    box: new SecretBox(config.encryptionKey),
    github: config.github ? new GitHubClient(config.github, fetchImpl, opts.githubTimeouts) : null,
    discord: config.discord ? new DiscordClient(config.discord, fetchImpl) : null,
    log: opts.log ?? { info() {}, warn() {}, error() {} },
    instanceId: opts.instanceId ?? `${process.pid}-${randomUUID().slice(0, 8)}`,
  };
  const processor = new Processor(deps);
  const server = await buildServer(deps, processor, { logger: opts.logger });
  if (!opts.log && opts.logger) deps.log = server.log;
  const worker = new Worker(deps, processor, { concurrency: opts.workerConcurrency });
  return { server, deps, processor, worker };
}

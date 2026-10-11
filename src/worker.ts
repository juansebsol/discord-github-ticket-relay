import { existsSync } from 'node:fs';
import pino from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { loggerOptions } from './logging.js';

/** Standalone worker process (optional): run when web instances use RUN_WORKER=false. */
if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const log = pino(loggerOptions(config.nodeEnv));
const db = createPool(config.databaseUrl, 5);
await migrate(db, (m) => log.info(m));
const { worker } = await createApp({ config, db, log });
worker.start();
log.info('worker started');

async function shutdown() {
  await worker.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

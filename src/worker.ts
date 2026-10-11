import pino from 'pino';
import { createApp } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { migrate } from './db/migrate.js';
import { openDatabase } from './db/database.js';
import { loggerOptions } from './logging.js';

/**
 * Standalone worker process: files queued tickets, retries, reconciles and runs
 * housekeeping. Run any number of these next to a web process started with RUN_WORKER=false.
 */
loadDotEnv();
let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
const log = pino(loggerOptions(config.nodeEnv));
const db = openDatabase(config.databasePath);
await migrate(db, (m) => log.info(m));
const { worker } = await createApp({ config, db, log, workerConcurrency: Number(process.env.WORKER_CONCURRENCY) || undefined });
worker.start();
log.info('worker started');

async function shutdown() {
  await worker.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

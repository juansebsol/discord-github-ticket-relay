import pino from 'pino';
import { createApp } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { migrate } from './db/migrate.js';
import { openDatabase } from './db/database.js';
import { githubStats, startHeartbeat } from './domain/health.js';
import { loggerOptions } from './logging.js';

/**
 * Standalone AI triage process. Triages tickets that are already filed; it never touches
 * the filing queue, so stopping it, or Claude being unavailable, can't affect filing.
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
const { triage, deps } = await createApp({ config, db, log });
triage.start();
const stopHeartbeat = startHeartbeat(db, { id: deps.instanceId, role: 'triage', extra: () => githubStats(deps), log });
log.info('triage worker started');

async function shutdown() {
  stopHeartbeat();
  await triage.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

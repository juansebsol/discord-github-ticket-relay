import { createApp } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { migrate } from './db/migrate.js';
import { openDatabase } from './db/database.js';
import { startHeartbeat } from './domain/health.js';
import { loggerOptions } from './logging.js';

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

const db = openDatabase(config.databasePath);
const { server, worker, triage, deps } = await createApp({ config, db, logger: loggerOptions(config.nodeEnv) });

if (process.env.AUTO_MIGRATE !== 'false') await migrate(db, (m) => server.log.info(m));
if (config.missing.discord.length) server.log.warn({ missing: config.missing.discord }, 'Discord credentials incomplete; sign-in and the bot are disabled');
if (config.missing.github.length) server.log.warn({ missing: config.missing.github }, 'GitHub App credentials incomplete; GitHub connection is disabled');

await server.listen({ host: config.host, port: config.port });
const stopHeartbeat = startHeartbeat(db, { id: deps.instanceId, role: 'web', log: server.log });
if (config.runWorker) {
  worker.start();
  server.log.info('background worker started');
}
if (config.runTriage) {
  triage.start();
  server.log.info('triage worker started');
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  server.log.info({ signal }, 'shutting down');
  stopHeartbeat();
  await server.close();
  await worker.stop();
  await triage.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

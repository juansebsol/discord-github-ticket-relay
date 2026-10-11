import { migrate } from './migrate.js';
import { openDatabase } from './database.js';
import { ConfigError, loadConfig, loadDotEnv } from '../config.js';

loadDotEnv();
let databasePath: string;
try {
  databasePath = loadConfig().databasePath;
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}
const db = openDatabase(databasePath);
try {
  const applied = await migrate(db, (m) => console.log(m));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} finally {
  await db.end();
}

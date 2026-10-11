import { existsSync } from 'node:fs';
import { migrate } from './migrate.js';
import { openDatabase } from './database.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const db = openDatabase(process.env.DATABASE_PATH ?? './data/ticket-relay.db');
try {
  const applied = await migrate(db, (m) => console.log(m));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} finally {
  await db.end();
}

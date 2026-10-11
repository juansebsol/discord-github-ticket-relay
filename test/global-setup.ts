import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';

export const TEST_DATABASE_PATH = process.env.TEST_DATABASE_PATH ?? path.join(tmpdir(), 'ticket-relay-test.db');

/** Creates a fresh SQLite test database once per test run. */
export default async function setup() {
  for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DATABASE_PATH + suffix, { force: true });
  const db = openDatabase(TEST_DATABASE_PATH);
  await migrate(db);
  await db.end();
}

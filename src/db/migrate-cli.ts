import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const db = createPool(url, 1);
try {
  const applied = await migrate(db, (m) => console.log(m));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
} finally {
  await db.end();
}

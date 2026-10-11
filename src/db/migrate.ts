import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './database.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Applies pending SQL migrations in filename order. Safe when several processes start at
 * once: the whole run happens inside one write transaction (BEGIN IMMEDIATE).
 */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const scripts = await Promise.all(files.map(async (f) => [f, await readFile(path.join(MIGRATIONS_DIR, f), 'utf8')] as const));
  return db.transaction(async (tx) => {
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (now_ms()))');
    const done = new Set((await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const [file, sql] of scripts) {
      if (done.has(file)) continue;
      db.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
      log(`applied migration ${file}`);
    }
    return applied;
  });
}

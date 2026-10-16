import { mkdirSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

/**
 * SQLite access with a small async, Postgres-like surface (`query` → `{ rows, rowCount }`).
 *
 * Conventions applied in both directions so domain code works with natural JS values:
 * - parameters: `$1`-style placeholders; Date → epoch ms, boolean → 0/1, arrays/objects → JSON
 * - results: `*_at` / `at` columns → Date, `labels` / `warnings` / `data` / `detail` and the
 *   triage JSON columns → parsed JSON, `enabled` / `repo_private` → boolean
 *
 * Concurrency: one connection per process. Writers in other processes are serialized by
 * SQLite itself (WAL mode, busy timeout). Inside this process, transactions hold a mutex so
 * no other statement can run on the shared connection while one is open.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

const DATE_COLUMN = /(^|_)at$/;
const JSON_COLUMNS = new Set(['labels', 'warnings', 'data', 'detail', 'triage_config', 'verdict', 'applied_actions', 'suggestions', 'form', 'last_run_summary', 'stats', 'auto_actions', 'before', 'scope', 'config_used', 'filter', 'access']);
const BOOLEAN_COLUMNS = new Set(['enabled', 'repo_private', 'contributor_enabled', 'auto_cleanup', 'closed_enabled', 'spam_enabled', 'age_enabled', 'apply_suggestions', 'apply_inbox_only', 'github_enabled']);

function toParam(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function fromRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue;
    if (typeof value === 'number' && DATE_COLUMN.test(key)) row[key] = new Date(value);
    else if (typeof value === 'string' && JSON_COLUMNS.has(key)) row[key] = JSON.parse(value);
    else if (typeof value === 'number' && BOOLEAN_COLUMNS.has(key)) row[key] = value === 1;
  }
  return row;
}

class Executor implements Queryable {
  private readonly statements = new Map<string, BetterSqlite3.Statement>();

  constructor(protected readonly conn: BetterSqlite3.Database) {}

  run<T>(sql: string, params: unknown[] = []): QueryResult<T> {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      // `$1` placeholders become named parameters (`@p1`), so one value can be used twice.
      stmt = this.conn.prepare(sql.replace(/\$(\d+)/g, '@p$1'));
      this.statements.set(sql, stmt);
    }
    const bound: unknown[] = [];
    if (params.length) bound.push(Object.fromEntries(params.map((v, i) => [`p${i + 1}`, toParam(v)])));
    if (stmt.reader) {
      const rows = (stmt.all(...bound) as Record<string, unknown>[]).map(fromRow) as T[];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: stmt.run(...bound).changes };
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.run<T>(sql, params);
  }
}

export class Db extends Executor {
  private lock: Promise<void> = Promise.resolve();
  private locked = false;

  constructor(readonly file: string) {
    super(Db.connect(file));
  }

  private static connect(file: string): BetterSqlite3.Database {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const conn = new BetterSqlite3(file);
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');
    conn.pragma('foreign_keys = ON');
    conn.pragma('synchronous = NORMAL');
    conn.function('now_ms', { deterministic: false }, () => Date.now());
    return conn;
  }

  override async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    while (this.locked) await this.lock;
    return this.run<T>(sql, params);
  }

  /** Executes a multi-statement script (migrations). */
  exec(sql: string): void {
    this.conn.exec(sql);
  }

  /**
   * Runs `fn` in a write transaction (BEGIN IMMEDIATE takes SQLite's write lock up front, so
   * the transaction is serialized against every other process using the file).
   */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    while (this.locked) await this.lock;
    this.locked = true;
    let release!: () => void;
    this.lock = new Promise((resolve) => (release = resolve));
    const tx = new Executor(this.conn);
    try {
      this.conn.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(tx);
        this.conn.exec('COMMIT');
        return result;
      } catch (err) {
        this.conn.exec('ROLLBACK');
        throw err;
      }
    } finally {
      this.locked = false;
      release();
    }
  }

  async end(): Promise<void> {
    while (this.locked) await this.lock;
    this.conn.close();
  }
}

export function openDatabase(file: string): Db {
  return new Db(file);
}

export function withTransaction<T>(db: Db, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** SQLite constraint violation for a UNIQUE index. */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

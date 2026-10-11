import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

// Return bigint columns (installation and repository IDs) as numbers. GitHub IDs fit
// comfortably within Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (value) => Number(value));

export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

import pg from 'pg';
import type { Config } from '../config.js';

const { Pool } = pg;

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(config: Config): Db {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });

  pool.on('error', (error) => {
    // Do not crash the process on idle client errors.
    console.error('Unexpected PostgreSQL pool error', error);
  });

  return pool;
}

export async function pingDb(db: Db): Promise<void> {
  await db.query('SELECT 1');
}

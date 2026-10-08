import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the root database or an open transaction. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

// Return int8 (bigint) and numeric as JS numbers: counts and sizes in this system stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export function createDatabase(connectionString: string, options: { max?: number; applicationName?: string } = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'projecthub',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // A broken idle connection must not crash the process; the pool replaces it.
  pool.on('error', () => undefined);
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

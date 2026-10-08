import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { seedReferenceData } from './seed.js';

export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const LOCK_KEY = 7_420_310_018; // arbitrary constant shared by every Project Hub process

/**
 * Applies pending SQL migrations in order and then idempotently syncs reference data.
 * A session advisory lock serialises concurrent callers (API, worker, CLI starting together).
 */
export async function migrateDatabase(db: Database): Promise<void> {
  const version = await db.execute<{ server_version_num: string }>(sql`SHOW server_version_num`);
  const num = Number(version.rows[0]?.server_version_num ?? 0);
  if (num < 180000) {
    throw new Error(`Project Hub requires PostgreSQL 18 or newer (found server_version_num=${num}).`);
  }
  const enc = await db.execute<{ encoding: string }>(
    sql`SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()`,
  );
  if (enc.rows[0]?.encoding !== 'UTF8') {
    throw new Error(
      `Project Hub requires a UTF8 database (found ${enc.rows[0]?.encoding}). Create it with: CREATE DATABASE ... ENCODING 'UTF8' TEMPLATE template0`,
    );
  }
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await seedReferenceData(db);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}

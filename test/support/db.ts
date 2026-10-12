import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createDatabase, migrateDatabase, type DatabaseHandle } from '@projecthub/database';

const root = path.resolve(import.meta.dirname, '../..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://projecthub:projecthub-dev@127.0.0.1:54329/projecthub_test';

if (!/_test\b/.test(new URL(TEST_DATABASE_URL).pathname)) {
  throw new Error('Refusing to run tests against a database whose name does not end with _test');
}

/** Drops everything in the test database and applies all migrations from scratch. */
export async function freshDatabase(): Promise<DatabaseHandle> {
  // The integration files share one disposable database. Hold a session-level lock for the complete
  // harness lifetime so another Vitest process cannot drop the schema underneath a running worker.
  const guard = new pg.Client({ connectionString: TEST_DATABASE_URL, application_name: 'projecthub-test-guard' });
  await guard.connect();
  await guard.query('SELECT pg_advisory_lock($1, $2)', [0x50524f4a, 0x485542]);
  try {
    await guard.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
    const handle = createDatabase(TEST_DATABASE_URL, { max: 10, applicationName: 'projecthub-test' });
    try {
      await migrateDatabase(handle.db);
    } catch (error) {
      await handle.close();
      throw error;
    }
    let closed = false;
    return {
      ...handle,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await handle.close();
        } finally {
          await guard.query('SELECT pg_advisory_unlock($1, $2)', [0x50524f4a, 0x485542]).catch(() => undefined);
          await guard.end();
        }
      },
    };
  } catch (error) {
    await guard.query('SELECT pg_advisory_unlock($1, $2)', [0x50524f4a, 0x485542]).catch(() => undefined);
    await guard.end();
    throw error;
  }
}

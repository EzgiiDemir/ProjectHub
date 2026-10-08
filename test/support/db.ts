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
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await c.end();
  const handle = createDatabase(TEST_DATABASE_URL, { max: 10, applicationName: 'projecthub-test' });
  await migrateDatabase(handle.db);
  return handle;
}

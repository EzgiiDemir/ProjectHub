#!/usr/bin/env node
import { createDatabase, migrateDatabase } from '@projecthub/database';
import { findWorkspaceRoot } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

// Runs pending migrations + reference data sync. Usage: pnpm db:migrate [--url <postgres-url>]
const root = findWorkspaceRoot(process.cwd());
if (fs.existsSync(path.join(root, '.env')) && process.env.NODE_ENV !== 'production') process.loadEnvFile(path.join(root, '.env'));
const urlArg = process.argv.indexOf('--url');
const url = urlArg > -1 ? process.argv[urlArg + 1] : process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const handle = createDatabase(url, { max: 2, applicationName: 'projecthub-migrate' });
try {
  await migrateDatabase(handle.db);
  console.log('Database is up to date.');
} catch (e) {
  console.error(`Migration failed: ${(e as Error).message}`, (e as { cause?: unknown }).cause ?? "");
  process.exitCode = 1;
} finally {
  await handle.close();
}

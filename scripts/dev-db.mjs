// Starts a self-contained PostgreSQL 18 server for local development (data persists in .data/postgres).
// Production uses a regular PostgreSQL 18 server (see docker-compose.yml); point DATABASE_URL at it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const url = new URL(process.env.DATABASE_URL ?? 'postgres://projecthub:projecthub-dev@127.0.0.1:54329/projecthub');
const dataDir = path.join(root, '.data', 'postgres');
const port = Number(url.port || 5432);
const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const database = url.pathname.slice(1);

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  // UTF-8 cluster with PostgreSQL's builtin C.UTF-8 locale: identical behaviour on Windows, macOS and Linux.
  initdbFlags: ['--encoding=UTF8', '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'],
  onLog: (m) => process.env.DEV_DB_VERBOSE && console.log(String(m).trim()),
  onError: (e) => console.error(String(e).trim()),
});

if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
  console.log(`Initialising PostgreSQL cluster in ${dataDir}`);
  await server.initialise();
}
await server.start();

const admin = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
await admin.connect();
for (const db of [database, `${database}_test`]) {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${db.replace(/"/g, '""')}" TEMPLATE template0 ENCODING 'UTF8'`);
    console.log(`Created database ${db}`);
  }
}
const v = await admin.query('SHOW server_version');
await admin.end();
console.log(`PostgreSQL ${v.rows[0].server_version} ready on 127.0.0.1:${port} (databases: ${database}, ${database}_test). Ctrl+C to stop.`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => undefined, 1 << 30);

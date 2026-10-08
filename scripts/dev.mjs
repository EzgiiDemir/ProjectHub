// Development runner: compiles the server packages in watch mode and runs API, worker and web together.
// Prerequisite: PostgreSQL reachable at DATABASE_URL (pnpm db:start provides a local one).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const colors = { tsc: 36, api: 32, worker: 35, web: 34 };
const children = [];

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, shell: isWin, env: { ...process.env, FORCE_COLOR: '1' }, ...opts });
  const prefix = `\x1b[${colors[name]}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  children.push(child);
  return child;
}

console.log('Building server packages…');
const build = spawnSync('npx', ['tsc', '-b', 'tsconfig.json'], { cwd: root, shell: isWin, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

run('tsc', 'npx', ['tsc', '-b', 'tsconfig.json', '--watch', '--preserveWatchOutput']);
run('api', 'node', ['--watch-path=apps/api/dist', '--watch-path=packages/core/dist', '--watch-path=packages/database/dist', 'apps/api/dist/main.js']);
run('worker', 'node', ['--watch-path=apps/worker/dist', '--watch-path=packages/core/dist', '--watch-path=packages/database/dist', 'apps/worker/dist/main.js']);
run('web', 'corepack', ['pnpm', '--filter', '@projecthub/web', 'run', 'dev']);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapter, type ReleaseRef, type TargetRow } from '../src/deploy/adapters.js';
import { startSftpServer } from './support/sftp-server.js';

let tmp: string;
let remoteRoot: string;
let server: Awaited<ReturnType<typeof startSftpServer>>;
const log: string[] = [];
const push = (l: string) => log.push(l);

async function release(name: string, version: string) {
  const dir = path.join(tmp, name);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), `<h1>${version}</h1>`);
  await fs.writeFile(path.join(dir, 'assets', 'app.js'), `console.log('${version}')`);
  return dir;
}

const target = (over: Partial<TargetRow> = {}): TargetRow =>
  ({
    id: 't',
    environmentId: 'e',
    adapter: 'ssh',
    host: '127.0.0.1',
    port: server.port,
    username: 'deploy',
    remotePath: '/srv/site',
    credentialSecretId: null,
    configuration: { keepReleases: 1, credentialType: 'password' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as TargetRow;

const read = (p: string) => fs.readFile(path.join(remoteRoot, ...p.split('/').filter(Boolean)), 'utf8');
const listRemote = async (dir: string) => (await fs.readdir(path.join(remoteRoot, dir))).sort();

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-adapter-'));
  remoteRoot = path.join(tmp, 'remote');
  await fs.mkdir(remoteRoot);
  server = await startSftpServer(remoteRoot, { username: 'deploy', password: 'S3cret-pass' });
});
afterAll(async () => {
  await server?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('SFTP / SSH deployment adapter (real SSH server)', () => {
  it('rejects bad credentials', async () => {
    const a = createAdapter(target(), 'wrong');
    await expect(a.test()).rejects.toThrow();
    await a.close();
  });

  it('tests, deploys with an atomic swap, rolls back, prunes and runs remote commands', async () => {
    const a = createAdapter(target(), 'S3cret-pass');
    try {
      expect(await a.test()).toContain('SFTP bağlantısı başarılı');
      expect(await listRemote('srv')).toEqual([]); // probe directory cleaned up

      const r1 = await a.deploy(await release('v1', 'v1'), 'r1', push);
      expect(r1.previousPath).toBeNull();
      expect(await read('/srv/site/index.html')).toBe('<h1>v1</h1>');
      expect(await read('/srv/site/assets/app.js')).toContain('v1');

      const r2: ReleaseRef = await a.deploy(await release('v2', 'v2'), 'r2', push);
      expect(r2.previousPath).toBe('/srv/site.__ph_prev_r2');
      expect(await read('/srv/site/index.html')).toBe('<h1>v2</h1>');
      expect(await read('/srv/site.__ph_prev_r2/index.html')).toBe('<h1>v1</h1>');

      // Health check failed → restore the previous release.
      await a.rollback(r2, push);
      expect(await read('/srv/site/index.html')).toBe('<h1>v1</h1>');
      expect(await listRemote('srv')).toEqual(['site', 'site.__ph_failed_r2']);

      // Next deploy prunes failed releases and keeps only `keepReleases` previous ones.
      await a.deploy(await release('v3', 'v3'), 'r3', push);
      await a.deploy(await release('v4', 'v4'), 'r4', push);
      expect(await read('/srv/site/index.html')).toBe('<h1>v4</h1>');
      expect(await listRemote('srv')).toEqual(['site', 'site.__ph_prev_r4']);

      // SSH: post-deploy command runs inside the live directory.
      const lines: string[] = [];
      const code = await a.exec!(`node -e "require('fs').writeFileSync('post-deploy.txt','ok');console.log('done')"`, (l) => lines.push(l));
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('done');
      expect(await read('/srv/site/post-deploy.txt')).toBe('ok');
      expect(server.commands[0]).toMatch(/^cd '\/srv\/site' && node -e/);
      expect(await a.exec!('node -e "process.exit(3)"', () => undefined)).toBe(3);
    } finally {
      await a.close();
    }
  }, 60_000);
});

describe('FTP deployment adapter (real FTP server)', () => {
  let ftp: { close: () => Promise<unknown> } | null = null;
  let ftpRoot: string;
  let port: number;

  beforeAll(async () => {
    const { default: FtpSrv } = await import('ftp-srv');
    ftpRoot = path.join(tmp, 'ftp-root');
    await fs.mkdir(ftpRoot);
    // Bind port 0 (no pick-then-bind race) and a randomized passive range so parallel runs never collide.
    const pasvMin = 42000 + Math.floor(Math.random() * 18000);
    const srv = new FtpSrv({ url: 'ftp://127.0.0.1:0', pasv_url: '127.0.0.1', pasv_min: pasvMin, pasv_max: pasvMin + 200, anonymous: false, greeting: 'test', log: quietLogger() as never });
    srv.on('login', ({ username, password }: { username: string; password: string }, resolve: (o: { root: string }) => void, reject: (e: Error) => void) =>
      username === 'ftpuser' && password === 'Ftp-pass-1' ? resolve({ root: ftpRoot }) : reject(new Error('bad login')),
    );
    await srv.listen();
    port = ((srv as unknown as { server: import('node:net').Server }).server.address() as import('node:net').AddressInfo).port;
    ftp = srv;
  });
  afterAll(async () => {
    await ftp?.close();
  });

  it('deploys, swaps, rolls back and prunes over FTP', async () => {
    const t = target({ adapter: 'ftp', port, username: 'ftpuser', remotePath: '/www/site', configuration: { keepReleases: 1, secure: false } });
    const bad = createAdapter(t, 'nope');
    await expect(bad.test()).rejects.toThrow();
    await bad.close();

    const a = createAdapter(t, 'Ftp-pass-1');
    const readFtp = (p: string) => fs.readFile(path.join(ftpRoot, ...p.split('/').filter(Boolean)), 'utf8');
    try {
      expect(await a.test()).toContain('FTP bağlantısı başarılı');
      await a.deploy(await release('f1', 'f1'), 'f1', push);
      expect(await readFtp('/www/site/index.html')).toBe('<h1>f1</h1>');
      expect(await readFtp('/www/site/assets/app.js')).toContain('f1');
      const r2 = await a.deploy(await release('f2', 'f2'), 'f2', push);
      expect(r2.previousPath).toBe('/www/site.__ph_prev_f2');
      expect(await readFtp('/www/site/index.html')).toBe('<h1>f2</h1>');
      await a.rollback(r2, push);
      expect(await readFtp('/www/site/index.html')).toBe('<h1>f1</h1>');
      await a.deploy(await release('f3', 'f3'), 'f3', push);
      expect((await fs.readdir(path.join(ftpRoot, 'www'))).sort()).toEqual(['site', 'site.__ph_prev_f3']);
    } finally {
      await a.close();
    }
  }, 60_000);
});

/** ftp-srv logs through a bunyan-style logger; expected failures (bad login, probes) would only add noise. */
function quietLogger(): Record<string, unknown> {
  const noop = () => undefined;
  const l: Record<string, unknown> = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  l.child = () => l;
  return l;
}

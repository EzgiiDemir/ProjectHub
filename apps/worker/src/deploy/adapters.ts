import fs from 'node:fs/promises';
import path from 'node:path';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import type { deploymentTargets } from '@projecthub/database';

export type TargetRow = typeof deploymentTargets.$inferSelect;

export interface ReleaseRef {
  /** Identifier of this release (suffix used for staging / previous directories). */
  releaseId: string;
  /** Remote path where the previously live release was moved (null on first deployment). */
  previousPath: string | null;
}

export interface DeployAdapterImpl {
  /** Connectivity + write-permission check. Returns a human readable summary. */
  test(): Promise<string>;
  /** Uploads `sourceDir`, then swaps it in as the live release. */
  deploy(sourceDir: string, releaseId: string, log: (l: string) => void): Promise<ReleaseRef>;
  /** Restores the previous release recorded by deploy(). */
  rollback(ref: ReleaseRef, log: (l: string) => void): Promise<void>;
  /** Runs a remote shell command (SSH adapter only). */
  exec?(command: string, log: (l: string) => void): Promise<number>;
  close(): Promise<void>;
}

const posix = path.posix;

/**
 * Release layout on the target (same for every adapter):
 *   <remotePath>                       live release
 *   <remotePath>.__ph_<id>             upload staging (renamed to live on success)
 *   <remotePath>.__ph_prev_<id>        previous live release (rollback source; last N kept)
 * The swap is two renames, so the live directory is never half-uploaded.
 */
function layout(remotePath: string, releaseId: string) {
  const clean = remotePath.replace(/[\\/]+$/, '');
  return {
    live: clean,
    staging: `${clean}.__ph_${releaseId}`,
    previous: `${clean}.__ph_prev_${releaseId}`,
    failed: `${clean}.__ph_failed_${releaseId}`,
    parent: clean.includes('\\') && !clean.includes('/') ? path.win32.dirname(clean) : posix.dirname(clean) || '.',
    base: clean.split(/[\\/]/).pop()!,
  };
}

/* ------------------------------------------------------------------ local */

export class LocalAdapter implements DeployAdapterImpl {
  constructor(private readonly target: TargetRow) {}

  async test() {
    const l = layout(this.target.remotePath, 'test');
    await fs.mkdir(path.dirname(l.live), { recursive: true });
    const probe = `${l.live}.__ph_probe`;
    await fs.mkdir(probe, { recursive: true });
    await fs.rm(probe, { recursive: true, force: true });
    return `Yerel klasör yazılabilir: ${path.dirname(l.live)}`;
  }

  async deploy(sourceDir: string, releaseId: string, log: (l: string) => void): Promise<ReleaseRef> {
    const l = layout(this.target.remotePath, releaseId);
    await fs.mkdir(path.dirname(l.live), { recursive: true });
    await fs.rm(l.staging, { recursive: true, force: true });
    log(`Kopyalanıyor → ${l.staging}`);
    await fs.cp(sourceDir, l.staging, { recursive: true });
    let previousPath: string | null = null;
    if (await exists(l.live)) {
      await fs.rename(l.live, l.previous);
      previousPath = l.previous;
      log(`Önceki sürüm saklandı → ${l.previous}`);
    }
    await fs.rename(l.staging, l.live);
    log(`Yeni sürüm yayında → ${l.live}`);
    await this.prune(l, log);
    return { releaseId, previousPath };
  }

  async rollback(ref: ReleaseRef, log: (l: string) => void) {
    const l = layout(this.target.remotePath, ref.releaseId);
    if (await exists(l.live)) await fs.rename(l.live, l.failed);
    if (ref.previousPath && (await exists(ref.previousPath))) {
      await fs.rename(ref.previousPath, l.live);
      log(`Önceki sürüm geri yüklendi (${ref.previousPath})`);
    } else log('Geri yüklenecek önceki sürüm yok; canlı klasör kaldırıldı');
  }

  private async prune(l: ReturnType<typeof layout>, log: (s: string) => void) {
    const keep = this.target.configuration.keepReleases ?? 3;
    const entries = (await fs.readdir(path.dirname(l.live))).filter((e) => e.startsWith(`${l.base}.__ph_prev_`) || e.startsWith(`${l.base}.__ph_failed_`)).sort();
    const prevs = entries.filter((e) => e.includes('__ph_prev_'));
    const remove = [...prevs.slice(0, Math.max(0, prevs.length - keep)), ...entries.filter((e) => e.includes('__ph_failed_'))];
    for (const e of remove) {
      await fs.rm(path.join(path.dirname(l.live), e), { recursive: true, force: true });
      log(`Eski sürüm temizlendi: ${e}`);
    }
  }

  async close() {}
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ SFTP / SSH */

export class SftpAdapter implements DeployAdapterImpl {
  private client = new SftpClient('projecthub');
  private connected = false;

  constructor(
    private readonly target: TargetRow,
    private readonly credential: string | null,
  ) {}

  private async connect() {
    if (this.connected) return;
    const isKey = this.target.configuration.credentialType === 'private_key';
    await this.client.connect({
      host: this.target.host,
      port: this.target.port ?? 22,
      username: this.target.username,
      ...(isKey ? { privateKey: this.credential ?? undefined } : { password: this.credential ?? undefined }),
      readyTimeout: 20_000,
      retries: 1,
    });
    this.connected = true;
  }

  async test() {
    await this.connect();
    const l = layout(this.target.remotePath, 'test');
    const probe = `${l.live}.__ph_probe`;
    if (!(await this.client.exists(l.parent))) await this.client.mkdir(l.parent, true);
    await this.client.mkdir(probe, true);
    await this.client.rmdir(probe, true);
    return `SFTP bağlantısı başarılı, ${l.parent} yazılabilir`;
  }

  async deploy(sourceDir: string, releaseId: string, log: (l: string) => void): Promise<ReleaseRef> {
    await this.connect();
    const l = layout(this.target.remotePath, releaseId);
    if (!(await this.client.exists(l.parent))) await this.client.mkdir(l.parent, true);
    if (await this.client.exists(l.staging)) await this.client.rmdir(l.staging, true);
    log(`Yükleniyor → ${this.target.host}:${l.staging}`);
    let files = 0;
    this.client.on('upload', () => {
      files++;
      if (files % 50 === 0) log(`${files} dosya yüklendi…`);
    });
    await this.client.uploadDir(sourceDir, l.staging);
    log(`${files} dosya yüklendi`);
    let previousPath: string | null = null;
    if (await this.client.exists(l.live)) {
      await this.client.rename(l.live, l.previous);
      previousPath = l.previous;
      log(`Önceki sürüm saklandı → ${l.previous}`);
    }
    await this.client.rename(l.staging, l.live);
    log(`Yeni sürüm yayında → ${l.live}`);
    await this.prune(l, log);
    return { releaseId, previousPath };
  }

  async rollback(ref: ReleaseRef, log: (l: string) => void) {
    await this.connect();
    const l = layout(this.target.remotePath, ref.releaseId);
    if (await this.client.exists(l.live)) await this.client.rename(l.live, l.failed);
    if (ref.previousPath && (await this.client.exists(ref.previousPath))) {
      await this.client.rename(ref.previousPath, l.live);
      log(`Önceki sürüm geri yüklendi (${ref.previousPath})`);
    } else log('Geri yüklenecek önceki sürüm yok');
  }

  private async prune(l: ReturnType<typeof layout>, log: (s: string) => void) {
    const keep = this.target.configuration.keepReleases ?? 3;
    const list = (await this.client.list(l.parent)).map((e) => e.name).filter((n) => n.startsWith(`${l.base}.__ph_prev_`) || n.startsWith(`${l.base}.__ph_failed_`)).sort();
    const prevs = list.filter((n) => n.includes('__ph_prev_'));
    for (const n of [...prevs.slice(0, Math.max(0, prevs.length - keep)), ...list.filter((x) => x.includes('__ph_failed_'))]) {
      await this.client.rmdir(posix.join(l.parent, n), true);
      log(`Eski sürüm temizlendi: ${n}`);
    }
  }

  /** SSH adapter: run the post-deploy command inside the live directory. */
  async exec(command: string, log: (l: string) => void): Promise<number> {
    await this.connect();
    const live = layout(this.target.remotePath, 'x').live;
    const ssh = (this.client as unknown as { client: import('ssh2').Client }).client;
    return new Promise((resolve, reject) => {
      ssh.exec(`cd ${shellQuote(live)} && ${command}`, (err, stream) => {
        if (err) return reject(err);
        stream.on('data', (d: Buffer) => log(d.toString('utf8').trimEnd()));
        stream.stderr.on('data', (d: Buffer) => log(d.toString('utf8').trimEnd()));
        stream.on('close', (code: number | null) => resolve(code ?? 1));
      });
    });
  }

  async close() {
    if (this.connected) await this.client.end().catch(() => undefined);
  }
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ FTP / FTPS (legacy) */

export class FtpAdapter implements DeployAdapterImpl {
  private client = new FtpClient(60_000);
  private connected = false;

  constructor(
    private readonly target: TargetRow,
    private readonly credential: string | null,
  ) {}

  private async connect() {
    if (this.connected) return;
    await this.client.access({
      host: this.target.host,
      port: this.target.port ?? 21,
      user: this.target.username,
      password: this.credential ?? undefined,
      secure: this.target.configuration.secure ?? false,
    });
    this.connected = true;
  }

  private async exists(p: string) {
    try {
      await this.client.cd(p);
      await this.client.cd('/');
      return true;
    } catch {
      return false;
    }
  }

  async test() {
    await this.connect();
    const l = layout(this.target.remotePath, 'test');
    await this.client.ensureDir(`${l.live}.__ph_probe`);
    await this.client.cd('/');
    await this.client.removeDir(`${l.live}.__ph_probe`);
    return `FTP${this.target.configuration.secure ? 'S' : ''} bağlantısı başarılı, ${l.parent} yazılabilir`;
  }

  async deploy(sourceDir: string, releaseId: string, log: (l: string) => void): Promise<ReleaseRef> {
    await this.connect();
    const l = layout(this.target.remotePath, releaseId);
    log(`Yükleniyor → ftp://${this.target.host}${l.staging}`);
    await this.client.ensureDir(l.staging);
    await this.client.cd('/');
    await this.client.uploadFromDir(sourceDir, l.staging);
    let previousPath: string | null = null;
    if (await this.exists(l.live)) {
      await this.client.rename(l.live, l.previous);
      previousPath = l.previous;
      log(`Önceki sürüm saklandı → ${l.previous}`);
    }
    await this.client.rename(l.staging, l.live);
    log(`Yeni sürüm yayında → ${l.live}`);
    const keep = this.target.configuration.keepReleases ?? 3;
    const list = (await this.client.list(l.parent)).map((e) => e.name).filter((n) => n.startsWith(`${l.base}.__ph_prev_`)).sort();
    for (const n of list.slice(0, Math.max(0, list.length - keep))) {
      await this.client.removeDir(posix.join(l.parent, n));
      log(`Eski sürüm temizlendi: ${n}`);
    }
    return { releaseId, previousPath };
  }

  async rollback(ref: ReleaseRef, log: (l: string) => void) {
    await this.connect();
    const l = layout(this.target.remotePath, ref.releaseId);
    if (await this.exists(l.live)) await this.client.rename(l.live, l.failed);
    if (ref.previousPath && (await this.exists(ref.previousPath))) {
      await this.client.rename(ref.previousPath, l.live);
      log(`Önceki sürüm geri yüklendi (${ref.previousPath})`);
    }
  }

  async close() {
    this.client.close();
  }
}

export function createAdapter(target: TargetRow, credential: string | null): DeployAdapterImpl {
  switch (target.adapter) {
    case 'local':
      return new LocalAdapter(target);
    case 'sftp':
    case 'ssh':
      return new SftpAdapter(target, credential);
    case 'ftp':
      return new FtpAdapter(target, credential);
  }
}

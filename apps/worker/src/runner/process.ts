import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

/** Host variables required to locate runtimes. Everything else must be passed explicitly for the project. */
const SAFE_HOST_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']);

export function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (SAFE_HOST_ENV.has(k.toUpperCase()) && v !== undefined) env[k] = v;
  return { ...env, CI: 'true', PROJECTHUB: 'true', FORCE_COLOR: '0', NO_COLOR: '1', ...extra };
}

/** Replaces $PORT / ${PORT} so commands work the same in cmd.exe and sh. */
export function expandPort(command: string, port: number): string {
  return command.replace(/\$\{PORT\}|\$PORT\b|%PORT%/g, String(port));
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export function killTree(child: ChildProcess | number): void {
  const pid = typeof child === 'number' ? child : child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

/** Runs a shell command, streaming combined output to `onOutput`. Kills the whole process tree on timeout/cancel. */
export function runCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput: (text: string) => void;
  isCancelled?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const poll = opts.isCancelled
      ? setInterval(async () => {
          if (await opts.isCancelled!().catch(() => false)) {
            cancelled = true;
            killTree(child);
          }
        }, 2_000)
      : null;
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.on('error', (e) => opts.onOutput(`\n[projecthub] komut başlatılamadı: ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, timedOut, cancelled, durationMs: Date.now() - started });
    });
  });
}

export interface ContainerLimits {
  image: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Dependency installation may use the default bridge; build and test steps use `none`. */
  network: 'bridge' | 'none';
}

/**
 * Runs a trusted project's command in an ephemeral, non-root Linux container. The project container receives no
 * Docker socket, host PID namespace, extra capability or Project Hub environment. This is defense in depth, not a
 * claim that a shared-kernel container is a sufficient boundary for arbitrary hostile code.
 */
export function runContainerCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  limits: ContainerLimits;
  labels?: Record<string, string>;
  onOutput: (text: string) => void;
  isCancelled?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const started = Date.now();
  const name = `projecthub-build-${process.pid}-${randomUUID().slice(0, 12)}`;
  const args = [
    'run',
    '--name', name,
    '--rm',
    '--init',
    '--pull', 'never',
    '--network', opts.limits.network,
    '--cpus', String(opts.limits.cpus),
    '--memory', `${opts.limits.memoryMb}m`,
    '--pids-limit', String(opts.limits.pids),
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=268435456',
    '--mount', `type=bind,source=${opts.cwd},target=/workspace`,
    '--workdir', '/workspace',
  ];
  for (const [key, value] of Object.entries(opts.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))) args.push('--label', `${key}=${value}`);
  // Pass explicit project variables by name so values do not appear in the command line. Host plumbing such as a
  // Windows PATH must not replace the image's Linux PATH.
  for (const key of Object.keys(opts.env).sort()) if (!SAFE_HOST_ENV.has(key.toUpperCase())) args.push('--env', key);
  args.push(opts.limits.image, '/bin/sh', '-lc', opts.command);

  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      execFile('docker', ['rm', '-f', name], { windowsHide: true }, () => undefined);
      killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const poll = opts.isCancelled
      ? setInterval(async () => {
          if (await opts.isCancelled!().catch(() => false)) {
            cancelled = true;
            stop();
          }
        }, 2_000)
      : null;
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => opts.onOutput(d.toString('utf8')));
    child.on('error', (e) => opts.onOutput(`\n[projecthub] container başlatılamadı: ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      opts.signal?.removeEventListener('abort', onAbort);
      // Covers daemon/client disconnects where --rm did not get a chance to execute.
      execFile('docker', ['rm', '-f', name], { windowsHide: true }, () => undefined);
      resolve({ exitCode: code, timedOut, cancelled, durationMs: Date.now() - started });
    });
  });
}

export interface ManagedBuildContainer {
  id: string;
  workerId: string;
  buildId: string;
}

/** Lists only containers created by this runner; used to reconcile leftovers after a worker crash. */
export async function listManagedBuildContainers(): Promise<ManagedBuildContainer[]> {
  const format = '{{.ID}}\t{{.Label "com.projecthub.worker"}}\t{{.Label "com.projecthub.build"}}';
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('docker', ['ps', '-a', '--filter', 'label=com.projecthub.managed=build', '--format', format], { windowsHide: true }, (error, out) =>
      error ? reject(error) : resolve(out),
    );
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split('\t'))
    .filter((row): row is [string, string, string] => row.length === 3 && row.every(Boolean))
    .map(([id, workerId, buildId]) => ({ id, workerId, buildId }));
}

export async function removeManagedBuildContainer(id: string): Promise<void> {
  await new Promise<void>((resolve) => execFile('docker', ['rm', '-f', id], { windowsHide: true }, () => resolve()));
}

/** Starts a long-running process (preview server) detached from the job, logging to a file. */
export function startService(opts: { command: string; cwd: string; env: NodeJS.ProcessEnv; logFile: string }): ChildProcess {
  const out = fs.openSync(opts.logFile, 'a');
  const child = spawn(opts.command, {
    cwd: opts.cwd,
    env: opts.env,
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  return child;
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Line-buffered log writer that timestamps output and caps the file size. */
export class BuildLog {
  private fd: number;
  private bytes = 0;
  private partial = '';
  private readonly tail: string[] = [];
  constructor(
    readonly path: string,
    private readonly maxBytes = 20 * 1024 * 1024,
  ) {
    this.fd = fs.openSync(path, 'a');
  }
  write(text: string): void {
    const data = this.partial + text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = data.split('\n');
    this.partial = lines.pop() ?? '';
    for (const l of lines) this.line(l);
  }
  line(l: string): void {
    // eslint-disable-next-line no-control-regex
    const clean = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    this.tail.push(clean);
    if (this.tail.length > 400) this.tail.shift();
    if (this.bytes > this.maxBytes) return;
    const out = `${clean}\n`;
    this.bytes += Buffer.byteLength(out);
    fs.writeSync(this.fd, this.bytes > this.maxBytes ? '[projecthub] log boyut sınırına ulaştı, kalan çıktı kesildi\n' : out);
  }
  section(title: string): void {
    this.flush();
    this.line(`\n━━ ${title} ━━ ${new Date().toISOString()}`);
  }
  flush(): void {
    if (this.partial) {
      this.line(this.partial);
      this.partial = '';
    }
  }
  lastLines(n = 120): string[] {
    return this.tail.slice(-n);
  }
  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

/**
 * Windows keeps no parent links once a process exits, so a preview whose wrapper shell died (e.g. the worker was
 * killed) cannot be reached through its recorded PID. Kill whatever still listens on the preview's port instead.
 * POSIX previews run in their own process group, which killTree() already terminates as a whole.
 */
export async function killPortListener(port: number): Promise<void> {
  if (process.platform !== 'win32') return;
  const out = await new Promise<string>((resolve) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout)));
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (m && Number(m[1]) === port && Number(m[2]) !== process.pid) pids.add(Number(m[2]));
  }
  for (const pid of pids) killTree(pid);
}

/** Runtime-specific variables for project processes (Python dependencies live in the project's own .pydeps). */
export function runtimeEnv(runtime: string | undefined): Record<string, string> {
  if (runtime === 'python') return { PYTHONPATH: '.pydeps', PYTHONDONTWRITEBYTECODE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  return {};
}

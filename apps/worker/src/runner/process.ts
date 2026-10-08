import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

/** Environment variables of the hub itself that must never be visible to project code. */
const HUB_SECRETS = /^(DATABASE_URL|TEST_DATABASE_URL|APP_ENCRYPTION_KEY|SESSION_.*|SMTP_.*|OPENAI_API_KEY|ANTHROPIC_API_KEY|PH_ADMIN_PASSWORD|STORAGE_DIR|APP_URL|REVIEW_BASE_URL|PREVIEW_.*|API_.*|BUILD_.*|OSV_API_URL|COOKIE_SECURE|LOG_LEVEL|GIT_BINARY|BROWSER_AUTOMATION|NODE_OPTIONS)$/i;

export function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!HUB_SECRETS.test(k) && v !== undefined) env[k] = v;
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

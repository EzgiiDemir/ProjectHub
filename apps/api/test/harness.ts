import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLogger, JobRunner, loadConfig, newWorkerId, QUEUES, Storage, type AppConfig } from '@projecthub/core';
import { freshDatabase, TEST_DATABASE_URL } from '../../../test/support/db.js';
// Nest resolves dependencies from decorator metadata, which only the tsc build emits (pnpm test builds first).
import { createApiServer, type ApiServer } from '../dist/server.js';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const ADMIN = { email: 'Admin@Example.com', password: 'Yonetici-2026-Test' };

export interface Harness {
  base: string;
  server: ApiServer;
  config: AppConfig;
  close(): Promise<void>;
}

/**
 * Fresh test database, first Super Admin through the real `admin:create` CLI, the real API on a random port and —
 * when asked — the real worker job handlers running in-process (repository provisioning, scans, notifications).
 */
export async function startHarness(opts: { worker?: boolean; env?: Record<string, string> } = {}): Promise<Harness> {
  const h = await freshDatabase();
  await h.close();
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'packages/core/dist/cli/create-admin.js'), '--email', ADMIN.email, '--name', 'Test Yönetici', '--org', 'Test Şirketi'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PH_ADMIN_PASSWORD: ADMIN.password },
  });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-api-'));
  const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DATABASE_URL, STORAGE_DIR: tmp, APP_URL: 'http://localhost:3100', COOKIE_SECURE: 'false', OSV_API_URL: '', NPM_REGISTRY_URL: '', PYPI_URL: '', PACKAGIST_URL: '', ...opts.env }, { cwd: tmp });
  const server = await createApiServer(config, { logger: createLogger('api', process.env.TEST_LOG_LEVEL ?? 'silent') });
  await server.app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.app.getHttpServer().address() as AddressInfo).port}`;
  let runner: JobRunner | null = null;
  if (opts.worker) {
    const { buildHandlers } = await import('../../worker/dist/handlers.js');
    const logger = createLogger('worker', process.env.TEST_LOG_LEVEL ?? 'silent');
    const storage = new Storage(config.storageDir);
    const workerId = newWorkerId();
    const ctx = { config, db: server.handle.db, pool: server.handle.pool, storage, logger, workerId };
    runner = new JobRunner({ db: server.handle.db, pool: server.handle.pool, logger }, buildHandlers(ctx), [QUEUES.git, QUEUES.build, QUEUES.preview, QUEUES.deployment, QUEUES.ai, QUEUES.security, QUEUES.notification, QUEUES.default].map((name) => ({ name, concurrency: 1 })), { leaseMs: 30_000, workerId });
    await runner.start();
  }
  return {
    base,
    server,
    config,
    async close() {
      await runner?.stop(5_000);
      await server.close();
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Tiny client with a cookie jar, the CSRF header for writes and the API envelope unwrapped. */
export function client(base: () => string) {
  let cookie = '';
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base()}/api/v1${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-requested-with': 'projecthub' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('ph_session='));
    if (set) cookie = set.split(';')[0]!;
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } | null;
    return { status: res.status, data: json?.data as never, error: json?.error };
  };
  return {
    get: (u: string, h?: Record<string, string>) => call('GET', u, undefined, h),
    post: (u: string, b: unknown = {}, h?: Record<string, string>) => call('POST', u, b, h),
    put: (u: string, b: unknown) => call('PUT', u, b),
    patch: (u: string, b: unknown) => call('PATCH', u, b),
    del: (u: string) => call('DELETE', u),
    raw: call,
  };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
}

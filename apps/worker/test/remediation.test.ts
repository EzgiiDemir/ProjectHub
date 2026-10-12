import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, DEFAULT_AI_SETTINGS, loadConfig, Storage, type JobContext } from '@projecthub/core';
import { aiRemediations, auditEvents, environments, healthChecks, incidents, organizations, projects, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import type { WorkerCtx } from '../src/context.js';
import { runRemediation } from '../src/jobs/remediation.js';

let h: DatabaseHandle;
let tmp: string;
let ctx: WorkerCtx;
let server: http.Server;
let baseUrl: string;
const logger = createLogger('test', 'silent');

beforeAll(async () => {
  h = await freshDatabase();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-remediation-'));
  const config = loadConfig({ ...process.env, STORAGE_DIR: tmp }, { cwd: tmp });
  const storage = new Storage(config.storageDir);
  await storage.init();
  ctx = { config, db: h.db, pool: h.pool, storage, logger, workerId: 'test' };
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: req.url === '/health' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await h?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('controlled self-healing', () => {
  it('runs only the allow-listed health recheck and resolves a recovered monitor incident', async () => {
    const org = (
      await h.db
        .insert(organizations)
        .values({ name: 'O', slug: 'o', settings: { ai: { ...DEFAULT_AI_SETTINGS, selfHealing: { enabled: true, emergencyStop: false, autoRecheckHealth: true, maxAttemptsPerHour: 2 } } } })
        .returning()
    )[0]!;
    const project = (await h.db.insert(projects).values({ organizationId: org.id, name: 'P', slug: 'p' }).returning())[0]!;
    const env = (await h.db.insert(environments).values({ organizationId: org.id, projectId: project.id, name: 'Test', slug: 'test', type: 'staging', url: baseUrl, healthPath: '/health', monitor: true, status: 'down', consecutiveFailures: 3 }).returning())[0]!;
    const incident = (await h.db.insert(incidents).values({ organizationId: org.id, projectId: project.id, environmentId: env.id, number: 1, title: 'Test erişilemiyor', severity: 'medium', source: 'monitor' }).returning())[0]!;
    const remediation = (
      await h.db.insert(aiRemediations).values({ organizationId: org.id, projectId: project.id, incidentId: incident.id, action: 'recheck_health', trigger: 'automatic', diagnosis: 'Sağlık kontrolü', attempt: 1 }).returning()
    )[0]!;
    const job = { job: { id: 'j', type: 'ai.remediation.run', payload: { remediationId: remediation.id }, attempts: 1, maxAttempts: 1 }, logger, signal: new AbortController().signal } as unknown as JobContext;

    expect(await runRemediation(ctx, job)).toMatchObject({ recovered: true, status: 200 });
    expect((await h.db.select().from(aiRemediations).where(eq(aiRemediations.id, remediation.id)))[0]).toMatchObject({ status: 'succeeded', result: expect.objectContaining({ recovered: true, httpStatus: 200 }) });
    expect((await h.db.select().from(incidents).where(eq(incidents.id, incident.id)))[0]).toMatchObject({ status: 'resolved' });
    expect((await h.db.select().from(environments).where(eq(environments.id, env.id)))[0]).toMatchObject({ status: 'healthy', consecutiveFailures: 0 });
    expect(await h.db.select().from(healthChecks).where(eq(healthChecks.environmentId, env.id))).toHaveLength(1);
    expect((await h.db.select().from(auditEvents).where(eq(auditEvents.resourceId, remediation.id))).map((e) => e.action)).toContain('ai.remediation.completed');
  });
});

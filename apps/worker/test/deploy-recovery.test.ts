import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, loadConfig, Storage, type JobContext } from '@projecthub/core';
import { builds, deployments, deploymentSteps, environments, incidents, organizations, projects, versions, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import type { WorkerCtx } from '../src/context.js';
import { executeDeployment } from '../src/jobs/deploy.js';

let h: DatabaseHandle;
let tmp: string;
let ctx: WorkerCtx;
let ids: { org: string; project: string; env: string; version: string };
const logger = createLogger('test', 'silent');
const job = (deploymentId: string) => ({ job: { id: 'j', type: 'deployment.execute', payload: { deploymentId }, attempts: 2, maxAttempts: 3 }, logger, signal: new AbortController().signal }) as unknown as JobContext;

beforeAll(async () => {
  h = await freshDatabase();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ph-recovery-'));
  const config = loadConfig({ ...process.env, STORAGE_DIR: tmp }, { cwd: tmp });
  const storage = new Storage(config.storageDir);
  await storage.init();
  ctx = { config, db: h.db, pool: h.pool, storage, logger, workerId: 'test' };
  const org = (await h.db.insert(organizations).values({ name: 'O', slug: 'o' }).returning())[0]!.id;
  const project = (await h.db.insert(projects).values({ organizationId: org, name: 'P', slug: 'p' }).returning())[0]!.id;
  const env = (await h.db.insert(environments).values({ organizationId: org, projectId: project, name: 'Production', slug: 'production', type: 'production' }).returning())[0]!.id;
  const build = (await h.db.insert(builds).values({ organizationId: org, projectId: project, number: 1, branch: 'main', commitSha: 'a'.repeat(40), status: 'passed' }).returning())[0]!.id;
  const version = (await h.db.insert(versions).values({ organizationId: org, projectId: project, version: '1.0.0', commitSha: 'a'.repeat(40), buildId: build }).returning())[0]!.id;
  ids = { org, project, env, version };
});
afterAll(async () => {
  await h?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function interrupted(number: number, steps: [string, string][]) {
  const d = (await h.db.insert(deployments).values({ organizationId: ids.org, projectId: ids.project, environmentId: ids.env, versionId: ids.version, number, status: 'running', startedAt: new Date() }).returning())[0]!;
  for (const [i, [key, status]] of steps.entries()) await h.db.insert(deploymentSteps).values({ deploymentId: d.id, key, name: key, seq: i, status });
  return d.id;
}

describe('deployment interrupted by a worker restart', () => {
  it('fails cleanly without an incident when the target was not touched yet', async () => {
    const id = await interrupted(1, [['policy', 'passed'], ['artifact', 'running'], ['deploy', 'pending']]);
    await executeDeployment(ctx, job(id));
    const d = (await h.db.select().from(deployments).where(eq(deployments.id, id)))[0]!;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('yeniden deploy edebilirsiniz');
    const steps = await h.db.select().from(deploymentSteps).where(eq(deploymentSteps.deploymentId, id));
    expect(steps.map((s) => `${s.key}:${s.status}`).sort()).toEqual(['artifact:failed', 'deploy:skipped', 'policy:passed']);
    expect(await h.db.select().from(incidents)).toEqual([]);
  });

  it('opens an incident when the release swap may have happened', async () => {
    const id = await interrupted(2, [['deploy', 'passed'], ['health', 'running'], ['smoke', 'pending']]);
    await executeDeployment(ctx, job(id));
    const d = (await h.db.select().from(deployments).where(eq(deployments.id, id)))[0]!;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('kontrol edin');
    const inc = await h.db.select().from(incidents);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: 'high', source: 'deployment', status: 'open' });
  });
});

import os from 'node:os';
import { sql } from 'drizzle-orm';
import { createLogger, enqueue, JobRunner, loadConfig, newWorkerId, QUEUES, Storage, type QueueConfig } from '@projecthub/core';
import { createDatabase, migrateDatabase, workerHeartbeats } from '@projecthub/database';
import type { WorkerCtx } from './context.js';
import { buildHandlers } from './handlers.js';
import { onWorkerStart, onWorkerStop } from './lifecycle.js';

const config = loadConfig();
const logger = createLogger('worker', config.LOG_LEVEL);
const handle = createDatabase(config.DATABASE_URL, { max: 12, applicationName: 'projecthub-worker' });
await migrateDatabase(handle.db);
const storage = new Storage(config.storageDir);
await storage.init();

const queues: QueueConfig[] = [
  { name: QUEUES.git, concurrency: 2 },
  // Spec §109: on the 8 GB server builds run one (configurable) at a time.
  { name: QUEUES.build, concurrency: config.BUILD_CONCURRENCY },
  { name: QUEUES.preview, concurrency: 2 },
  { name: QUEUES.deployment, concurrency: 1 },
  { name: QUEUES.security, concurrency: 1 },
  { name: QUEUES.ai, concurrency: 1 },
  { name: QUEUES.browser, concurrency: 1 },
  { name: QUEUES.notification, concurrency: 4 },
  { name: QUEUES.maintenance, concurrency: 1 },
  { name: QUEUES.default, concurrency: 2 },
];

const workerId = newWorkerId();
const ctx: WorkerCtx = { config, db: handle.db, pool: handle.pool, storage, logger, workerId };
const runner = new JobRunner({ db: handle.db, pool: handle.pool, logger }, buildHandlers(ctx), queues, { leaseMs: 60_000, workerId });

const startedAt = new Date();
async function heartbeat() {
  try {
    await handle.db
      .insert(workerHeartbeats)
      .values({ workerId: runner.workerId, hostname: os.hostname(), pid: process.pid, queues: queues.map((q) => q.name), startedAt, lastSeenAt: new Date(), info: { activeJobs: runner.activeCount, rss: process.memoryUsage().rss } })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: new Date(), info: { activeJobs: runner.activeCount, rss: process.memoryUsage().rss } } });
  } catch (e) {
    logger.warn({ err: e }, 'heartbeat failed');
  }
}

/** Recurring work: a deduplicated tick every minute (preview/review expiry, health checks, retention cleanup). */
async function scheduleMaintenance() {
  try {
    const minute = Math.floor(Date.now() / 60_000);
    await enqueue(handle.db, { queue: QUEUES.maintenance, type: 'maintenance.tick', dedupeKey: `tick:${minute}`, maxAttempts: 1, payload: { minute } });
  } catch (e) {
    logger.warn({ err: e }, 'scheduling maintenance failed');
  }
}

await onWorkerStart(ctx);
await runner.start();
await heartbeat();
await scheduleMaintenance();
const hb = setInterval(heartbeat, 15_000);
const sched = setInterval(scheduleMaintenance, 60_000);
logger.info({ workerId: runner.workerId, queues: queues.map((q) => `${q.name}×${q.concurrency}`) }, 'Project Hub worker started');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down');
    clearInterval(hb);
    clearInterval(sched);
    // Fits the container stop grace period (deploy/compose.yaml: 60 s); unfinished jobs are re-queued.
    await runner.stop(50_000);
    await onWorkerStop(ctx);
    await handle.db.execute(sql`DELETE FROM worker_heartbeats WHERE worker_id = ${runner.workerId}`).catch(() => undefined);
    await handle.close();
    process.exit(0);
  });
}

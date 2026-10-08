import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { JobContext } from '@projecthub/core';
import { jobs, uploads, workerHeartbeats } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';

type Task = { name: string; everyMinutes: number; run: (ctx: WorkerCtx) => Promise<unknown> };
const tasks: Task[] = [];

/** Feature modules register periodic tasks; the minute tick runs those that are due. */
export function registerPeriodic(task: Task) {
  tasks.push(task);
}

registerPeriodic({
  name: 'expire-uploads',
  everyMinutes: 30,
  run: async (ctx) => {
    const expired = await ctx.db.select().from(uploads).where(and(lt(uploads.expiresAt, new Date()), isNull(uploads.consumedAt)));
    for (const u of expired) {
      await ctx.storage.remove(u.storageKey);
      await ctx.db.delete(uploads).where(eq(uploads.id, u.id));
    }
    return expired.length;
  },
});

registerPeriodic({
  name: 'prune-jobs',
  everyMinutes: 60,
  run: async (ctx) => {
    const r = await ctx.db.delete(jobs).where(and(sql`${jobs.status} IN ('completed','cancelled')`, lt(jobs.finishedAt, new Date(Date.now() - 7 * 86400_000)))).returning({ id: jobs.id });
    await ctx.db.delete(workerHeartbeats).where(lt(workerHeartbeats.lastSeenAt, new Date(Date.now() - 3600_000)));
    return r.length;
  },
});

export async function maintenanceTick(ctx: WorkerCtx, { job, logger }: JobContext) {
  const minute = Number((job.payload as { minute?: number }).minute ?? Math.floor(Date.now() / 60_000));
  const results: Record<string, unknown> = {};
  for (const t of tasks) {
    if (minute % t.everyMinutes !== 0) continue;
    try {
      results[t.name] = await t.run(ctx);
    } catch (e) {
      logger.error({ err: e, task: t.name }, 'maintenance task failed');
      results[t.name] = `error: ${(e as Error).message}`;
    }
  }
  return results;
}

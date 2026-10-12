import os from 'node:os';
import { and, eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import { jobs, type Database, type Executor } from '@projecthub/database';
import type { Logger } from './logger.js';

export const QUEUES = {
  default: 'default',
  git: 'git',
  build: 'build',
  preview: 'preview',
  deployment: 'deployment',
  security: 'security',
  ai: 'ai',
  browser: 'browser',
  notification: 'notification',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobSpec {
  queue: QueueName;
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  runAt?: Date;
  /** Prevents duplicates while an identical job is queued or running. */
  dedupeKey?: string;
  organizationId?: string | null;
  projectId?: string | null;
}

/**
 * Inserts a job. Call it with the transaction that performs the business change so the job is
 * committed atomically with it (transactional outbox). Returns null when deduplicated.
 */
export async function enqueue(db: Executor, spec: JobSpec): Promise<string | null> {
  const rows = await db
    .insert(jobs)
    .values({
      queue: spec.queue,
      type: spec.type,
      payload: spec.payload ?? {},
      priority: spec.priority ?? 0,
      maxAttempts: spec.maxAttempts ?? 3,
      runAt: spec.runAt ?? new Date(),
      dedupeKey: spec.dedupeKey ?? null,
      organizationId: spec.organizationId ?? null,
      projectId: spec.projectId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

export type ClaimedJob = typeof jobs.$inferSelect;

export interface JobContext {
  job: ClaimedJob;
  logger: Logger;
  /** Aborted when the worker is shutting down or the job lease was lost. */
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** Throw to fail a job immediately without further retries. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/**
 * Throw when a job cannot start yet because of a capacity limit (e.g. the organization's concurrent-build cap).
 * The job goes back to the queue after `delayMs` without consuming an attempt.
 */
export class DeferJobError extends Error {
  constructor(
    message: string,
    readonly delayMs = 15_000,
  ) {
    super(message);
    this.name = 'DeferJobError';
  }
}

export function newWorkerId(): string {
  return `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

/** Retry schedule from the spec: 30 s, 2 min, 10 min. */
export function backoffMs(attempt: number): number {
  return [30_000, 120_000, 600_000][Math.min(attempt - 1, 2)] ?? 600_000;
}

export interface QueueConfig {
  name: QueueName;
  concurrency: number;
}

/**
 * Durable worker loop. Claims jobs with FOR UPDATE SKIP LOCKED and a renewable lease, so a crashed
 * worker's jobs are picked up again after the lease expires. Woken instantly via LISTEN ph_jobs.
 */
export class JobRunner {
  readonly workerId: string;
  private stopping = false;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly running = new Map<string, number>();
  private listener: pg.PoolClient | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly leaseMs: number;
  private wakeScheduled = false;

  constructor(
    private readonly deps: { db: Database; pool: pg.Pool; logger: Logger },
    private readonly handlers: Record<string, JobHandler>,
    private readonly queues: QueueConfig[],
    options: { leaseMs?: number; workerId?: string } = {},
  ) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.workerId = options.workerId ?? newWorkerId();
  }

  async start(): Promise<void> {
    this.listener = await this.deps.pool.connect();
    this.listener.on('notification', () => this.wake());
    this.listener.on('error', (e) => this.deps.logger.error({ err: e }, 'job listener connection error'));
    await this.listener.query('LISTEN ph_jobs');
    this.pollTimer = setInterval(() => this.wake(), 5_000);
    this.wake();
  }

  /** Graceful shutdown: stop claiming, give running jobs time to finish, then release their leases. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    const all = [...this.active.values()];
    const timeout = new Promise<void>((r) => setTimeout(r, timeoutMs));
    await Promise.race([Promise.all(all.map((a) => a.done)), timeout]);
    for (const [id, a] of this.active) {
      a.controller.abort();
      await this.deps.db
        .update(jobs)
        .set({ status: 'queued', lockedBy: null, lockedUntil: null, runAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'running')));
    }
    if (this.listener) {
      try {
        await this.listener.query('UNLISTEN ph_jobs');
      } catch {
        /* connection may already be gone */
      }
      this.listener.release();
    }
  }

  private wake(): void {
    if (this.stopping || this.wakeScheduled) return;
    this.wakeScheduled = true;
    setImmediate(() => {
      this.wakeScheduled = false;
      void this.fill();
    });
  }

  private async fill(): Promise<void> {
    for (const q of this.queues) {
      while (!this.stopping && (this.running.get(q.name) ?? 0) < q.concurrency) {
        let job: ClaimedJob | null;
        try {
          job = await this.claim(q.name);
        } catch (e) {
          this.deps.logger.error({ err: e, queue: q.name }, 'failed to claim job');
          break;
        }
        if (!job) break;
        this.launch(q.name, job);
      }
    }
  }

  private async claim(queue: string): Promise<ClaimedJob | null> {
    const leaseSeconds = Math.ceil(this.leaseMs / 1000);
    const result = await this.deps.db.execute<Record<string, unknown>>(sql`
      UPDATE jobs SET
        status = 'running',
        attempts = attempts + 1,
        locked_by = ${this.workerId},
        locked_until = now() + make_interval(secs => ${leaseSeconds}),
        started_at = coalesce(started_at, now())
      WHERE id = (
        SELECT id FROM jobs
        WHERE queue = ${queue}
          AND ((status = 'queued' AND run_at <= now()) OR (status = 'running' AND locked_until < now()))
        ORDER BY priority DESC, run_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`);
    const id = result.rows[0]?.id as string | undefined;
    if (!id) return null;
    const rows = await this.deps.db.select().from(jobs).where(eq(jobs.id, id));
    return rows[0] ?? null;
  }

  private launch(queue: string, job: ClaimedJob): void {
    this.running.set(queue, (this.running.get(queue) ?? 0) + 1);
    const controller = new AbortController();
    const logger = this.deps.logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const done = this.execute(job, controller, logger).finally(() => {
      this.running.set(queue, (this.running.get(queue) ?? 1) - 1);
      this.active.delete(job.id);
      this.wake();
    });
    this.active.set(job.id, { controller, done });
  }

  private async execute(job: ClaimedJob, controller: AbortController, logger: Logger): Promise<void> {
    const handler = this.handlers[job.type];
    const heartbeat = setInterval(async () => {
      try {
        const r = await this.deps.db
          .update(jobs)
          .set({ lockedUntil: sql`now() + make_interval(secs => ${Math.ceil(this.leaseMs / 1000)})` })
          .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, this.workerId), eq(jobs.status, 'running')))
          .returning({ id: jobs.id });
        if (!r.length) {
          logger.warn('job lease lost, aborting');
          controller.abort();
        }
      } catch (e) {
        logger.error({ err: e }, 'lease renewal failed');
      }
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));

    try {
      if (!handler) throw new PermanentJobError(`No handler registered for job type "${job.type}"`);
      logger.debug('job started');
      const result = await handler({ job, logger, signal: controller.signal });
      await this.deps.db
        .update(jobs)
        .set({ status: 'completed', result: (result ?? null) as never, finishedAt: new Date(), lockedBy: null, lockedUntil: null, lastError: null })
        .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, this.workerId)));
      logger.debug('job completed');
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (this.stopping && controller.signal.aborted) return; // lease released in stop()
      if (err instanceof DeferJobError) {
        logger.debug({ retryInMs: err.delayMs }, err.message);
        await this.deps.db
          .update(jobs)
          .set({ status: 'queued', attempts: sql`greatest(${jobs.attempts} - 1, 0)`, lastError: err.message.slice(0, 4000), runAt: new Date(Date.now() + err.delayMs), lockedBy: null, lockedUntil: null })
          .where(eq(jobs.id, job.id));
        return;
      }
      const permanent = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      if (permanent) {
        logger.error({ err }, 'job failed permanently');
        await this.deps.db
          .update(jobs)
          .set({ status: 'failed', lastError: err.message.slice(0, 4000), finishedAt: new Date(), lockedBy: null, lockedUntil: null })
          .where(eq(jobs.id, job.id));
      } else {
        const delay = backoffMs(job.attempts);
        logger.warn({ err, retryInMs: delay }, 'job failed, will retry');
        await this.deps.db
          .update(jobs)
          .set({ status: 'queued', lastError: err.message.slice(0, 4000), runAt: new Date(Date.now() + delay), lockedBy: null, lockedUntil: null })
          .where(eq(jobs.id, job.id));
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  get activeCount(): number {
    return this.active.size;
  }
}

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs, type DatabaseHandle } from '@projecthub/database';
import { freshDatabase } from '../../../test/support/db.js';
import { createLogger } from '../src/logger.js';
import { enqueue, JobRunner, PermanentJobError, QUEUES } from '../src/queue.js';

let h: DatabaseHandle;
const logger = createLogger('test', 'silent');

beforeAll(async () => {
  h = await freshDatabase();
});
afterAll(async () => {
  await h.close();
});

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const statusOf = async (id: string) => (await h.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

describe('JobRunner', () => {
  it('runs jobs enqueued in a committed transaction, never in a rolled back one', async () => {
    const seen: string[] = [];
    const runner = new JobRunner({ ...h, logger }, { 'test.echo': async ({ job }) => void seen.push(String(job.payload.v)) }, [{ name: QUEUES.default, concurrency: 2 }]);
    await runner.start();
    let committed = '';
    await h.db.transaction(async (tx) => {
      committed = (await enqueue(tx, { queue: QUEUES.default, type: 'test.echo', payload: { v: 'ok' } }))!;
    });
    await h.db
      .transaction(async (tx) => {
        await enqueue(tx, { queue: QUEUES.default, type: 'test.echo', payload: { v: 'rolled-back' } });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await waitFor(async () => (await statusOf(committed)).status === 'completed');
    await runner.stop();
    expect(seen).toEqual(['ok']);
  });

  it('deduplicates while a job with the same key is pending', async () => {
    const a = await enqueue(h.db, { queue: QUEUES.maintenance, type: 'x', dedupeKey: 'same' });
    const b = await enqueue(h.db, { queue: QUEUES.maintenance, type: 'x', dedupeKey: 'same' });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it('retries with backoff, then fails permanently', async () => {
    let calls = 0;
    const runner = new JobRunner(
      { ...h, logger },
      {
        'test.flaky': async () => {
          calls++;
          throw new Error('boom');
        },
        'test.fatal': async () => {
          throw new PermanentJobError('no retry');
        },
      },
      [{ name: QUEUES.security, concurrency: 1 }],
    );
    await runner.start();
    const flaky = (await enqueue(h.db, { queue: QUEUES.security, type: 'test.flaky', maxAttempts: 2 }))!;
    await waitFor(async () => (await statusOf(flaky)).attempts === 1 && (await statusOf(flaky)).status === 'queued');
    const j = await statusOf(flaky);
    expect(j.lastError).toBe('boom');
    expect(j.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // 30 s backoff
    // Fast-forward the retry.
    await h.db.update(jobs).set({ runAt: sql`now()` }).where(eq(jobs.id, flaky));
    await waitFor(async () => (await statusOf(flaky)).status === 'failed');
    expect(calls).toBe(2);
    const fatal = (await enqueue(h.db, { queue: QUEUES.security, type: 'test.fatal', maxAttempts: 5 }))!;
    await waitFor(async () => (await statusOf(fatal)).status === 'failed');
    expect((await statusOf(fatal)).attempts).toBe(1);
    await runner.stop();
  });

  it('recovers jobs whose worker died (expired lease)', async () => {
    const id = (await enqueue(h.db, { queue: QUEUES.git, type: 'test.recover' }))!;
    // Simulate a crashed worker holding the job with an expired lease.
    await h.db
      .update(jobs)
      .set({ status: 'running', attempts: 1, lockedBy: 'dead-worker', lockedUntil: sql`now() - interval '1 minute'` })
      .where(eq(jobs.id, id));
    const runner = new JobRunner({ ...h, logger }, { 'test.recover': async () => 'done' }, [{ name: QUEUES.git, concurrency: 1 }]);
    await runner.start();
    await waitFor(async () => (await statusOf(id)).status === 'completed');
    await runner.stop();
    expect((await statusOf(id)).attempts).toBe(2);
  });
});

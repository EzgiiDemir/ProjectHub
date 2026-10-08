import type { WorkerCtx } from './context.js';

/** Hooks run when the worker process starts and stops (preview process reconciliation lives here). */
const startHooks: ((ctx: WorkerCtx) => Promise<void>)[] = [];
const stopHooks: ((ctx: WorkerCtx) => Promise<void>)[] = [];

export function registerLifecycle(hooks: { start?: (ctx: WorkerCtx) => Promise<void>; stop?: (ctx: WorkerCtx) => Promise<void> }) {
  if (hooks.start) startHooks.push(hooks.start);
  if (hooks.stop) stopHooks.push(hooks.stop);
}

export async function onWorkerStart(ctx: WorkerCtx) {
  for (const h of startHooks) await h(ctx);
}

export async function onWorkerStop(ctx: WorkerCtx) {
  for (const h of stopHooks) {
    try {
      await h(ctx);
    } catch (e) {
      ctx.logger.warn({ err: e }, 'stop hook failed');
    }
  }
}

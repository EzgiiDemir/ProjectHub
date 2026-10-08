import type { JobContext, JobHandler } from '@projecthub/core';
import type { WorkerCtx } from './context.js';
import { analyseBuildFailure, relateFeedback, runAiTask } from './jobs/ai.js';
import { feedbackScreenshot, responsiveTest } from './jobs/browser.js';
import { executeBuild } from './jobs/build.js';
import { backupDatabase, checkDatabase, executeDeployment, testTarget } from './jobs/deploy.js';
import { deliverWebhook, dispatchEvent } from './jobs/events.js';
import { indexCode, recomputeHealth } from './jobs/index-code.js';
import { maintenanceTick } from './jobs/maintenance.js';
import { startPreview, stopPreview } from './jobs/preview.js';
import { detectJob, provisionRepository, syncJob } from './jobs/repository.js';
import { securityScan } from './jobs/security.js';

type Job = (ctx: WorkerCtx, job: JobContext) => Promise<unknown>;

/** Job type → implementation. Every job type the API or worker enqueues must be listed here. */
export function buildHandlers(ctx: WorkerCtx): Record<string, JobHandler> {
  const jobs: Record<string, Job> = {
    'repository.provision': provisionRepository,
    'repository.sync': syncJob,
    'project.detect': detectJob,
    'code.index': indexCode,
    'project.health': recomputeHealth,
    'security.scan': securityScan,
    'event.dispatch': dispatchEvent,
    'webhook.deliver': deliverWebhook,
    'maintenance.tick': maintenanceTick,
    'build.execute': executeBuild,
    'preview.start': startPreview,
    'preview.stop': stopPreview,
    'feedback.screenshot': feedbackScreenshot,
    'responsive.test': responsiveTest,
    'feedback.relate': relateFeedback,
    'ai.build_analysis': analyseBuildFailure,
    'ai.task.run': runAiTask,
    'deployment.execute': executeDeployment,
    'deployment.test_target': testTarget,
    'database.check': checkDatabase,
    'database.backup': backupDatabase,
  };
  return Object.fromEntries(Object.entries(jobs).map(([k, fn]) => [k, (job: JobContext) => fn(ctx, job)]));
}

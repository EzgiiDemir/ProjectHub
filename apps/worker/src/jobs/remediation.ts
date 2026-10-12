import { and, eq } from 'drizzle-orm';
import { audit, emitDomainEvent, getOrgSettings, PermanentJobError, publish, SYSTEM_ACTOR, timeline, type JobContext } from '@projecthub/core';
import { aiRemediations, environments, healthChecks, incidents } from '@projecthub/database';
import type { WorkerCtx } from '../context.js';
import { httpCheck } from './deploy.js';

/**
 * Executes the deliberately tiny self-healing allow-list. This job never runs a shell command, changes
 * infrastructure, deploys, migrates data, edits permissions or touches credentials. The only allowed action is
 * an HTTP health recheck; a recovered endpoint may close its own monitor incident.
 */
export async function runRemediation(ctx: WorkerCtx, { job }: JobContext) {
  const { remediationId } = job.payload as { remediationId: string };
  const remediation = (await ctx.db.select().from(aiRemediations).where(eq(aiRemediations.id, remediationId)))[0];
  if (!remediation) throw new PermanentJobError('remediation missing');
  if (remediation.status !== 'queued') return { skipped: remediation.status };
  const incident = (await ctx.db.select().from(incidents).where(and(eq(incidents.id, remediation.incidentId), eq(incidents.projectId, remediation.projectId))))[0];
  const env = incident?.environmentId ? (await ctx.db.select().from(environments).where(eq(environments.id, incident.environmentId)))[0] : null;
  const settings = await getOrgSettings(ctx.db, remediation.organizationId);
  const block = async (reason: string) => {
    await ctx.db.update(aiRemediations).set({ status: 'blocked', result: { reason }, finishedAt: new Date() }).where(eq(aiRemediations.id, remediation.id));
    await audit(ctx.db, { organizationId: remediation.organizationId, projectId: remediation.projectId, actor: SYSTEM_ACTOR, action: 'ai.remediation.blocked', resourceType: 'ai_remediation', resourceId: remediation.id, metadata: { reason } });
    return { blocked: reason };
  };
  if (!settings.ai.selfHealing.enabled || settings.ai.selfHealing.emergencyStop) return block('Kendini iyileştirme politikası veya acil durdurma işlemi engelledi');
  if (remediation.action !== 'recheck_health') return block('İzin listesinde olmayan işlem');
  if (!incident || !env || incident.source !== 'monitor') return block('İzleme olayı veya ortam bulunamadı');
  if (incident.status !== 'open') return block('Olay artık açık değil');
  if (!env.url) return block('Ortam URL bilgisi yok');

  await ctx.db.update(aiRemediations).set({ status: 'running', startedAt: new Date() }).where(eq(aiRemediations.id, remediation.id));
  const url = new URL(env.healthPath || '/', env.url).toString();
  const result = await httpCheck(url);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(healthChecks).values({ environmentId: env.id, ok: result.ok, httpStatus: result.status, latencyMs: result.ms, error: result.error ?? null });
    await tx
      .update(aiRemediations)
      .set({ status: 'succeeded', result: { url, recovered: result.ok, httpStatus: result.status, latencyMs: result.ms, error: result.error ?? null }, finishedAt: new Date() })
      .where(eq(aiRemediations.id, remediation.id));
    if (result.ok) {
      await tx.update(environments).set({ status: result.ms > 3000 ? 'degraded' : 'healthy', consecutiveFailures: 0, lastHealthAt: new Date() }).where(eq(environments.id, env.id));
      await tx.update(incidents).set({ status: 'resolved', resolvedAt: new Date(), rootCause: incident.rootCause ?? 'Sağlık uç noktası tekrar erişilebilir oldu; kesin kök neden belirlenmedi.' }).where(eq(incidents.id, incident.id));
      await timeline(tx, { organizationId: remediation.organizationId, projectId: remediation.projectId, kind: 'incident', tone: 'ok', title: `INC-${incident.number} kontrollü sağlık kontrolüyle doğrulandı`, description: `${url} → HTTP ${result.status} · ${result.ms} ms`, actorLabel: 'Project Hub AI', refType: 'incident', refId: incident.id });
      await emitDomainEvent(tx, { event: 'incident.resolved', organizationId: remediation.organizationId, projectId: remediation.projectId, actor: SYSTEM_ACTOR, data: { incidentId: incident.id, title: incident.title, remediationId: remediation.id } });
    } else {
      await timeline(tx, { organizationId: remediation.organizationId, projectId: remediation.projectId, kind: 'incident', tone: 'warn', title: `INC-${incident.number} sağlık kontrolü hâlâ başarısız`, description: `${url} → ${result.status ?? result.error ?? 'yanıt yok'}`, actorLabel: 'Project Hub AI', refType: 'incident', refId: incident.id });
    }
    await audit(tx, { organizationId: remediation.organizationId, projectId: remediation.projectId, actor: SYSTEM_ACTOR, action: 'ai.remediation.completed', resourceType: 'ai_remediation', resourceId: remediation.id, metadata: { incidentId: incident.id, recovered: result.ok, httpStatus: result.status } });
    await publish(tx, { type: 'incident.updated', organizationId: remediation.organizationId, projectId: remediation.projectId, id: incident.id });
    await publish(tx, { type: 'environment.updated', organizationId: remediation.organizationId, projectId: remediation.projectId, id: env.id });
  });
  return { recovered: result.ok, status: result.status, latencyMs: result.ms };
}

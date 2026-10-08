import { sql } from 'drizzle-orm';
import type { ActorType, DomainEvent, EventKind, EventTone, RealtimeEvent } from '@projecthub/contracts';
import { auditEvents, counters, projectEvents, type Executor } from '@projecthub/database';
import { enqueue, QUEUES } from './queue.js';

export interface Actor {
  type: ActorType;
  id: string | null;
  label: string;
  ip?: string | null;
  userAgent?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'System' };

/** Appends to the immutable audit trail. */
export async function audit(
  db: Executor,
  input: {
    organizationId: string;
    projectId?: string | null;
    actor: Actor;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditEvents).values({
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    actorType: input.actor.type,
    actorId: input.actor.id,
    actorLabel: input.actor.label,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    metadata: input.metadata ?? {},
    ipAddress: input.actor.ip ?? null,
    userAgent: input.actor.userAgent ?? null,
  });
}

/** Adds an entry to the project timeline and pushes it to connected clients. */
export async function timeline(
  db: Executor,
  input: {
    organizationId: string;
    projectId: string;
    kind: EventKind;
    tone?: EventTone;
    title: string;
    description?: string;
    refType?: string;
    refId?: string;
    actorLabel?: string;
  },
): Promise<void> {
  await db.insert(projectEvents).values({
    organizationId: input.organizationId,
    projectId: input.projectId,
    kind: input.kind,
    tone: input.tone ?? 'idle',
    title: input.title.slice(0, 300),
    description: input.description ?? '',
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    actorLabel: input.actorLabel ?? 'System',
  });
  await publish(db, { type: 'timeline', organizationId: input.organizationId, projectId: input.projectId });
}

/**
 * Pushes a realtime event to every API instance (pg_notify). Inside a transaction it is delivered on
 * commit, so clients never see events for changes that were rolled back.
 */
export async function publish(db: Executor, event: RealtimeEvent): Promise<void> {
  let payload = JSON.stringify(event);
  if (payload.length > 7500) payload = JSON.stringify({ ...event, data: { truncated: true } });
  await db.execute(sql`SELECT pg_notify('ph_events', ${payload})`);
}

/**
 * Emits a domain event (webhooks + notification fan-out) through the transactional outbox.
 */
export async function emitDomainEvent(
  db: Executor,
  input: { event: DomainEvent; organizationId: string; projectId?: string | null; actor?: Actor; data: Record<string, unknown> },
): Promise<void> {
  await enqueue(db, {
    queue: QUEUES.notification,
    type: 'event.dispatch',
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    maxAttempts: 5,
    payload: {
      eventId: crypto.randomUUID(),
      eventType: input.event,
      occurredAt: new Date().toISOString(),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      actor: input.actor ? { type: input.actor.type, id: input.actor.id, label: input.actor.label } : null,
      payload: input.data,
    },
  });
}

/** Gap-free per-scope sequence (row lock held until the surrounding transaction commits). */
export async function nextNumber(db: Executor, scopeId: string, name: string): Promise<number> {
  const rows = await db
    .insert(counters)
    .values({ scopeId, name, value: 1 })
    .onConflictDoUpdate({ target: [counters.scopeId, counters.name], set: { value: sql`${counters.value} + 1` } })
    .returning({ value: counters.value });
  return rows[0]!.value;
}

/** Human readable keys used across the UI. */
export const keys = {
  feedback: (n: number) => `FB-${n}`,
  task: (n: number) => `PH-${n}`,
  aiTask: (n: number) => `AI-${n}`,
  deployment: (n: number) => `D-${n}`,
  finding: (n: number) => `SEC-${n}`,
  incident: (n: number) => `INC-${n}`,
  review: (n: number) => `RV-${n}`,
  build: (n: number) => `#${n}`,
};

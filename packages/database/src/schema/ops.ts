import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  ACTOR_TYPES,
  EVENT_KINDS,
  EVENT_TONES,
  INCIDENT_STATUSES,
  JOB_STATUSES,
  type ActorType,
  type EventKind,
  type EventTone,
  type IncidentStatus,
  type JobStatus,
} from '@projecthub/contracts';
import { createdAt, inet, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';
import { environments } from './deploy.js';

/**
 * Immutable audit trail ("who did what"). UPDATE/DELETE are blocked by a database trigger
 * (see migration 0001_hardening.sql), so even the application cannot rewrite history.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: pk(),
    organizationId: uuid().notNull(),
    projectId: uuid(),
    actorType: varchar({ length: 20 }).$type<ActorType>().notNull(),
    actorId: uuid(),
    actorLabel: varchar({ length: 200 }).notNull(),
    action: varchar({ length: 150 }).notNull(),
    resourceType: varchar({ length: 100 }).notNull(),
    resourceId: varchar({ length: 255 }),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: inet(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_project_idx').on(t.projectId, t.createdAt),
    index('audit_actor_idx').on(t.actorId),
    index('audit_action_idx').on(t.action),
    check('audit_actor_type_ck', oneOf('actor_type', ACTOR_TYPES)),
  ],
);

/** Project timeline: the chronological memory of a project (commits, builds, reviews, deployments, ...). */
export const projectEvents = pgTable(
  'project_events',
  {
    id: pk(),
    organizationId: uuid().notNull(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: varchar({ length: 20 }).$type<EventKind>().notNull(),
    tone: varchar({ length: 10 }).$type<EventTone>().notNull().default('idle'),
    title: varchar({ length: 300 }).notNull(),
    description: text().notNull().default(''),
    refType: varchar({ length: 40 }),
    refId: varchar({ length: 100 }),
    actorLabel: varchar({ length: 200 }).notNull().default('System'),
    createdAt: createdAt(),
  },
  (t) => [
    index('project_events_project_idx').on(t.projectId, t.createdAt),
    check('project_events_kind_ck', oneOf('kind', EVENT_KINDS)),
    check('project_events_tone_ck', oneOf('tone', EVENT_TONES)),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    category: varchar({ length: 30 }).notNull(),
    title: varchar({ length: 300 }).notNull(),
    body: text().notNull().default(''),
    link: varchar({ length: 500 }),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

/**
 * Durable job queue + transactional outbox. Rows are inserted in the same transaction as the
 * business change they belong to; workers claim them with FOR UPDATE SKIP LOCKED and a lease.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: pk(),
    queue: varchar({ length: 40 }).notNull(),
    type: varchar({ length: 80 }).notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: varchar({ length: 20 }).$type<JobStatus>().notNull().default('queued'),
    priority: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    runAt: ts().notNull().defaultNow(),
    lockedBy: varchar({ length: 100 }),
    lockedUntil: ts(),
    /** While a job with this key is queued/running, enqueuing another one with the same key is a no-op. */
    dedupeKey: varchar({ length: 200 }),
    lastError: text(),
    result: jsonb(),
    organizationId: uuid(),
    projectId: uuid(),
    startedAt: ts(),
    finishedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_claim_idx').on(t.queue, t.status, t.runAt),
    uniqueIndex('jobs_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status IN ('queued', 'running')`),
    index('jobs_finished_idx').on(t.finishedAt),
    check('jobs_status_ck', oneOf('status', JOB_STATUSES)),
  ],
);

export const webhooks = pgTable('webhooks', {
  id: pk(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  url: varchar({ length: 500 }).notNull(),
  /** Encrypted HMAC signing secret (stored via the secret helpers). */
  secretCiphertext: text().notNull(),
  events: jsonb().$type<string[]>().notNull(),
  active: boolean().notNull().default(true),
  lastStatus: integer(),
  lastDeliveryAt: ts(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    webhookId: uuid()
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventType: varchar({ length: 80 }).notNull(),
    payload: jsonb().notNull(),
    status: varchar({ length: 20 }).notNull(),
    responseCode: integer(),
    error: text(),
    durationMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt)],
);

export const incidents = pgTable(
  'incidents',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid().references(() => environments.id, { onDelete: 'set null' }),
    number: integer().notNull(),
    title: varchar({ length: 300 }).notNull(),
    severity: varchar({ length: 20 }).notNull(),
    status: varchar({ length: 20 }).$type<IncidentStatus>().notNull().default('open'),
    source: varchar({ length: 30 }).notNull().default('manual'),
    rootCause: text(),
    postmortem: text(),
    startedAt: ts().notNull().defaultNow(),
    resolvedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('incidents_org_number_uq').on(t.organizationId, t.number),
    index('incidents_project_idx').on(t.projectId, t.startedAt),
    check('incidents_status_ck', oneOf('status', INCIDENT_STATUSES)),
    check('incidents_severity_ck', oneOf('severity', ['critical', 'high', 'medium', 'low'])),
  ],
);

export const healthChecks = pgTable(
  'health_checks',
  {
    id: pk(),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    ok: boolean().notNull(),
    httpStatus: integer(),
    latencyMs: integer(),
    error: text(),
    checkedAt: createdAt(),
  },
  (t) => [index('health_checks_env_idx').on(t.environmentId, t.checkedAt)],
);

/** Heartbeats of running worker processes (system health page). */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: varchar({ length: 100 }).primaryKey(),
  hostname: varchar({ length: 255 }).notNull(),
  pid: integer().notNull(),
  queues: jsonb().$type<string[]>().notNull(),
  startedAt: ts().notNull(),
  lastSeenAt: ts().notNull().defaultNow(),
  info: jsonb().$type<Record<string, unknown>>().notNull().default({}),
});

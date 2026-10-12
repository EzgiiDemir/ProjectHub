import { boolean, check, index, jsonb, pgTable, text, uniqueIndex, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects, tasks } from './projects.js';

export const TASK_EVENT_KINDS = ['created', 'status', 'assigned', 'due', 'priority', 'edited', 'comment'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** Discussion under a task (team work board). */
export const taskComments = pgTable(
  'task_comments',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    editedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('task_comments_task_idx').on(t.taskId, t.createdAt)],
);

/** Task history: who moved it to which column, re-assigned it or changed its due date, and when. */
export const taskEvents = pgTable(
  'task_events',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    actorLabel: varchar({ length: 200 }).notNull(),
    kind: varchar({ length: 20 }).$type<TaskEventKind>().notNull(),
    fromValue: varchar({ length: 200 }),
    toValue: varchar({ length: 200 }),
    createdAt: createdAt(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId, t.createdAt), check('task_events_kind_ck', oneOf('kind', TASK_EVENT_KINDS))],
);

/** Project discussion: comments with one level of replies and @mentions (notified). */
export const projectComments = pgTable(
  'project_comments',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: uuid().references((): AnyPgColumn => projectComments.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    mentions: jsonb().$type<string[]>().notNull().default([]),
    pinned: boolean().notNull().default(false),
    editedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('project_comments_project_idx').on(t.projectId, t.createdAt)],
);

export const INTEGRATION_PROVIDERS = ['microsoft-entra', 'wordpress', 'google-analytics', 'smtp', 'slack', 'webhook', 'rest-api'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/**
 * Third-party integrations a managed project uses (Microsoft Entra ID sign-in, WordPress / WP Forms, …).
 * Non-secret settings live in `config`; secret values are stored encrypted in `secrets` (names in `secretKeys`) and
 * reach the project's builds and deployments as environment variables.
 */
export const projectIntegrations = pgTable(
  'project_integrations',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: varchar({ length: 40 }).$type<IntegrationProvider>().notNull(),
    name: varchar({ length: 120 }).notNull(),
    config: jsonb().$type<Record<string, string>>().notNull().default({}),
    secretKeys: jsonb().$type<string[]>().notNull().default([]),
    enabled: boolean().notNull().default(true),
    lastCheckedAt: ts(),
    lastCheckOk: boolean(),
    lastCheckMessage: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('project_integrations_name_uq').on(t.projectId, t.name), check('project_integrations_provider_ck', oneOf('provider', INTEGRATION_PROVIDERS))],
);

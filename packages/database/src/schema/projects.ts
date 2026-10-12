import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  PRIORITIES,
  PROJECT_STATUSES,
  REPOSITORY_STATUSES,
  TASK_STATUSES,
  type DetectionResult,
  type Manifest,
  type Priority,
  type ProjectStatus,
  type RepositoryStatus,
  type TaskStatus,
} from '@projecthub/contracts';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, roles, teams, users } from './identity.js';

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar({ length: 150 }).notNull(),
    slug: varchar({ length: 150 }).notNull(),
    description: text().notNull().default(''),
    status: varchar({ length: 30 }).$type<ProjectStatus>().notNull().default('active'),
    projectType: varchar({ length: 80 }).notNull().default(''),
    technologies: jsonb().$type<string[]>().notNull().default([]),
    customerName: varchar({ length: 150 }).notNull().default(''),
    color: varchar({ length: 9 }).notNull().default('#234E8C'),
    teamId: uuid().references(() => teams.id, { onDelete: 'set null' }),
    ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    defaultBranch: varchar({ length: 200 }).notNull().default('main'),
    /** Where the code originally came from (import source label), kept for the archive. */
    sourceLabel: varchar({ length: 300 }).notNull().default(''),
    detection: jsonb().$type<DetectionResult | null>(),
    currentVersion: varchar({ length: 50 }),
    healthScore: integer(),
    securityScore: integer(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    archivedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('projects_org_slug_uq').on(t.organizationId, t.slug),
    index('projects_org_status_idx').on(t.organizationId, t.status),
    index('projects_created_idx').on(t.createdAt),
    check('projects_status_ck', oneOf('status', PROJECT_STATUSES)),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Optional project-specific role, adds to the member's organization roles inside this project. */
    roleId: uuid().references(() => roles.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user_idx').on(t.userId)],
);

export const projectManifests = pgTable(
  'project_manifests',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    source: varchar({ length: 30 }).notNull(),
    commitSha: varchar({ length: 40 }),
    content: jsonb().$type<Manifest>().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('project_manifests_version_uq').on(t.projectId, t.version),
    check('project_manifests_source_ck', oneOf('source', ['manual', 'detected', 'ai', 'repository'])),
  ],
);

export const repositories = pgTable(
  'repositories',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: varchar({ length: 30 }).notNull().default('internal'),
    /** Path relative to STORAGE_DIR/repos. */
    storageKey: varchar({ length: 300 }).notNull(),
    defaultBranch: varchar({ length: 200 }).notNull().default('main'),
    upstreamUrl: text(),
    upstreamSecretId: uuid(),
    status: varchar({ length: 30 }).$type<RepositoryStatus>().notNull().default('provisioning'),
    error: text(),
    sizeBytes: bigint({ mode: 'number' }).notNull().default(0),
    headCommit: varchar({ length: 40 }),
    lastPushedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('repositories_status_ck', oneOf('status', REPOSITORY_STATUSES))],
);

/** Work items: feedback conversions, hotfixes, security fixes, manual tasks (PH-812). */
export const tasks = pgTable(
  'tasks',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    title: varchar({ length: 200 }).notNull(),
    description: text().notNull().default(''),
    status: varchar({ length: 30 }).$type<TaskStatus>().notNull().default('todo'),
    priority: varchar({ length: 20 }).$type<Priority>().notNull().default('medium'),
    isHotfix: boolean().notNull().default(false),
    assigneeId: uuid().references(() => users.id, { onDelete: 'set null' }),
    sourceType: varchar({ length: 30 }),
    sourceId: uuid(),
    branch: varchar({ length: 200 }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    completedAt: ts(),
    /** Planned completion date (team board), YYYY-MM-DD. */
    dueDate: date({ mode: 'string' }),
    labels: jsonb().$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tasks_org_number_uq').on(t.organizationId, t.number),
    index('tasks_project_status_idx').on(t.projectId, t.status),
    check('tasks_status_ck', oneOf('status', TASK_STATUSES)),
    check('tasks_priority_ck', oneOf('priority', PRIORITIES)),
  ],
);

/** Gap-free human readable counters (build #1482, FB-142, PH-812, ...). scope = organization or project id. */
export const counters = pgTable(
  'counters',
  {
    scopeId: uuid().notNull(),
    name: varchar({ length: 40 }).notNull(),
    value: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scopeId, t.name] })],
);

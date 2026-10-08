import {
  bigint,
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
  DEPLOY_ADAPTERS,
  DEPLOYMENT_STATUSES,
  ENVIRONMENT_TYPES,
  HEALTH_STATUSES,
  STEP_STATUSES,
  VERSION_STATUSES,
  type DeployAdapter,
  type DeploymentStatus,
  type EnvironmentType,
  type HealthStatus,
  type StepStatus,
  type VersionStatus,
} from '@projecthub/contracts';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';
import { builds } from './builds.js';

export const environments = pgTable(
  'environments',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar({ length: 80 }).notNull(),
    slug: varchar({ length: 80 }).notNull(),
    type: varchar({ length: 20 }).$type<EnvironmentType>().notNull(),
    url: varchar({ length: 500 }).notNull().default(''),
    healthPath: varchar({ length: 300 }).notNull().default('/'),
    status: varchar({ length: 20 }).$type<HealthStatus>().notNull().default('unknown'),
    requiresApproval: boolean().notNull().default(false),
    requiredApprovals: integer().notNull().default(1),
    /** Run periodic health checks against url + healthPath and open incidents on failures. */
    monitor: boolean().notNull().default(false),
    consecutiveFailures: integer().notNull().default(0),
    currentVersionId: uuid(),
    currentDeploymentId: uuid(),
    lastHealthAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('environments_project_slug_uq').on(t.projectId, t.slug),
    check('environments_type_ck', oneOf('type', ENVIRONMENT_TYPES)),
    check('environments_status_ck', oneOf('status', HEALTH_STATUSES)),
  ],
);

export interface DeploymentTargetConfig {
  secure?: boolean;
  keepReleases?: number;
  postDeployCommand?: string;
  credentialType?: 'password' | 'private_key';
}

export const deploymentTargets = pgTable(
  'deployment_targets',
  {
    id: pk(),
    environmentId: uuid()
      .notNull()
      .unique()
      .references(() => environments.id, { onDelete: 'cascade' }),
    adapter: varchar({ length: 20 }).$type<DeployAdapter>().notNull(),
    host: varchar({ length: 255 }).notNull().default(''),
    port: integer(),
    username: varchar({ length: 150 }).notNull().default(''),
    remotePath: varchar({ length: 500 }).notNull(),
    credentialSecretId: uuid(),
    configuration: jsonb().$type<DeploymentTargetConfig>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('deployment_targets_adapter_ck', oneOf('adapter', DEPLOY_ADAPTERS))],
);

export interface DetectedMigration {
  path: string;
  name: string;
  checksum: string;
  risk: 'low' | 'medium' | 'high';
  operations: string[];
}

export const versions = pgTable(
  'versions',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: varchar({ length: 50 }).notNull(),
    commitSha: varchar({ length: 40 }).notNull(),
    buildId: uuid()
      .notNull()
      .references(() => builds.id, { onDelete: 'restrict' }),
    status: varchar({ length: 20 }).$type<VersionStatus>().notNull().default('draft'),
    releaseNotes: text().notNull().default(''),
    /** Migrations added since the previous version (detected from the repository). */
    migrations: jsonb().$type<DetectedMigration[]>().notNull().default([]),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    releasedAt: ts(),
  },
  (t) => [
    uniqueIndex('versions_project_version_uq').on(t.projectId, t.version),
    check('versions_status_ck', oneOf('status', VERSION_STATUSES)),
  ],
);

export const deployments = pgTable(
  'deployments',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    versionId: uuid()
      .notNull()
      .references(() => versions.id, { onDelete: 'restrict' }),
    number: integer().notNull(),
    status: varchar({ length: 30 }).$type<DeploymentStatus>().notNull(),
    adapter: varchar({ length: 20 }).$type<DeployAdapter>(),
    runMigrations: boolean().notNull().default(true),
    backup: boolean().notNull().default(true),
    isRollback: boolean().notNull().default(false),
    policyOverride: jsonb().$type<{ by: string; reason: string } | null>(),
    requestedByType: varchar({ length: 20 }).notNull().default('user'),
    requestedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    previousDeploymentId: uuid(),
    /** Remote release identifier written by the adapter (used for rollback). */
    releaseRef: varchar({ length: 200 }),
    error: text(),
    startedAt: ts(),
    finishedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('deployments_org_number_uq').on(t.organizationId, t.number),
    index('deployments_project_idx').on(t.projectId, t.createdAt),
    index('deployments_env_idx').on(t.environmentId, t.createdAt),
    check('deployments_status_ck', oneOf('status', DEPLOYMENT_STATUSES)),
  ],
);

export const deploymentSteps = pgTable(
  'deployment_steps',
  {
    id: pk(),
    deploymentId: uuid()
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    key: varchar({ length: 40 }).notNull(),
    name: varchar({ length: 100 }).notNull(),
    seq: integer().notNull(),
    status: varchar({ length: 20 }).$type<StepStatus>().notNull().default('pending'),
    output: text(),
    startedAt: ts(),
    finishedAt: ts(),
  },
  (t) => [
    uniqueIndex('deployment_steps_seq_uq').on(t.deploymentId, t.seq),
    check('deployment_steps_status_ck', oneOf('status', STEP_STATUSES)),
  ],
);

export const deploymentApprovals = pgTable(
  'deployment_approvals',
  {
    id: pk(),
    deploymentId: uuid()
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    decision: varchar({ length: 20 }).notNull(),
    comment: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('deployment_approvals_user_uq').on(t.deploymentId, t.userId),
    check('deployment_approvals_decision_ck', oneOf('decision', ['approved', 'rejected'])),
  ],
);

export const databaseConnections = pgTable(
  'database_connections',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid()
      .notNull()
      .unique()
      .references(() => environments.id, { onDelete: 'cascade' }),
    databaseType: varchar({ length: 20 }).notNull().default('postgresql'),
    host: varchar({ length: 255 }).notNull(),
    port: integer().notNull().default(5432),
    databaseName: varchar({ length: 120 }).notNull(),
    username: varchar({ length: 120 }).notNull(),
    passwordSecretId: uuid(),
    sslMode: varchar({ length: 20 }).notNull().default('prefer'),
    lastCheckedAt: ts(),
    lastCheckOk: boolean(),
    lastCheckMessage: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const backups = pgTable(
  'backups',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid().references(() => environments.id, { onDelete: 'set null' }),
    deploymentId: uuid(),
    versionLabel: varchar({ length: 50 }),
    type: varchar({ length: 20 }).notNull(),
    status: varchar({ length: 20 }).notNull().default('running'),
    /** STORAGE_DIR relative key (database dumps) or remote release path (file backups). */
    location: varchar({ length: 500 }),
    sizeBytes: bigint({ mode: 'number' }).notNull().default(0),
    checksum: varchar({ length: 64 }),
    error: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    verifiedAt: ts(),
    expiresAt: ts(),
  },
  (t) => [
    index('backups_project_idx').on(t.projectId, t.createdAt),
    check('backups_type_ck', oneOf('type', ['database', 'files'])),
    check('backups_status_ck', oneOf('status', ['running', 'completed', 'failed'])),
  ],
);

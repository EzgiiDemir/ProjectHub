import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  BUILD_STATUSES,
  DEVICE_CATEGORIES,
  PREVIEW_KINDS,
  PREVIEW_STATUSES,
  STEP_STATUSES,
  type BuildStatus,
  type DeviceCategory,
  type Manifest,
  type PreviewKind,
  type PreviewStatus,
  type StepStatus,
} from '@projecthub/contracts';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

export interface BuildError {
  step: string;
  file?: string;
  line?: number;
  message: string;
}

export const artifacts = pgTable(
  'artifacts',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    buildId: uuid(),
    type: varchar({ length: 30 }).notNull(),
    /** Path relative to STORAGE_DIR/artifacts. A directory for build outputs, a file otherwise. */
    storageKey: varchar({ length: 500 }).notNull(),
    fileName: varchar({ length: 255 }).notNull(),
    contentType: varchar({ length: 120 }).notNull().default('application/octet-stream'),
    sizeBytes: bigint({ mode: 'number' }).notNull().default(0),
    checksum: varchar({ length: 64 }),
    /** NULL = keep forever (releases, source). */
    retentionUntil: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('artifacts_project_idx').on(t.projectId),
    index('artifacts_retention_idx').on(t.retentionUntil),
    check(
      'artifacts_type_ck',
      oneOf('type', ['build', 'release', 'screenshot', 'report', 'backup', 'log', 'upload', 'diff']),
    ),
  ],
);

export const builds = pgTable(
  'builds',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    branch: varchar({ length: 200 }).notNull(),
    commitSha: varchar({ length: 40 }).notNull(),
    commitMessage: text().notNull().default(''),
    trigger: varchar({ length: 30 }).notNull().default('manual'),
    triggeredByType: varchar({ length: 20 }).notNull().default('user'),
    triggeredBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    status: varchar({ length: 20 }).$type<BuildStatus>().notNull().default('queued'),
    manifest: jsonb().$type<Manifest>(),
    error: jsonb().$type<BuildError | null>(),
    aiAnalysis: text(),
    artifactId: uuid().references(() => artifacts.id, { onDelete: 'set null' }),
    /** Static (directory) or process (needs start command) output. */
    outputKind: varchar({ length: 20 }),
    /** Path relative to STORAGE_DIR for the build log file. */
    logKey: varchar({ length: 300 }),
    createPreview: boolean().notNull().default(false),
    startedAt: ts(),
    finishedAt: ts(),
    durationMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('builds_project_number_uq').on(t.projectId, t.number),
    index('builds_project_created_idx').on(t.projectId, t.createdAt),
    index('builds_status_idx').on(t.status),
    check('builds_status_ck', oneOf('status', BUILD_STATUSES)),
  ],
);

export const buildSteps = pgTable(
  'build_steps',
  {
    id: pk(),
    buildId: uuid()
      .notNull()
      .references(() => builds.id, { onDelete: 'cascade' }),
    key: varchar({ length: 40 }).notNull(),
    name: varchar({ length: 100 }).notNull(),
    seq: integer().notNull(),
    status: varchar({ length: 20 }).$type<StepStatus>().notNull().default('pending'),
    exitCode: integer(),
    summary: text(),
    startedAt: ts(),
    finishedAt: ts(),
  },
  (t) => [uniqueIndex('build_steps_seq_uq').on(t.buildId, t.seq), check('build_steps_status_ck', oneOf('status', STEP_STATUSES))],
);

export const previews = pgTable(
  'previews',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    buildId: uuid()
      .notNull()
      .references(() => builds.id, { onDelete: 'cascade' }),
    /** DNS label used for {slug}.{PREVIEW_BASE_DOMAIN}. */
    slug: varchar({ length: 63 }).notNull().unique(),
    kind: varchar({ length: 20 }).$type<PreviewKind>().notNull(),
    status: varchar({ length: 20 }).$type<PreviewStatus>().notNull().default('queued'),
    spa: boolean().notNull().default(false),
    /** Static previews: artifact directory key. Process previews: working directory key. */
    rootKey: varchar({ length: 500 }),
    internalPort: integer(),
    processId: integer(),
    /** Identifies the worker instance that owns the process (for restart reconciliation). */
    runnerId: varchar({ length: 100 }),
    sourceBranch: varchar({ length: 200 }).notNull(),
    sourceCommit: varchar({ length: 40 }).notNull(),
    error: text(),
    expiresAt: ts().notNull(),
    stoppedAt: ts(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('previews_project_idx').on(t.projectId, t.createdAt),
    index('previews_status_expiry_idx').on(t.status, t.expiresAt),
    check('previews_status_ck', oneOf('status', PREVIEW_STATUSES)),
    check('previews_kind_ck', oneOf('kind', PREVIEW_KINDS)),
  ],
);

export const deviceProfiles = pgTable(
  'device_profiles',
  {
    id: pk(),
    key: varchar({ length: 40 }).notNull().unique(),
    name: varchar({ length: 100 }).notNull(),
    category: varchar({ length: 20 }).$type<DeviceCategory>().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    scaleFactor: real().notNull().default(1),
    isMobile: boolean().notNull().default(false),
    userAgent: text(),
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    sort: integer().notNull().default(0),
  },
  (t) => [check('device_profiles_category_ck', oneOf('category', DEVICE_CATEGORIES))],
);

export interface ResponsiveIssue {
  code: 'horizontal_overflow' | 'console_error' | 'failed_request' | 'page_error' | 'load_failed' | 'offscreen_cta';
  message: string;
}

export const responsiveTests = pgTable(
  'responsive_tests',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    previewId: uuid()
      .notNull()
      .references(() => previews.id, { onDelete: 'cascade' }),
    baselineTestId: uuid(),
    status: varchar({ length: 20 }).notNull().default('queued'),
    paths: jsonb().$type<string[]>().notNull().default(['/']),
    summary: jsonb().$type<{ passed: number; warning: number; failed: number; total: number } | null>(),
    error: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [
    index('responsive_tests_project_idx').on(t.projectId, t.createdAt),
    check('responsive_tests_status_ck', oneOf('status', ['queued', 'running', 'completed', 'failed'])),
  ],
);

export const responsiveTestResults = pgTable(
  'responsive_test_results',
  {
    id: pk(),
    testId: uuid()
      .notNull()
      .references(() => responsiveTests.id, { onDelete: 'cascade' }),
    deviceKey: varchar({ length: 40 }).notNull(),
    deviceName: varchar({ length: 100 }).notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    path: varchar({ length: 300 }).notNull(),
    status: varchar({ length: 20 }).notNull(),
    issues: jsonb().$type<ResponsiveIssue[]>().notNull().default([]),
    screenshotArtifactId: uuid().references(() => artifacts.id, { onDelete: 'set null' }),
    diffArtifactId: uuid().references(() => artifacts.id, { onDelete: 'set null' }),
    /** Visual regression: fraction of pixels that changed against the baseline (0..1). */
    diffRatio: real(),
    loadMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index('responsive_results_test_idx').on(t.testId),
    check('responsive_results_status_ck', oneOf('status', ['passed', 'warning', 'failed'])),
  ],
);

export const uploads = pgTable('uploads', {
  id: pk(),
  organizationId: uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  fileName: varchar({ length: 255 }).notNull(),
  storageKey: varchar({ length: 500 }).notNull(),
  sizeBytes: bigint({ mode: 'number' }).notNull(),
  /** Detection result computed from the uploaded archive (shown in the import wizard). */
  detection: jsonb(),
  fileCount: integer().notNull().default(0),
  consumedAt: ts(),
  expiresAt: ts().notNull(),
  createdAt: createdAt(),
});

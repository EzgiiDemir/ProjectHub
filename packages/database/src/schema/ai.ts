import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  AI_TASK_STATUSES,
  AI_TASK_TYPES,
  type AiAutonomyLevel,
  type AiTaskStatus,
  type AiTaskType,
} from '@projecthub/contracts';
import { createdAt, oneOf, pk, ts, tsvector, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

export interface AiCitation {
  type: 'file' | 'build' | 'deployment' | 'feedback' | 'finding' | 'commit' | 'doc' | 'memory';
  ref: string;
  label: string;
  line?: number;
}

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar({ length: 200 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_conversations_user_idx').on(t.projectId, t.userId, t.updatedAt)],
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: pk(),
    conversationId: uuid()
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: varchar({ length: 20 }).notNull(),
    content: text().notNull(),
    citations: jsonb().$type<AiCitation[]>().notNull().default([]),
    model: varchar({ length: 100 }),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt),
    check('ai_messages_role_ck', oneOf('role', ['user', 'assistant'])),
  ],
);

export interface AiTaskResult {
  summary: string;
  explanation: string[];
  filesChanged: { path: string; additions: number; deletions: number }[];
  commitSha?: string;
  buildStatus?: string;
  previewUrl?: string;
}

export const aiTasks = pgTable(
  'ai_tasks',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    type: varchar({ length: 30 }).$type<AiTaskType>().notNull(),
    title: varchar({ length: 200 }).notNull(),
    instruction: text().notNull().default(''),
    status: varchar({ length: 30 }).$type<AiTaskStatus>().notNull().default('queued'),
    autonomyLevel: varchar({ length: 5 }).$type<AiAutonomyLevel>().notNull(),
    sourceType: varchar({ length: 30 }),
    sourceId: uuid(),
    baseBranch: varchar({ length: 200 }),
    branch: varchar({ length: 200 }),
    baseCommit: varchar({ length: 40 }),
    headCommit: varchar({ length: 40 }),
    buildId: uuid(),
    previewId: uuid(),
    result: jsonb().$type<AiTaskResult | null>(),
    error: text(),
    requestedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    decisionComment: text(),
    startedAt: ts(),
    completedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ai_tasks_org_number_uq').on(t.organizationId, t.number),
    index('ai_tasks_project_idx').on(t.projectId, t.createdAt),
    check('ai_tasks_status_ck', oneOf('status', AI_TASK_STATUSES)),
    check('ai_tasks_type_ck', oneOf('type', AI_TASK_TYPES)),
  ],
);

/** One model invocation sequence (a run of an agent). Token usage is accounted here for budgets. */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid().references(() => aiTasks.id, { onDelete: 'cascade' }),
    purpose: varchar({ length: 40 }).notNull(),
    provider: varchar({ length: 20 }).notNull(),
    model: varchar({ length: 100 }).notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    status: varchar({ length: 20 }).notNull().default('running'),
    error: text(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    startedAt: ts().notNull().defaultNow(),
    finishedAt: ts(),
  },
  (t) => [index('ai_runs_org_started_idx').on(t.organizationId, t.startedAt)],
);

/** Every tool call an AI agent attempted, with the policy decision. Immutable trail of AI behaviour. */
export const aiActions = pgTable(
  'ai_actions',
  {
    id: pk(),
    runId: uuid()
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    taskId: uuid().references(() => aiTasks.id, { onDelete: 'cascade' }),
    action: varchar({ length: 60 }).notNull(),
    resource: varchar({ length: 500 }),
    riskLevel: varchar({ length: 20 }).notNull(),
    decision: varchar({ length: 20 }).notNull(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_actions_task_idx').on(t.taskId, t.createdAt),
    check('ai_actions_decision_ck', oneOf('decision', ['allowed', 'denied'])),
  ],
);

/** Incremental code index: one row per indexed file blob. */
export const codeFiles = pgTable(
  'code_files',
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: varchar({ length: 500 }).notNull(),
    blobSha: varchar({ length: 40 }).notNull(),
    language: varchar({ length: 30 }).notNull(),
    lines: integer().notNull(),
    symbols: jsonb().$type<string[]>().notNull().default([]),
    indexedCommit: varchar({ length: 40 }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.path] })],
);

/** Searchable chunks of source files (PostgreSQL full text search) used for retrieval by the Project Brain. */
export const codeChunks = pgTable(
  'code_chunks',
  {
    id: pk(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: varchar({ length: 500 }).notNull(),
    startLine: integer().notNull(),
    endLine: integer().notNull(),
    content: text().notNull(),
    /** Locally generated semantic vector. PostgreSQL arrays keep this feature pgvector-independent. */
    embedding: real().array(),
    embeddingModel: varchar({ length: 150 }),
    searchVector: tsvector().generatedAlwaysAs(
      // Index the raw text plus a copy with camelCase / path separators split, so "CheckoutButton.tsx" matches "checkout button".
      sql`to_tsvector('simple', path || ' ' || content || ' ' || regexp_replace(path || ' ' || content, '([a-z])([A-Z])|[_./\\-]', '\\1 \\2', 'g'))`,
    ),
  },
  (t) => [
    index('code_chunks_project_path_idx').on(t.projectId, t.path),
    index('code_chunks_search_idx').using('gin', t.searchVector),
  ],
);

/** Durable, human-inspectable project knowledge. Source code itself remains in code_chunks, not duplicated here. */
export const aiMemories = pgTable(
  'ai_memories',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    category: varchar({ length: 30 }).notNull(),
    title: varchar({ length: 200 }).notNull(),
    content: text().notNull(),
    verification: varchar({ length: 20 }).notNull().default('inferred'),
    sourceType: varchar({ length: 30 }).notNull(),
    sourceRef: varchar({ length: 500 }),
    sourceLabel: varchar({ length: 300 }),
    createdByType: varchar({ length: 20 }).notNull().default('system'),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', title || ' ' || content || ' ' || coalesce(source_label, ''))`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ai_memories_project_updated_idx').on(t.projectId, t.updatedAt),
    index('ai_memories_search_idx').using('gin', t.searchVector),
    uniqueIndex('ai_memories_source_uq').on(t.projectId, t.sourceType, t.sourceRef),
    check('ai_memories_category_ck', oneOf('category', ['architecture', 'decision', 'convention', 'bug', 'task_outcome', 'fact'])),
    check('ai_memories_verification_ck', oneOf('verification', ['verified', 'inferred', 'historical'])),
    check('ai_memories_created_by_type_ck', oneOf('created_by_type', ['user', 'ai', 'system'])),
  ],
);

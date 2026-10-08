import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  PRIORITIES,
  type FeedbackStatus,
  type FeedbackType,
  type Priority,
  type ReviewCapabilities,
} from '@projecthub/contracts';
import { createdAt, inet, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects, tasks } from './projects.js';
import { artifacts, builds, previews } from './builds.js';

export const reviewSessions = pgTable(
  'review_sessions',
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
      .references(() => previews.id, { onDelete: 'restrict' }),
    number: integer().notNull(),
    name: varchar({ length: 150 }).notNull(),
    versionLabel: varchar({ length: 60 }).notNull().default(''),
    /** sha256(token) used for lookups. */
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    /** AES-GCM encrypted raw token so authorized team members can copy the link again. */
    tokenEncrypted: text().notNull(),
    passwordHash: text(),
    capabilities: jsonb().$type<ReviewCapabilities>().notNull(),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    revokedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastAccessAt: ts(),
    accessCount: integer().notNull().default(0),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('review_sessions_org_number_uq').on(t.organizationId, t.number),
    index('review_sessions_project_idx').on(t.projectId, t.createdAt),
  ],
);

/** A person who opened a review link. Customers have no account; identity is self-declared (name + department). */
export const reviewVisitors = pgTable(
  'review_visitors',
  {
    id: pk(),
    reviewSessionId: uuid()
      .notNull()
      .references(() => reviewSessions.id, { onDelete: 'cascade' }),
    firstName: varchar({ length: 80 }).notNull(),
    lastName: varchar({ length: 80 }).notNull(),
    department: varchar({ length: 120 }).notNull(),
    company: varchar({ length: 150 }).notNull().default(''),
    email: varchar({ length: 255 }).notNull().default(''),
    /** sha256 of the visitor cookie token. */
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    ipAddress: inet(),
    userAgent: text(),
    lastSeenAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('review_visitors_session_idx').on(t.reviewSessionId)],
);

export interface FeedbackTriage {
  summary: string;
  category: string;
  severity: Priority;
  likelyFiles: string[];
  suggestedTitle?: string;
  model?: string;
}

export const feedback = pgTable(
  'feedback',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    reviewSessionId: uuid().references(() => reviewSessions.id, { onDelete: 'set null' }),
    number: integer().notNull(),
    type: varchar({ length: 30 }).$type<FeedbackType>().notNull().default('change_request'),
    title: varchar({ length: 200 }).notNull(),
    body: text().notNull().default(''),
    status: varchar({ length: 30 }).$type<FeedbackStatus>().notNull().default('open'),
    priority: varchar({ length: 20 }).$type<Priority>().notNull().default('medium'),
    category: varchar({ length: 60 }).notNull().default(''),
    pageUrl: varchar({ length: 1000 }).notNull().default('/'),
    viewportWidth: integer(),
    viewportHeight: integer(),
    scrollY: integer().notNull().default(0),
    x: integer(),
    y: integer(),
    domSelector: varchar({ length: 500 }),
    deviceKey: varchar({ length: 40 }),
    browser: varchar({ length: 120 }),
    operatingSystem: varchar({ length: 120 }),
    userAgent: text(),
    versionLabel: varchar({ length: 60 }),
    buildId: uuid().references(() => builds.id, { onDelete: 'set null' }),
    previewId: uuid().references(() => previews.id, { onDelete: 'set null' }),
    reporterType: varchar({ length: 20 }).notNull(),
    reporterVisitorId: uuid().references(() => reviewVisitors.id, { onDelete: 'set null' }),
    reporterUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    assignedUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
    triage: jsonb().$type<FeedbackTriage | null>(),
    /** Files matched by code search for the feedback text/selector (deterministic, no AI needed). */
    relatedFiles: jsonb().$type<{ path: string; line: number; snippet: string }[]>().notNull().default([]),
    resolvedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('feedback_org_number_uq').on(t.organizationId, t.number),
    index('feedback_project_status_idx').on(t.projectId, t.status),
    index('feedback_review_idx').on(t.reviewSessionId),
    check('feedback_status_ck', oneOf('status', FEEDBACK_STATUSES)),
    check('feedback_type_ck', oneOf('type', FEEDBACK_TYPES)),
    check('feedback_priority_ck', oneOf('priority', PRIORITIES)),
    check('feedback_reporter_ck', oneOf('reporter_type', ['customer', 'user'])),
  ],
);

export const feedbackComments = pgTable(
  'feedback_comments',
  {
    id: pk(),
    feedbackId: uuid()
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    authorType: varchar({ length: 20 }).notNull(),
    authorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    authorVisitorId: uuid().references(() => reviewVisitors.id, { onDelete: 'set null' }),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('feedback_comments_feedback_idx').on(t.feedbackId),
    check('feedback_comments_author_ck', oneOf('author_type', ['user', 'customer', 'ai', 'system'])),
  ],
);

export const feedbackAttachments = pgTable('feedback_attachments', {
  id: pk(),
  feedbackId: uuid()
    .notNull()
    .references(() => feedback.id, { onDelete: 'cascade' }),
  artifactId: uuid()
    .notNull()
    .references(() => artifacts.id, { onDelete: 'cascade' }),
  kind: varchar({ length: 20 }).notNull().default('screenshot'),
  createdAt: createdAt(),
});

export const reviewMessages = pgTable(
  'review_messages',
  {
    id: pk(),
    reviewSessionId: uuid()
      .notNull()
      .references(() => reviewSessions.id, { onDelete: 'cascade' }),
    authorType: varchar({ length: 20 }).notNull(),
    visitorId: uuid().references(() => reviewVisitors.id, { onDelete: 'set null' }),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('review_messages_session_idx').on(t.reviewSessionId, t.createdAt),
    check('review_messages_author_ck', oneOf('author_type', ['customer', 'user'])),
  ],
);

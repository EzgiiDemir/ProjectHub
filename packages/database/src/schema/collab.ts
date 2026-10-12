import { check, index, integer, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

export const PULL_REQUEST_STATUSES = ['open', 'merged', 'closed'] as const;
export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number];

/** Pull requests: proposed merge of a source branch into a target branch, reviewed before merging (spec §33, §104). */
export const pullRequests = pgTable(
  'pull_requests',
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
    sourceBranch: varchar({ length: 200 }).notNull(),
    targetBranch: varchar({ length: 200 }).notNull(),
    status: varchar({ length: 20 }).$type<PullRequestStatus>().notNull().default('open'),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    mergedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    mergeCommit: varchar({ length: 40 }),
    mergedAt: ts(),
    closedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pull_requests_number_uq').on(t.projectId, t.number),
    index('pull_requests_status_idx').on(t.projectId, t.status),
    check('pull_requests_status_ck', oneOf('status', PULL_REQUEST_STATUSES)),
  ],
);

/** Review decisions. Only the latest decision per reviewer counts, and only if made on the current head commit. */
export const pullRequestReviews = pgTable(
  'pull_request_reviews',
  {
    id: pk(),
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    decision: varchar({ length: 20 }).notNull(),
    body: text().notNull().default(''),
    commitSha: varchar({ length: 40 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('pr_reviews_pr_idx').on(t.pullRequestId), check('pr_reviews_decision_ck', oneOf('decision', ['approved', 'changes_requested']))],
);

/** Discussion, optionally anchored to a file line of the diff. */
export const pullRequestComments = pgTable(
  'pull_request_comments',
  {
    id: pk(),
    pullRequestId: uuid()
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    authorType: varchar({ length: 20 }).notNull().default('user'),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    body: text().notNull(),
    path: varchar({ length: 500 }),
    line: integer(),
    createdAt: createdAt(),
  },
  (t) => [index('pr_comments_pr_idx').on(t.pullRequestId), check('pr_comments_author_ck', oneOf('author_type', ['user', 'ai', 'system']))],
);

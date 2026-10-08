import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { USER_STATUSES, type UserStatus } from '@projecthub/contracts';
import { createdAt, inet, oneOf, pk, ts, updatedAt } from './_helpers.js';

export const organizations = pgTable('organizations', {
  id: pk(),
  name: varchar({ length: 150 }).notNull(),
  slug: varchar({ length: 100 }).notNull().unique(),
  status: varchar({ length: 30 }).notNull().default('active'),
  /** Organization-wide settings: ai, retention, branding. Validated by the API before write. */
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: varchar({ length: 255 }).notNull(),
    passwordHash: text(),
    displayName: varchar({ length: 150 }).notNull(),
    title: varchar({ length: 120 }).notNull().default(''),
    avatarColor: varchar({ length: 9 }).notNull().default('#234E8C'),
    status: varchar({ length: 30 }).$type<UserStatus>().notNull().default('invited'),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: ts(),
    emailVerifiedAt: ts(),
    lastLoginAt: ts(),
    lastActivityAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`), check('users_status_ck', oneOf('status', USER_STATUSES))],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar({ length: 30 }).notNull().default('active'),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index('org_members_user_idx').on(t.userId)],
);

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    /** NULL = built-in system role shared by every organization. */
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    key: varchar({ length: 100 }).notNull(),
    name: varchar({ length: 100 }).notNull(),
    description: text().notNull().default(''),
    isSystem: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_org_key_uq').on(sql`coalesce(${t.organizationId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.key)],
);

export const permissions = pgTable('permissions', {
  key: varchar({ length: 150 }).primaryKey(),
  groupName: varchar({ length: 100 }).notNull(),
  description: text().notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: varchar({ length: 150 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const organizationMemberRoles = pgTable(
  'organization_member_roles',
  {
    organizationId: uuid().notNull(),
    userId: uuid().notNull(),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.roleId] }),
    index('org_member_roles_user_idx').on(t.userId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar({ length: 100 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('teams_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** sha256 of the raw cookie token. The raw token is never stored. */
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    ipAddress: inet(),
    userAgent: text(),
    expiresAt: ts().notNull(),
    lastSeenAt: ts().notNull().defaultNow(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** One-time tokens for invitations and password resets. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    purpose: varchar({ length: 30 }).notNull(),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [check('user_tokens_purpose_ck', oneOf('purpose', ['invite', 'password_reset']))],
);

/** Personal access tokens for Git over HTTP and API automation. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar({ length: 100 }).notNull(),
    prefix: varchar({ length: 16 }).notNull(),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    lastUsedAt: ts(),
    expiresAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
);

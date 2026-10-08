import { check, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import {
  FINDING_STATUSES,
  FINDING_TYPES,
  SECRET_KINDS,
  SECRET_SCOPES,
  SEVERITIES,
  type FindingStatus,
  type FindingType,
  type SecretKind,
  type SecretScope,
  type Severity,
} from '@projecthub/contracts';
import { createdAt, oneOf, pk, ts, updatedAt } from './_helpers.js';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';
import { environments } from './deploy.js';

/** Encrypted secret store (AES-256-GCM). Plain values never touch logs or API responses unless explicitly revealed. */
export const secrets = pgTable(
  'secrets',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
    environmentId: uuid().references(() => environments.id, { onDelete: 'cascade' }),
    name: varchar({ length: 120 }).notNull(),
    kind: varchar({ length: 20 }).$type<SecretKind>().notNull().default('env'),
    scope: varchar({ length: 20 }).$type<SecretScope>().notNull().default('runtime'),
    /** System secrets (deploy credentials, upstream tokens) are managed by their owning feature, hidden from env lists. */
    system: varchar({ length: 40 }),
    ciphertext: text().notNull(),
    iv: varchar({ length: 32 }).notNull(),
    authTag: varchar({ length: 32 }).notNull(),
    keyVersion: integer().notNull().default(1),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastAccessedAt: ts(),
    rotatedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('secrets_scope_name_uq').on(t.organizationId, t.projectId, t.environmentId, t.name).nullsNotDistinct(),
    check('secrets_kind_ck', oneOf('kind', SECRET_KINDS)),
    check('secrets_scope_ck', oneOf('scope', SECRET_SCOPES)),
  ],
);

export const securityScans = pgTable(
  'security_scans',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    buildId: uuid(),
    commitSha: varchar({ length: 40 }),
    branch: varchar({ length: 200 }),
    status: varchar({ length: 20 }).notNull().default('queued'),
    score: integer(),
    summary: jsonb().$type<{
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
      byType: Record<string, number>;
      packagesScanned: number;
      filesScanned: number;
      breakdown: Record<string, number>;
      notes: string[];
    } | null>(),
    error: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    startedAt: ts(),
    finishedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('security_scans_project_idx').on(t.projectId, t.createdAt),
    check('security_scans_status_ck', oneOf('status', ['queued', 'running', 'completed', 'failed'])),
  ],
);

export const securityFindings = pgTable(
  'security_findings',
  {
    id: pk(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    lastScanId: uuid()
      .notNull()
      .references(() => securityScans.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    severity: varchar({ length: 20 }).$type<Severity>().notNull(),
    type: varchar({ length: 20 }).$type<FindingType>().notNull(),
    ruleId: varchar({ length: 120 }).notNull(),
    title: varchar({ length: 300 }).notNull(),
    description: text().notNull().default(''),
    filePath: varchar({ length: 500 }),
    line: integer(),
    packageName: varchar({ length: 214 }),
    packageVersion: varchar({ length: 100 }),
    fixedVersion: varchar({ length: 100 }),
    advisoryId: varchar({ length: 100 }),
    references: jsonb().$type<string[]>().notNull().default([]),
    status: varchar({ length: 20 }).$type<FindingStatus>().notNull().default('open'),
    /** Stable identity across scans: same issue => same fingerprint. */
    fingerprint: varchar({ length: 64 }).notNull(),
    statusReason: text(),
    statusChangedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    firstSeenAt: ts().notNull().defaultNow(),
    lastSeenAt: ts().notNull().defaultNow(),
    resolvedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('security_findings_fp_uq').on(t.projectId, t.fingerprint),
    uniqueIndex('security_findings_org_number_uq').on(t.organizationId, t.number),
    index('security_findings_open_idx').on(t.organizationId, t.status, t.severity),
    check('security_findings_severity_ck', oneOf('severity', SEVERITIES)),
    check('security_findings_type_ck', oneOf('type', FINDING_TYPES)),
    check('security_findings_status_ck', oneOf('status', FINDING_STATUSES)),
  ],
);

import { z } from 'zod';
import {
  AI_AUTONOMY_LEVELS,
  AI_PROVIDERS,
  DEPLOY_ADAPTERS,
  DOMAIN_EVENTS,
  ENVIRONMENT_TYPES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  FINDING_STATUSES,
  PRIORITIES,
  PROJECT_STATUSES,
  SECRET_KINDS,
  SECRET_SCOPES,
  TASK_STATUSES,
} from './enums.js';
import { ALL_PERMISSIONS, type Permission } from './permissions.js';

const uuid = z.uuid();
const trimmed = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1, 'Zorunlu alan').max(max);
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Yalnızca küçük harf, rakam ve tire kullanılabilir');
export const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._\/-]+(?<!\/)$/, 'Geçersiz branch adı');
export const passwordSchema = z
  .string()
  .min(12, 'Şifre en az 12 karakter olmalı')
  .max(256)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), 'Şifre harf ve rakam içermeli');

/* ---------------- auth ---------------- */
export const loginSchema = z.object({
  email: z.email('Geçerli bir e-posta girin').max(255),
  password: z.string().min(1).max(256),
});
export const acceptInviteSchema = z.object({
  token: required(200),
  displayName: required(150).optional(),
  password: passwordSchema,
});
export const requestPasswordResetSchema = z.object({ email: z.email().max(255) });
export const resetPasswordSchema = z.object({ token: required(200), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });
export const updateProfileSchema = z.object({
  displayName: required(150).optional(),
  title: trimmed(120).optional(),
});
export const createApiTokenSchema = z.object({
  name: required(100),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

/* ---------------- users / roles ---------------- */
export const inviteUserSchema = z.object({
  email: z.email().max(255),
  displayName: required(150),
  roleIds: z.array(uuid).min(1, 'En az bir rol seçin').max(10),
});
export const updateUserSchema = z.object({
  displayName: required(150).optional(),
  title: trimmed(120).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  roleIds: z.array(uuid).min(1).max(10).optional(),
});
const permissionKey = z.string().refine((v): v is Permission => (ALL_PERMISSIONS as string[]).includes(v), 'Bilinmeyen yetki');
export const upsertRoleSchema = z.object({
  name: required(100),
  description: trimmed(500).default(''),
  permissions: z.array(permissionKey).max(ALL_PERMISSIONS.length),
});
export const createTeamSchema = z.object({ name: required(100) });

/* ---------------- projects ---------------- */
export const createProjectSchema = z.object({
  name: required(150),
  slug: slugSchema,
  description: trimmed(2000).default(''),
  customerName: trimmed(150).default(''),
  teamId: uuid.nullable().default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  defaultBranch: branchNameSchema.default('main'),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('empty') }),
    z.object({
      type: z.literal('git'),
      url: z.url().max(500),
      branch: branchNameSchema.optional(),
      /** Optional access token for private repositories. Stored encrypted, never returned. */
      accessToken: trimmed(500).optional(),
    }),
    /** Upload id returned by POST /uploads (ZIP of the project folder). */
    z.object({ type: z.literal('upload'), uploadId: uuid }),
  ]),
  createDefaultEnvironments: z.boolean().default(true),
});
export const updateProjectSchema = z.object({
  name: required(150).optional(),
  description: trimmed(2000).optional(),
  customerName: trimmed(150).optional(),
  teamId: uuid.nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: z.enum(PROJECT_STATUSES).exclude(['archived']).optional(),
});
export const projectListQuerySchema = z.object({
  status: z.enum([...PROJECT_STATUSES, 'all']).default('all'),
  search: trimmed(200).optional(),
  teamId: uuid.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  technology: trimmed(60).optional(),
});
export const addProjectMemberSchema = z.object({ userId: uuid, roleId: uuid.nullable().default(null) });
export const archiveProjectSchema = z.object({ confirmSlug: required(150) });

/* ---------------- repository ---------------- */
export const commitFilesSchema = z.object({
  branch: branchNameSchema,
  /** Commit the change on top of this commit; rejects when the branch moved (optimistic concurrency). */
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  message: required(500),
  changes: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('upsert'), path: required(500), content: z.string().max(2_000_000) }),
        z.object({ action: z.literal('delete'), path: required(500) }),
      ]),
    )
    .min(1)
    .max(200),
});
export const createBranchSchema = z.object({ name: branchNameSchema, from: z.string().trim().min(1).max(200) });
export const mergeBranchSchema = z.object({
  source: branchNameSchema,
  target: branchNameSchema,
  message: trimmed(500).optional(),
});

/* ---------------- builds / previews ---------------- */
export const createBuildSchema = z.object({
  branch: branchNameSchema.optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  createPreview: z.boolean().default(false),
});
export const createPreviewSchema = z.object({
  buildId: uuid,
  ttlMinutes: z.number().int().min(15).max(60 * 24 * 14).optional(),
});
export const responsiveTestSchema = z.object({
  previewId: uuid,
  deviceKeys: z.array(z.string().max(40)).min(1).max(30).optional(),
  paths: z.array(z.string().startsWith('/').max(300)).min(1).max(10).default(['/']),
  baselineTestId: uuid.optional(),
});

/* ---------------- reviews / feedback ---------------- */
export const reviewCapabilitiesSchema = z.object({
  feedback: z.boolean().default(true),
  screenshots: z.boolean().default(true),
  deviceSwitch: z.boolean().default(true),
  chat: z.boolean().default(true),
  docs: z.boolean().default(true),
});
export type ReviewCapabilities = z.infer<typeof reviewCapabilitiesSchema>;
export const createReviewSchema = z
  .object({
    previewId: uuid,
    name: required(150),
    expiresInMinutes: z.number().int().min(15).max(60 * 24 * 30).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    password: z.string().min(6).max(128).optional(),
    capabilities: reviewCapabilitiesSchema.default({
      feedback: true,
      screenshots: true,
      deviceSwitch: true,
      chat: true,
      docs: true,
    }),
  })
  .refine((v) => v.expiresInMinutes || v.expiresAt, { message: 'Geçerlilik süresi seçin', path: ['expiresInMinutes'] });

export const reviewerIdentitySchema = z.object({
  firstName: required(80),
  lastName: required(80),
  department: required(120),
  company: trimmed(150).default(''),
  email: z.union([z.email().max(255), z.literal('')]).default(''),
  password: z.string().max(128).optional(),
});
export const publicFeedbackSchema = z.object({
  type: z.enum(FEEDBACK_TYPES).default('change_request'),
  title: required(200),
  body: trimmed(5000).default(''),
  pageUrl: required(1000),
  viewport: z.object({ width: z.number().int().min(100).max(8000), height: z.number().int().min(100).max(8000) }),
  scrollY: z.number().int().min(0).max(1_000_000).default(0),
  coordinates: z.object({ x: z.number().min(0).max(10000), y: z.number().min(0).max(1_000_000) }).optional(),
  domSelector: trimmed(500).optional(),
  deviceKey: trimmed(40).optional(),
  captureScreenshot: z.boolean().default(true),
});
export const publicFeedbackDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), comment: trimmed(2000).optional() });
export const chatMessageSchema = z.object({ body: required(4000) });

export const updateFeedbackSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: trimmed(60).optional(),
  assignedUserId: uuid.nullable().optional(),
});
export const feedbackCommentSchema = z.object({ body: required(5000) });
export const feedbackToTaskSchema = z.object({
  title: required(200).optional(),
  assigneeId: uuid.nullable().optional(),
  hotfix: z.boolean().default(false),
});

export const createTaskSchema = z.object({
  title: required(200),
  description: trimmed(10000).default(''),
  priority: z.enum(PRIORITIES).default('medium'),
  assigneeId: uuid.nullable().default(null),
});
export const updateTaskSchema = z.object({
  title: required(200).optional(),
  description: trimmed(10000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: uuid.nullable().optional(),
  branch: branchNameSchema.nullable().optional(),
});

/* ---------------- environments / deploy ---------------- */
export const upsertEnvironmentSchema = z.object({
  name: required(80),
  slug: slugSchema,
  type: z.enum(ENVIRONMENT_TYPES),
  url: z.union([z.url().max(500), z.literal('')]).default(''),
  healthPath: z.string().startsWith('/').max(300).default('/'),
  requiresApproval: z.boolean().default(false),
  requiredApprovals: z.number().int().min(1).max(5).default(1),
  monitor: z.boolean().default(false),
});
export const deploymentTargetSchema = z.object({
  adapter: z.enum(DEPLOY_ADAPTERS),
  host: trimmed(255).default(''),
  port: z.number().int().min(1).max(65535).optional(),
  username: trimmed(150).default(''),
  /** Plain password / private key. Encrypted into the secret store; never returned. Omit to keep current. */
  credential: z.string().max(20000).optional(),
  credentialType: z.enum(['password', 'private_key']).default('password'),
  remotePath: required(500),
  secure: z.boolean().default(false),
  keepReleases: z.number().int().min(1).max(20).default(3),
  postDeployCommand: trimmed(2000).optional(),
});
export const createVersionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Semver biçiminde olmalı (ör. 2.8.4)'),
  buildId: uuid,
  releaseNotes: trimmed(20000).default(''),
});
export const createDeploymentSchema = z.object({
  environmentId: uuid,
  versionId: uuid,
  runMigrations: z.boolean().default(true),
  backup: z.boolean().default(true),
  /** Required by policy when open critical security findings exist (needs security.manage). */
  overrideSecurityPolicy: z.boolean().default(false),
  overrideReason: trimmed(500).optional(),
});
export const deploymentDecisionSchema = z.object({ comment: trimmed(1000).optional() });
export const databaseConnectionSchema = z.object({
  environmentId: uuid,
  host: required(255),
  port: z.number().int().min(1).max(65535).default(5432),
  database: required(120),
  username: required(120),
  password: z.string().max(500).optional(),
  sslMode: z.enum(['disable', 'prefer', 'require']).default('prefer'),
});

/* ---------------- secrets ---------------- */
export const upsertSecretSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Geçersiz secret adı').max(120),
  value: z.string().min(1).max(50000),
  kind: z.enum(SECRET_KINDS).default('env'),
  scope: z.enum(SECRET_SCOPES).default('runtime'),
  environmentId: uuid.nullable().default(null),
});

/* ---------------- security ---------------- */
export const updateFindingSchema = z.object({
  status: z.enum(FINDING_STATUSES),
  reason: trimmed(1000).optional(),
});

/* ---------------- AI ---------------- */
export const aiQuerySchema = z.object({
  message: required(4000),
  conversationId: uuid.optional(),
  filePath: trimmed(500).optional(),
});
export const aiFixSchema = z.object({ instruction: trimmed(4000).optional() });
export const aiDecisionSchema = z.object({ comment: trimmed(2000).optional() });
export const aiSettingsSchema = z.object({
  provider: z.enum(AI_PROVIDERS).nullable(),
  model: trimmed(100).nullable(),
  autonomyLevel: z.enum(AI_AUTONOMY_LEVELS),
  monthlyTokenBudget: z.number().int().min(0).max(10_000_000_000),
  maxAgentSteps: z.number().int().min(1).max(100),
  policies: z.object({
    createBranch: z.boolean(),
    commitToAiBranch: z.boolean(),
    runBuilds: z.boolean(),
    createPreview: z.boolean(),
  }),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/* ---------------- admin ---------------- */
export const retentionSettingsSchema = z.object({
  previewBuildDays: z.number().int().min(1).max(365),
  temporaryBuildDays: z.number().int().min(1).max(365),
  screenshotDays: z.number().int().min(1).max(365),
  rawLogDays: z.number().int().min(1).max(365),
  healthCheckDays: z.number().int().min(1).max(365),
  maxConcurrentBuilds: z.number().int().min(1).max(8),
  maxRunningPreviews: z.number().int().min(1).max(50),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export const webhookSchema = z.object({
  url: z.url().max(500),
  events: z.array(z.enum(DOMAIN_EVENTS)).min(1),
  projectId: uuid.nullable().default(null),
  active: z.boolean().default(true),
});
export const auditQuerySchema = z.object({
  actorType: z.string().max(20).optional(),
  projectId: uuid.optional(),
  action: trimmed(150).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: trimmed(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const searchQuerySchema = z.object({ q: required(200), limit: z.coerce.number().int().min(1).max(50).default(20) });

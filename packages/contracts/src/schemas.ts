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
  NOTIFICATION_CATEGORIES,
  PROJECT_TEMPLATE_IDS,
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
/** Slugs that collide with fixed web routes (e.g. /projects/new). */
const RESERVED_SLUGS = new Set(['new', 'archive', 'admin', 'api', 'git']);
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Yalnızca küçük harf, rakam ve tire kullanılabilir')
  .refine((s) => !RESERVED_SLUGS.has(s), 'Bu kısa ad sistem tarafından kullanılıyor');
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
    z.object({ type: z.literal('empty'), template: z.enum(PROJECT_TEMPLATE_IDS).optional() }),
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
  /** Explicit operator decision required before commands from imported repositories can run on the worker host. */
  executionTrust: z.enum(['trusted', 'untrusted']).optional(),
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

const dueDate = z.iso.date('Tarih YYYY-AA-GG biçiminde olmalı');
const taskLabels = z.array(z.string().trim().min(1).max(30)).max(10);
export const createTaskSchema = z.object({
  title: required(200),
  description: trimmed(10000).default(''),
  priority: z.enum(PRIORITIES).default('medium'),
  assigneeId: uuid.nullable().default(null),
  dueDate: dueDate.nullable().default(null),
  labels: taskLabels.default([]),
});
export const updateTaskSchema = z.object({
  title: required(200).optional(),
  description: trimmed(10000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: uuid.nullable().optional(),
  branch: branchNameSchema.nullable().optional(),
  dueDate: dueDate.nullable().optional(),
  labels: taskLabels.optional(),
});
export const commentSchema = z.object({ body: required(5000) });
export const projectCommentSchema = z.object({ body: required(5000), parentId: uuid.optional(), mentions: z.array(uuid).max(20).default([]) });

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
export const AI_MEMORY_CATEGORIES = ['architecture', 'decision', 'convention', 'bug', 'task_outcome', 'fact'] as const;
export const AI_MEMORY_VERIFICATIONS = ['verified', 'inferred', 'historical'] as const;
export const aiMemoryCreateSchema = z.object({
  category: z.enum(AI_MEMORY_CATEGORIES),
  title: required(200),
  content: required(20000),
  verification: z.enum(AI_MEMORY_VERIFICATIONS).default('verified'),
  sourceLabel: trimmed(300).optional(),
});
export const aiMemoryUpdateSchema = aiMemoryCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'En az bir alan değişmeli');
export type AiMemoryInput = z.infer<typeof aiMemoryCreateSchema>;
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
  selfHealing: z.object({
    enabled: z.boolean(),
    emergencyStop: z.boolean(),
    autoRecheckHealth: z.boolean(),
    maxAttemptsPerHour: z.number().int().min(1).max(10),
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

/* ---------------- pull requests / branch protection ---------------- */
export const branchProtectionSchema = z.object({
  /** Branches that only change through pull requests (pushes, web edits and direct merges are refused). */
  branches: z.array(branchNameSchema).max(20).default([]),
  requiredApprovals: z.number().int().min(0).max(5).default(1),
  requirePassingBuild: z.boolean().default(true),
});
export type BranchProtection = z.infer<typeof branchProtectionSchema>;
export const createPullRequestSchema = z.object({
  title: required(200),
  description: trimmed(20000).default(''),
  sourceBranch: branchNameSchema,
  targetBranch: branchNameSchema,
});
export const updatePullRequestSchema = z.object({ title: required(200).optional(), description: trimmed(20000).optional() });
export const pullRequestReviewSchema = z.object({ decision: z.enum(['approved', 'changes_requested']), body: trimmed(5000).default('') });
export const pullRequestCommentSchema = z.object({ body: required(5000), path: trimmed(500).optional(), line: z.number().int().min(1).optional() });
export const mergePullRequestSchema = z.object({ message: trimmed(500).optional(), deleteSourceBranch: z.boolean().default(false) });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Saat SS:DD biçiminde olmalı');
/** Spec §25/§106 example: "after 22:00 a deployment needs a manager's approval". Days: 0 = Pazar … 6 = Cumartesi. */
export const deploymentWindowSchema = z
  .object({
    enabled: z.boolean(),
    environmentTypes: z.array(z.enum(ENVIRONMENT_TYPES)).min(1).max(4).default(['production']),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: clock,
    end: clock,
    timezone: z.string().trim().min(1).max(64).refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Geçersiz saat dilimi'),
    outside: z.enum(['require_approval', 'deny']),
  })
  .refine((w) => w.start !== w.end, { message: 'Başlangıç ve bitiş saati aynı olamaz', path: ['end'] });
export type DeploymentWindow = z.infer<typeof deploymentWindowSchema>;

/** Customer portal branding (spec §141). Raster logos only (SVG can carry scripts), ≤ 200 KB as a data URL. */
const logoDataUrl = z
  .string()
  .max(280_000, 'Logo en fazla 200 KB olabilir')
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, 'Logo PNG, JPEG veya WebP olmalı');
export const organizationBrandingSchema = z.object({ logo: logoDataUrl.nullable() });
export const projectBrandingSchema = z.object({
  logo: logoDataUrl.nullable(),
  customerLogo: logoDataUrl.nullable(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Renk #RRGGBB biçiminde olmalı').nullable(),
});
export type ProjectBranding = z.infer<typeof projectBrandingSchema>;

/** Per category: in-app on/off (default on) and e-mail on/off (omitted = the event's own default). */
export const notificationPreferencesSchema = z.partialRecord(
  z.enum(NOTIFICATION_CATEGORIES),
  z.object({ inApp: z.boolean().optional(), email: z.boolean().optional() }),
);

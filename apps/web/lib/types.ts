import type { DetectionResult, Manifest, Permission, ReviewCapabilities } from '@projecthub/contracts';

export interface Me {
  user: { id: string; email: string; displayName: string; title: string; avatarColor: string };
  organization: { id: string; name: string; slug: string } | null;
  organizations: { id: string; name: string; slug: string }[];
  permissions: Permission[];
  smtpEnabled: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: 'active' | 'maintenance' | 'paused' | 'archived';
  projectType: string;
  technologies: string[];
  customerName: string;
  color: string;
  defaultBranch: string;
  sourceLabel: string;
  currentVersion: string | null;
  healthScore: number | null;
  securityScore: number | null;
  teamId: string | null;
  ownerId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  owner?: { id: string; displayName: string; avatarColor: string } | null;
  teamName?: string | null;
  repositoryStatus?: string | null;
  lastBuildStatus?: string | null;
  lastDeploy?: { finished_at: string; status: string } | null;
  productionStatus?: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  detection: DetectionResult | null;
  settings: { health?: HealthInfo; techDebt?: TechDebt } & Record<string, unknown>;
  team: { id: string; name: string } | null;
  repository: { status: string; error: string | null; defaultBranch: string; headCommit: string | null; sizeBytes: number; upstreamUrl: string | null; lastPushedAt: string | null; cloneUrl: string } | null;
  permissions: Permission[];
  isMember: boolean;
}

export interface HealthInfo {
  score: number;
  components: Record<string, number | null>;
  computedAt: string;
}
export interface TechDebt {
  todo: number;
  largeFiles: number;
  longFunctions: number;
  testFiles: number;
  sourceFiles: number;
  hasReadme: boolean;
  level: 'low' | 'medium' | 'high';
}

export interface ProjectEvent {
  id: string;
  kind: string;
  tone: 'ok' | 'warn' | 'bad' | 'run' | 'idle';
  title: string;
  description: string;
  refType: string | null;
  refId: string | null;
  actorLabel: string;
  createdAt: string;
}

export interface BuildStep {
  id: string;
  key: string;
  name: string;
  seq: number;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Build {
  id: string;
  projectId: string;
  number: number;
  branch: string;
  commitSha: string;
  commitMessage: string;
  trigger: string;
  triggeredByType: string;
  triggeredByName?: string | null;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  error: { step: string; file?: string; line?: number; message: string } | null;
  outputKind: string | null;
  createPreview: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface BuildDetail extends Build {
  manifest: Manifest | null;
  aiAnalysis: string | null;
  project: { id: string; slug: string; name: string };
  steps: BuildStep[];
  artifact: { id: string; sizeBytes: number; retentionUntil: string | null; available: boolean } | null;
  previews: Preview[];
}

export interface Preview {
  id: string;
  projectId: string;
  buildId: string;
  slug: string;
  kind: 'static' | 'process';
  status: 'queued' | 'starting' | 'ready' | 'failed' | 'stopped' | 'expired';
  sourceBranch: string;
  sourceCommit: string;
  error: string | null;
  expiresAt: string;
  stoppedAt: string | null;
  createdAt: string;
  url: string;
  buildNumber?: number;
  createdByName?: string | null;
}

export interface DeviceProfile {
  id: string;
  key: string;
  name: string;
  category: 'phone' | 'tablet' | 'desktop';
  width: number;
  height: number;
  scaleFactor: number;
  isMobile: boolean;
  isDefault: boolean;
}

export interface Review {
  id: string;
  key: string;
  number: number;
  projectId: string;
  previewId: string;
  name: string;
  versionLabel: string;
  capabilities: ReviewCapabilities;
  passwordProtected: boolean;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  revokedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  createdAt: string;
  url: string | null;
  feedbackCount?: number;
  visitorCount?: number;
  visitors?: { id: string; firstName: string; lastName: string; department: string; company: string; email: string; lastSeenAt: string }[];
  preview?: { id: string; slug: string; status: string; expiresAt: string; sourceBranch: string } | null;
}

export interface Feedback {
  id: string;
  key: string;
  number: number;
  projectId: string;
  type: 'comment' | 'bug' | 'change_request';
  title: string;
  body: string;
  status: string;
  statusLabel: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  pageUrl: string;
  viewport: { width: number; height: number } | null;
  scrollY: number;
  x: number | null;
  y: number | null;
  domSelector: string | null;
  deviceKey: string | null;
  browser: string | null;
  operatingSystem: string | null;
  versionLabel: string | null;
  buildId: string | null;
  previewId: string | null;
  reviewSessionId: string | null;
  reviewKey: string | null;
  reporter: { type: 'customer' | 'user'; name: string; department: string; company: string; email: string };
  assignee: { id: string; displayName: string; avatarColor: string } | null;
  taskId: string | null;
  taskKey: string | null;
  triage: { summary: string; category: string; severity: string; likelyFiles: string[]; suggestedTitle?: string; model?: string } | null;
  relatedFiles: { path: string; line: number; snippet: string }[];
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  comments?: { id: string; authorType: string; author: string; body: string; createdAt: string }[];
  attachments?: { id: string; kind: string; artifactId: string; contentType: string; createdAt: string }[];
  userAgent?: string | null;
}

export interface Task {
  id: string;
  key: string;
  number: number;
  projectId: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority: string;
  isHotfix: boolean;
  assignee: { id: string; displayName: string; avatarColor: string } | null;
  sourceType: string | null;
  sourceId: string | null;
  branch: string | null;
  createdAt: string;
}

export interface Environment {
  id: string;
  name: string;
  slug: string;
  type: 'development' | 'staging' | 'production' | 'custom';
  url: string;
  healthPath: string;
  status: 'unknown' | 'healthy' | 'degraded' | 'down';
  requiresApproval: boolean;
  requiredApprovals: number;
  monitor: boolean;
  consecutiveFailures: number;
  currentVersion: string | null;
  lastHealthAt: string | null;
  target: { adapter: string; host: string; port: number | null; username: string; remotePath: string; hasCredential: boolean; configuration: { secure?: boolean; keepReleases?: number; postDeployCommand?: string; credentialType?: string }; updatedAt: string } | null;
  database: { databaseType: string; host: string; port: number; databaseName: string; username: string; sslMode: string; hasPassword: boolean; lastCheckedAt: string | null; lastCheckOk: boolean | null; lastCheckMessage: string | null } | null;
}

export interface Version {
  id: string;
  version: string;
  commitSha: string;
  buildId: string;
  buildNumber: number;
  status: string;
  releaseNotes: string;
  migrations: { path: string; name: string; risk: 'low' | 'medium' | 'high'; operations: string[] }[];
  createdByName: string | null;
  createdAt: string;
  releasedAt: string | null;
  liveIn: string[];
}

export interface Deployment {
  id: string;
  key: string;
  number: number;
  projectId: string;
  status: string;
  adapter: string | null;
  isRollback: boolean;
  error: string | null;
  environmentName?: string;
  environmentType?: string;
  version?: string;
  requestedByName?: string | null;
  projectName?: string;
  projectSlug?: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface DeploymentDetail extends Omit<Deployment, 'version'> {
  environment: { id: string; name: string; type: string; url: string; requiredApprovals: number };
  version: { id: string; version: string; commitSha: string; releaseNotes: string; migrations: Version['migrations'] };
  policyOverride: { by: string; reason: string } | null;
  steps: { id: string; key: string; name: string; seq: number; status: BuildStep['status']; output: string | null; startedAt: string | null; finishedAt: string | null }[];
  approvals: { id: string; userName: string; decision: string; comment: string | null; createdAt: string }[];
  backups: { id: string; type: string; status: string; sizeBytes: number; createdAt: string }[];
  log: string;
  canApprove: boolean;
  requestedBy: string | null;
}

export interface Finding {
  id: string;
  key: string;
  projectId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  type: 'secret' | 'dependency' | 'code' | 'config';
  ruleId: string;
  title: string;
  description: string;
  filePath: string | null;
  line: number | null;
  packageName: string | null;
  packageVersion: string | null;
  fixedVersion: string | null;
  advisoryId: string | null;
  references: string[];
  status: string;
  statusReason: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  projectName?: string;
  projectSlug?: string;
}

export interface AiTask {
  id: string;
  key: string;
  number: number;
  projectId: string;
  type: string;
  title: string;
  instruction: string;
  status: string;
  autonomyLevel: string;
  sourceType: string | null;
  sourceId: string | null;
  baseBranch: string | null;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  buildId: string | null;
  result: { summary: string; explanation: string[]; filesChanged: { path: string; additions: number; deletions: number }[]; commitSha?: string } | null;
  error: string | null;
  decisionComment: string | null;
  createdAt: string;
  completedAt: string | null;
  requestedByName?: string | null;
  canApprove?: boolean;
  diff?: { patch: string; truncated: boolean } | null;
  build?: { id: string; number: number; status: string } | null;
  actions?: { id: string; action: string; resource: string | null; riskLevel: string; decision: string; detail: Record<string, unknown>; createdAt: string }[];
}

export interface Citation {
  type: string;
  ref: string;
  label: string;
  line?: number;
}

export interface Notification {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface Incident {
  id: string;
  key: string;
  number: number;
  title: string;
  severity: string;
  status: 'open' | 'resolved';
  source: string;
  rootCause: string | null;
  postmortem: string | null;
  startedAt: string;
  resolvedAt: string | null;
  environmentName?: string | null;
}

export interface Member {
  userId: string;
  displayName: string;
  email: string;
  title: string;
  avatarColor: string;
  roleId: string | null;
  roleName: string | null;
  addedAt: string;
}

export interface DirectoryUser {
  id: string;
  displayName: string;
  email: string;
  avatarColor: string;
  title: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: Permission[];
  memberCount: number;
}

export interface Branch {
  name: string;
  sha: string;
  date: string;
  author: string;
  subject: string;
  ahead: number;
  behind: number;
  isDefault: boolean;
}
export interface Branches {
  defaultBranch: string;
  branches: Branch[];
  tags: { name: string; sha: string }[];
}

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  subject: string;
  body?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}
export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface CommitDetail extends Commit {
  files: FileStat[];
  patch: string;
  truncated: boolean;
}
export interface Comparison {
  base: string;
  head: string;
  ahead: number;
  behind: number;
  files: FileStat[];
  patch: string;
  truncated: boolean;
  commits: Commit[];
}
export interface RepoFile {
  commit: string;
  path: string;
  sha: string;
  size: number;
  language: string;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
  lastCommit: Commit | null;
}

export interface ResponsiveIssue {
  code: 'horizontal_overflow' | 'console_error' | 'failed_request' | 'page_error' | 'load_failed' | 'offscreen_cta';
  message: string;
}
export interface ResponsiveTest {
  id: string;
  previewId: string;
  baselineTestId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  paths: string[];
  summary: { passed: number; warning: number; failed: number; total: number } | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  previewSlug?: string;
  buildNumber?: number;
  results?: {
    id: string;
    deviceKey: string;
    deviceName: string;
    width: number;
    height: number;
    path: string;
    status: 'passed' | 'warning' | 'failed';
    issues: ResponsiveIssue[];
    screenshotArtifactId: string | null;
    diffArtifactId: string | null;
    diffRatio: number | null;
    loadMs: number | null;
  }[];
}

export interface AiStatus {
  configured: boolean;
  reason: string | null;
  provider: string | null;
  model: string | null;
  autonomyLevel: string;
  policies: { createBranch: boolean; commitToAiBranch: boolean; runBuilds: boolean; createPreview: boolean };
  monthlyTokenBudget: number;
  monthlyTokensUsed: number;
  availableProviders: string[];
}

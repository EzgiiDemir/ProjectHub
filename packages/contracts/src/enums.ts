/** Status vocabularies shared by database, API and UI. Values are stable identifiers; labels live in the UI. */

export const USER_STATUSES = ['invited', 'active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'maintenance', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const REPOSITORY_STATUSES = ['provisioning', 'ready', 'failed'] as const;
export type RepositoryStatus = (typeof REPOSITORY_STATUSES)[number];

export const IMPORT_SOURCES = ['empty', 'git', 'upload'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const BUILD_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'running', 'passed', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PREVIEW_STATUSES = ['queued', 'starting', 'ready', 'failed', 'stopped', 'expired'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

export const PREVIEW_KINDS = ['static', 'process'] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export const DEVICE_CATEGORIES = ['phone', 'tablet', 'desktop'] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

export const RESPONSIVE_RESULT_STATUSES = ['passed', 'warning', 'failed'] as const;

export const REVIEW_STATUSES = ['active', 'expired', 'revoked'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const FEEDBACK_TYPES = ['comment', 'bug', 'change_request'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_STATUSES = [
  'open',
  'triaged',
  'planned',
  'in_progress',
  'ready_for_review',
  'resolved',
  'rejected',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const OPEN_FEEDBACK_STATUSES: FeedbackStatus[] = ['open', 'triaged', 'planned', 'in_progress', 'ready_for_review'];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ENVIRONMENT_TYPES = ['development', 'staging', 'production', 'custom'] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const HEALTH_STATUSES = ['unknown', 'healthy', 'degraded', 'down'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const DEPLOY_ADAPTERS = ['local', 'sftp', 'ftp', 'ssh'] as const;
export type DeployAdapter = (typeof DEPLOY_ADAPTERS)[number];

export const VERSION_STATUSES = ['draft', 'released', 'rolled_back', 'deprecated'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const DEPLOYMENT_STATUSES = [
  'pending_approval',
  'queued',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
  'rejected',
  'cancelled',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const SECRET_KINDS = ['env', 'credential', 'api_key', 'ssh_key'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const SECRET_SCOPES = ['build', 'runtime', 'deploy', 'all'] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_TYPES = ['secret', 'dependency', 'code', 'config'] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const FINDING_STATUSES = ['open', 'resolved', 'accepted', 'false_positive'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const AI_AUTONOMY_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type AiAutonomyLevel = (typeof AI_AUTONOMY_LEVELS)[number];

/** `ollama` is the self-hosted, keyless default. Cloud providers remain optional compatibility adapters. */
export const AI_PROVIDERS = ['ollama', 'openai', 'anthropic'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const AI_TASK_TYPES = [
  'fix',
  'feedback_triage',
  'build_analysis',
  'security_explain',
  'docs',
  'test_generation',
  'architecture_review',
  'impact_analysis',
  'database_review',
  'deployment_review',
  'project_plan',
] as const;
export type AiTaskType = (typeof AI_TASK_TYPES)[number];

export const AI_TASK_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'merged',
  'rejected',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number];

export const ACTOR_TYPES = ['user', 'ai', 'system', 'customer', 'agent'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const EVENT_KINDS = [
  'project',
  'commit',
  'build',
  'preview',
  'review',
  'feedback',
  'task',
  'ai',
  'deploy',
  'version',
  'security',
  'incident',
  'docs',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_TONES = ['ok', 'warn', 'bad', 'run', 'idle'] as const;
export type EventTone = (typeof EVENT_TONES)[number];

export const INCIDENT_STATUSES = ['open', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Domain events delivered to webhooks and the notification fan-out. Format: domain.entity.action */
export const DOMAIN_EVENTS = [
  'project.created',
  'project.archived',
  'repository.pushed',
  'pull_request.opened',
  'pull_request.reviewed',
  'pull_request.merged',
  'build.completed',
  'build.failed',
  'preview.ready',
  'review.created',
  'feedback.created',
  'feedback.status_changed',
  'ai.task.awaiting_approval',
  'ai.task.merged',
  'deployment.pending_approval',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.rolled_back',
  'security.finding.critical',
  'incident.opened',
  'incident.resolved',
  'task.assigned',
  'task.commented',
  'project.mentioned',
] as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

/** Notification categories users can tune per channel (Hesabım > Bildirimler). */
export const NOTIFICATION_CATEGORIES = ['code', 'build', 'deployment', 'feedback', 'ai', 'security', 'incident', 'team'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Starter templates for new projects (spec §129); the files live in @projecthub/core/templates. */
export const PROJECT_TEMPLATE_IDS = ['static', 'node-api', 'react-spa', 'nextjs-postgres', 'laravel', 'fastapi', 'custom'] as const;
export type ProjectTemplateId = (typeof PROJECT_TEMPLATE_IDS)[number];

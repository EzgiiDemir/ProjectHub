import { eq } from 'drizzle-orm';
import { aiSettingsSchema, retentionSettingsSchema, type AiSettings, type RetentionSettings } from '@projecthub/contracts';
import { organizations, type Executor } from '@projecthub/database';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: null,
  model: null,
  // Spec: start at L2 — AI suggests and prepares changes on its own branch, humans approve.
  autonomyLevel: 'L2',
  monthlyTokenBudget: 5_000_000,
  maxAgentSteps: 30,
  policies: { createBranch: true, commitToAiBranch: true, runBuilds: true, createPreview: true },
};

/** Defaults sized for the initial 8 GB RAM / 200 GB disk server. */
export const DEFAULT_RETENTION: RetentionSettings = {
  previewBuildDays: 7,
  temporaryBuildDays: 3,
  screenshotDays: 30,
  rawLogDays: 14,
  healthCheckDays: 14,
  maxConcurrentBuilds: 1,
  maxRunningPreviews: 6,
};

export interface OrgSettings {
  ai: AiSettings;
  retention: RetentionSettings;
}

export async function getOrgSettings(db: Executor, organizationId: string): Promise<OrgSettings> {
  const rows = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
  const s = (rows[0]?.settings ?? {}) as { ai?: unknown; retention?: unknown };
  const ai = aiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, ...(s.ai as object) });
  const retention = retentionSettingsSchema.safeParse({ ...DEFAULT_RETENTION, ...(s.retention as object) });
  return {
    ai: ai.success ? ai.data : DEFAULT_AI_SETTINGS,
    retention: retention.success ? retention.data : DEFAULT_RETENTION,
  };
}

import { and, eq, lt } from 'drizzle-orm';
import { artifacts, type Executor } from '@projecthub/database';
import { getOrgSettings } from './settings.js';

/**
 * A build artifact used by a preview stays on disk until the preview ends plus the organization's
 * "preview builds" retention (so it can be previewed again or turned into a version shortly after).
 * Release artifacts (retention_until = NULL) are never touched.
 */
export async function retainPreviewArtifact(db: Executor, organizationId: string, artifactId: string, previewExpiresAt: Date): Promise<void> {
  const { retention } = await getOrgSettings(db, organizationId);
  const until = new Date(previewExpiresAt.getTime() + retention.previewBuildDays * 86400_000);
  await db.update(artifacts).set({ retentionUntil: until }).where(and(eq(artifacts.id, artifactId), lt(artifacts.retentionUntil, until)));
}

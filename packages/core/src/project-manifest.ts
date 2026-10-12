import { desc, eq } from 'drizzle-orm';
import type { Manifest } from '@projecthub/contracts';
import { projectManifests, type Executor } from '@projecthub/database';

/** The project's current effective projecthub.yml (from the repository, or derived by detection). */
export async function latestManifest(db: Executor, projectId: string): Promise<Manifest | null> {
  const row = (await db.select({ content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0];
  return row?.content ?? null;
}

/** Required environment variables (manifest `env[].required`) that have no value among `available`. */
export function missingRequiredEnv(manifest: Manifest | null | undefined, available: Record<string, string>): string[] {
  return (manifest?.env ?? []).filter((e) => e.required && !(e.name in available)).map((e) => e.name);
}

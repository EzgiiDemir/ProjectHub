import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SecretKind, SecretScope } from '@projecthub/contracts';
import { secrets, type Executor } from '@projecthub/database';
import { decrypt, encrypt } from './crypto.js';
import { notFound } from './errors.js';

export interface PutSecretInput {
  organizationId: string;
  projectId: string | null;
  environmentId: string | null;
  name: string;
  value: string;
  kind: SecretKind;
  scope: SecretScope;
  /** Owning feature for system managed secrets (e.g. "deploy-target", "git-upstream"). */
  system?: string | null;
  createdBy: string | null;
}

/** Creates or rotates a secret. Only ciphertext is stored. */
export async function putSecret(db: Executor, key: Buffer, input: PutSecretInput): Promise<string> {
  const e = encrypt(key, input.value);
  const existing = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.organizationId, input.organizationId),
        input.projectId ? eq(secrets.projectId, input.projectId) : isNull(secrets.projectId),
        input.environmentId ? eq(secrets.environmentId, input.environmentId) : isNull(secrets.environmentId),
        eq(secrets.name, input.name),
      ),
    );
  if (existing[0]) {
    await db
      .update(secrets)
      .set({ ciphertext: e.ciphertext, iv: e.iv, authTag: e.authTag, kind: input.kind, scope: input.scope, rotatedAt: new Date() })
      .where(eq(secrets.id, existing[0].id));
    return existing[0].id;
  }
  const rows = await db
    .insert(secrets)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      name: input.name,
      kind: input.kind,
      scope: input.scope,
      system: input.system ?? null,
      ciphertext: e.ciphertext,
      iv: e.iv,
      authTag: e.authTag,
      createdBy: input.createdBy,
    })
    .returning({ id: secrets.id });
  return rows[0]!.id;
}

export async function readSecret(db: Executor, key: Buffer, id: string): Promise<string> {
  const rows = await db.select().from(secrets).where(eq(secrets.id, id));
  const s = rows[0];
  if (!s) throw notFound('Secret');
  await db.update(secrets).set({ lastAccessedAt: new Date() }).where(eq(secrets.id, id));
  return decrypt(key, { ciphertext: s.ciphertext, iv: s.iv, authTag: s.authTag });
}

/**
 * Environment variables for a build / runtime / deploy context.
 * Precedence: environment specific > project wide. System secrets are never exposed as env vars.
 */
export async function resolveEnvSecrets(
  db: Executor,
  key: Buffer,
  input: { organizationId: string; projectId: string; environmentId: string | null; scope: SecretScope },
): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.organizationId, input.organizationId),
        eq(secrets.projectId, input.projectId),
        isNull(secrets.system),
        eq(secrets.kind, 'env'),
        inArray(secrets.scope, [input.scope, 'all']),
        input.environmentId ? or(isNull(secrets.environmentId), eq(secrets.environmentId, input.environmentId)) : isNull(secrets.environmentId),
      ),
    )
    .orderBy(sql`${secrets.environmentId} NULLS FIRST`);
  const env: Record<string, string> = {};
  for (const s of rows) env[s.name] = decrypt(key, { ciphertext: s.ciphertext, iv: s.iv, authTag: s.authTag });
  return env;
}

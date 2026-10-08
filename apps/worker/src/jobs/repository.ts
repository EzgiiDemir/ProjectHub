import fs from 'node:fs/promises';
import { desc, eq } from 'drizzle-orm';
import {
  audit,
  detectProject,
  enqueue,
  GitRepository,
  manifestFromDetection,
  MANIFEST_FILE,
  parseManifest,
  PermanentJobError,
  publish,
  QUEUES,
  readSecret,
  SYSTEM_ACTOR,
  timeline,
  type JobContext,
} from '@projecthub/core';
import { projectManifests, projects, repositories, uploads, users } from '@projecthub/database';
import { loadProject, openRepo, commitSnapshot, type WorkerCtx } from '../context.js';

interface ProvisionPayload {
  projectId: string;
  source: 'empty' | 'git' | 'upload';
  branch: string | null;
  uploadId: string | null;
  requestedBy: string | null;
}

/** Creates the hub-managed repository for a new project (empty, imported from Git, or from an upload). */
export async function provisionRepository(ctx: WorkerCtx, { job, logger }: JobContext) {
  const p = job.payload as unknown as ProvisionPayload;
  const project = await loadProject(ctx, p.projectId);
  const { repo } = await openRepo(ctx, p.projectId);
  if (repo.status === 'ready') return { skipped: 'already provisioned' };
  const dir = ctx.storage.resolve(repo.storageKey);
  // Idempotency: a previous attempt may have left a partial repository behind.
  await fs.rm(dir, { recursive: true, force: true });
  const requester = p.requestedBy ? (await ctx.db.select().from(users).where(eq(users.id, p.requestedBy)))[0] : undefined;
  const author = { name: requester?.displayName ?? 'Project Hub', email: requester?.email ?? 'projecthub@localhost' };

  try {
    let git: GitRepository;
    let branch = project.defaultBranch;
    if (p.source === 'git') {
      const token = repo.upstreamSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, repo.upstreamSecretId) : undefined;
      git = await GitRepository.cloneBare(repo.upstreamUrl!, dir, { token, gitBinary: ctx.config.GIT_BINARY });
      const head = (await git.run(['symbolic-ref', '--short', 'HEAD'], { allowExitCodes: [0, 1, 128] })).stdout.toString().trim();
      const wanted = p.branch ?? head;
      if (wanted && (await git.resolve(`refs/heads/${wanted}`))) branch = wanted;
      else {
        const first = (await git.branches())[0];
        if (!first) throw new PermanentJobError('İçe aktarılan repository boş (branch yok)');
        branch = first.name;
      }
      await git.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    } else if (p.source === 'upload') {
      const upload = (await ctx.db.select().from(uploads).where(eq(uploads.id, p.uploadId!)))[0];
      if (!upload) throw new PermanentJobError('Yüklenen dosyalar bulunamadı');
      git = await GitRepository.initBare(dir, branch, ctx.config.GIT_BINARY);
      await git.commitDirectory({ dir: ctx.storage.resolve(`${upload.storageKey}/files`), branch, message: `Import ${upload.fileName}`, author });
      await ctx.storage.remove(upload.storageKey);
    } else {
      git = await GitRepository.initBare(dir, branch, ctx.config.GIT_BINARY);
      const readme = `# ${project.name}\n\n${project.description || 'Proje açıklaması.'}\n`;
      await git.commitChanges({ branch, baseCommit: null, message: 'Initial commit', author, changes: [{ action: 'upsert', path: 'README.md', content: readme }] });
    }
    const head = (await git.resolve(`refs/heads/${branch}`))!;
    const size = await git.sizeBytes();
    await ctx.db.transaction(async (tx) => {
      await tx.update(repositories).set({ status: 'ready', error: null, headCommit: head, defaultBranch: branch, sizeBytes: size, lastPushedAt: new Date() }).where(eq(repositories.id, repo.id));
      await tx.update(projects).set({ defaultBranch: branch }).where(eq(projects.id, project.id));
      await audit(tx, { organizationId: project.organizationId, projectId: project.id, actor: SYSTEM_ACTOR, action: 'repository.provisioned', resourceType: 'repository', resourceId: repo.id, metadata: { source: p.source, branch, head } });
      await timeline(tx, {
        organizationId: project.organizationId,
        projectId: project.id,
        kind: 'project',
        tone: 'ok',
        title: 'Repository hazır',
        description: `${branch} · ${head.slice(0, 7)} · ${(size / 1024 / 1024).toFixed(1)} MB`,
      });
    });
    await applyDetection(ctx, project.id, git, head, author.name);
    await enqueue(ctx.db, { queue: QUEUES.ai, type: 'code.index', projectId: project.id, organizationId: project.organizationId, dedupeKey: `index:${project.id}`, payload: { projectId: project.id, branch } });
    await enqueue(ctx.db, { queue: QUEUES.security, type: 'security.scan', projectId: project.id, organizationId: project.organizationId, dedupeKey: `scan:${project.id}`, payload: { projectId: project.id, branch, trigger: 'import' } });
    await publish(ctx.db, { type: 'project.updated', organizationId: project.organizationId, projectId: project.id });
    logger.info({ projectId: project.id, source: p.source }, 'repository provisioned');
    return { head, branch };
  } catch (e) {
    const finalAttempt = e instanceof PermanentJobError || job.attempts >= job.maxAttempts;
    if (finalAttempt) {
      const message = sanitizeGitError((e as Error).message);
      await ctx.db.update(repositories).set({ status: 'failed', error: message }).where(eq(repositories.id, repo.id));
      await timeline(ctx.db, { organizationId: project.organizationId, projectId: project.id, kind: 'project', tone: 'bad', title: 'Repository hazırlanamadı', description: message });
      await publish(ctx.db, { type: 'project.updated', organizationId: project.organizationId, projectId: project.id });
    }
    throw e;
  }
}

/** Removes credentials from git error text before it is stored or shown. */
function sanitizeGitError(message: string): string {
  return message
    .replace(/https?:\/\/[^@\s]+@/g, 'https://***@')
    .replace(/Authorization: Basic \S+/g, 'Authorization: ***')
    .slice(0, 1000);
}

/** Runs Smart Import detection on a commit and records it (plus the manifest) on the project. */
export async function applyDetection(ctx: WorkerCtx, projectId: string, git: GitRepository, commit: string, actorLabel = 'System') {
  const project = await loadProject(ctx, projectId);
  const snap = await commitSnapshot(git, commit);
  const detection = await detectProject(snap, project.slug);
  let manifest;
  let source: 'repository' | 'detected' = 'detected';
  const manifestText = snap.paths.includes(MANIFEST_FILE) ? await snap.read(MANIFEST_FILE) : null;
  if (manifestText) {
    try {
      manifest = parseManifest(manifestText);
      source = 'repository';
    } catch (e) {
      detection.warnings.push(`projecthub.yml geçersiz: ${(e as Error).message}`);
    }
  }
  manifest ??= manifestFromDetection({ ...detection, name: project.name }, project.slug);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        detection,
        technologies: detection.technologies,
        projectType: detection.projectType,
        currentVersion: project.currentVersion ?? (detection.version !== '0.1.0' ? detection.version : null),
        description: project.description || detection.description || '',
      })
      .where(eq(projects.id, projectId));
    const last = (await tx.select({ v: projectManifests.version, content: projectManifests.content }).from(projectManifests).where(eq(projectManifests.projectId, projectId)).orderBy(desc(projectManifests.version)).limit(1))[0];
    if (!last || JSON.stringify(last.content) !== JSON.stringify(manifest)) {
      await tx.insert(projectManifests).values({ projectId, version: (last?.v ?? 0) + 1, source, commitSha: commit, content: manifest });
    }
    await timeline(tx, {
      organizationId: project.organizationId,
      projectId,
      kind: 'project',
      tone: detection.warnings.length ? 'warn' : 'ok',
      title: `Proje tanındı: ${detection.projectType}`,
      description: [detection.technologies.join(', '), detection.warnings.length ? `${detection.warnings.length} uyarı` : ''].filter(Boolean).join(' · '),
      actorLabel,
    });
  });
  return detection;
}

export async function detectJob(ctx: WorkerCtx, { job }: JobContext) {
  const { projectId } = job.payload as { projectId: string };
  const project = await loadProject(ctx, projectId);
  const { git } = await openRepo(ctx, projectId);
  const head = await git.resolve(`refs/heads/${project.defaultBranch}`);
  if (!head) throw new PermanentJobError('Varsayılan branch bulunamadı');
  const detection = await applyDetection(ctx, projectId, git, head);
  await publish(ctx.db, { type: 'project.updated', organizationId: project.organizationId, projectId });
  return { technologies: detection.technologies };
}

/** Pulls all branches from the original upstream (projects imported from GitHub/GitLab/any Git URL). */
export async function syncJob(ctx: WorkerCtx, { job }: JobContext) {
  const { projectId } = job.payload as { projectId: string };
  const project = await loadProject(ctx, projectId);
  const { git, repo } = await openRepo(ctx, projectId);
  if (!repo.upstreamUrl) throw new PermanentJobError('upstream yok');
  const before = await git.refSnapshot();
  const token = repo.upstreamSecretId ? await readSecret(ctx.db, ctx.config.encryptionKey, repo.upstreamSecretId) : undefined;
  try {
    await git.syncFromUpstream(repo.upstreamUrl, token);
  } catch (e) {
    await timeline(ctx.db, { organizationId: project.organizationId, projectId, kind: 'commit', tone: 'bad', title: 'Kaynak senkronizasyonu başarısız', description: sanitizeGitError((e as Error).message) });
    throw e;
  }
  const after = await git.refSnapshot();
  const changed = [...after].filter(([ref, sha]) => before.get(ref) !== sha && ref.startsWith('refs/heads/'));
  const head = after.get(`refs/heads/${project.defaultBranch}`) ?? null;
  await ctx.db.update(repositories).set({ headCommit: head, sizeBytes: await git.sizeBytes(), lastPushedAt: changed.length ? new Date() : repo.lastPushedAt }).where(eq(repositories.id, repo.id));
  await timeline(ctx.db, {
    organizationId: project.organizationId,
    projectId,
    kind: 'commit',
    tone: 'ok',
    title: changed.length ? `Kaynaktan ${changed.length} branch güncellendi` : 'Kaynak zaten güncel',
    description: changed.map(([ref, sha]) => `${ref.replace('refs/heads/', '')} → ${sha.slice(0, 7)}`).join(', '),
  });
  if (changed.some(([ref]) => ref === `refs/heads/${project.defaultBranch}`)) {
    await enqueue(ctx.db, { queue: QUEUES.ai, type: 'code.index', projectId, organizationId: project.organizationId, dedupeKey: `index:${projectId}`, payload: { projectId, branch: project.defaultBranch } });
    await enqueue(ctx.db, { queue: QUEUES.security, type: 'security.scan', projectId, organizationId: project.organizationId, dedupeKey: `scan:${projectId}`, payload: { projectId, branch: project.defaultBranch, trigger: 'sync' } });
  }
  await publish(ctx.db, { type: 'repository.updated', organizationId: project.organizationId, projectId });
  return { changed: changed.length };
}

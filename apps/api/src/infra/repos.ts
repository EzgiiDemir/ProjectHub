import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { GitRepository, precondition } from '@projecthub/core';
import { repositories } from '@projecthub/database';
import { Ctx } from './context.js';

/** Opens the hub-managed Git repository of a project. */
@Injectable()
export class Repos {
  constructor(private readonly ctx: Ctx) {}

  async forProject(projectId: string): Promise<{ git: GitRepository; repo: typeof repositories.$inferSelect }> {
    const repo = (await this.ctx.db.select().from(repositories).where(eq(repositories.projectId, projectId)))[0];
    if (!repo) throw precondition('Projenin repository kaydı yok');
    if (repo.status === 'provisioning') throw precondition('Repository hazırlanıyor, birkaç saniye sonra tekrar deneyin');
    if (repo.status === 'failed') throw precondition(`Repository hazırlanamadı: ${repo.error ?? 'bilinmeyen hata'}`);
    return { git: new GitRepository(this.ctx.storage.resolve(repo.storageKey), this.ctx.config.GIT_BINARY), repo };
  }
}

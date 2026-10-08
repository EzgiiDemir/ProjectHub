import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Permission } from '@projecthub/contracts';
import { forbidden, getProjectAccess, notFound } from '@projecthub/core';
import { projects } from '@projecthub/database';
import { Ctx, type AuthInfo } from './context.js';
import { uuidPattern } from './http.js';

export type ProjectRow = typeof projects.$inferSelect;

export interface ProjectScope {
  project: ProjectRow;
  permissions: Set<Permission>;
  isMember: boolean;
  can(p: Permission): boolean;
}

/**
 * Resolves a project (by id or slug) inside the caller's organization and enforces visibility and
 * project-level permissions. Invisible projects are reported as "not found" so existence does not leak.
 */
@Injectable()
export class ProjectAccess {
  constructor(private readonly ctx: Ctx) {}

  async require(auth: AuthInfo, idOrSlug: string, permission?: Permission): Promise<ProjectScope> {
    const where = uuidPattern.test(idOrSlug)
      ? and(eq(projects.id, idOrSlug), eq(projects.organizationId, auth.organizationId))
      : and(eq(projects.slug, idOrSlug), eq(projects.organizationId, auth.organizationId));
    const project = (await this.ctx.db.select().from(projects).where(where))[0];
    if (!project) throw notFound('Proje');
    const access = await getProjectAccess(this.ctx.db, {
      organizationId: auth.organizationId,
      userId: auth.user.id,
      projectId: project.id,
      orgPermissions: auth.orgPermissions,
    });
    if (!access.canSee) throw notFound('Proje');
    if (permission && !access.permissions.has(permission)) throw forbidden();
    return {
      project,
      permissions: access.permissions,
      isMember: access.isMember,
      can: (p) => access.permissions.has(p),
    };
  }

  /** Write operations are refused on archived projects (they stay readable). */
  async requireWritable(auth: AuthInfo, idOrSlug: string, permission: Permission): Promise<ProjectScope> {
    const scope = await this.require(auth, idOrSlug, permission);
    if (scope.project.status === 'archived') throw forbidden('Proje arşivde; önce arşivden çıkarın');
    return scope;
  }
}

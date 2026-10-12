import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { organizationBrandingSchema, projectBrandingSchema, type ProjectBranding } from '@projecthub/contracts';
import { audit, forbidden, publish, type Actor } from '@projecthub/core';
import { organizations, type Executor } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { ProjectAccess } from '../../infra/project-access.js';

const EMPTY_PROJECT: ProjectBranding = { logo: null, customerLogo: null, accent: null };

export function projectBrandingOf(settings: Record<string, unknown> | null | undefined): ProjectBranding {
  const parsed = projectBrandingSchema.safeParse(settings?.branding);
  return parsed.success ? parsed.data : EMPTY_PROJECT;
}

export async function organizationLogo(db: Executor, organizationId: string): Promise<string | null> {
  const row = (await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId)))[0];
  const parsed = organizationBrandingSchema.safeParse(row?.settings.branding);
  return parsed.success ? parsed.data.logo : null;
}

/** Customer portal branding (spec §141): company logo per organization; project logo, customer logo, accent per project. */
@Injectable()
export class BrandingService {
  constructor(
    private readonly ctx: Ctx,
    private readonly access: ProjectAccess,
  ) {}

  async organization(auth: AuthInfo) {
    return { logo: await organizationLogo(this.ctx.db, auth.organizationId), canEdit: auth.orgPermissions.has('admin.settings.manage') };
  }

  async setOrganization(auth: AuthInfo, input: { logo: string | null }, actor: Actor) {
    if (!auth.orgPermissions.has('admin.settings.manage')) throw forbidden('Marka ayarları için sistem ayarları yetkisi gerekir');
    await this.ctx.db.execute(sql`UPDATE organizations SET settings = jsonb_set(settings, '{branding}', ${JSON.stringify(input)}::jsonb), updated_at = now() WHERE id = ${auth.organizationId}`);
    await audit(this.ctx.db, { organizationId: auth.organizationId, actor, action: 'organization.branding_changed', resourceType: 'organization', resourceId: auth.organizationId, metadata: { logo: !!input.logo } });
    return this.organization(auth);
  }

  async project(auth: AuthInfo, idOrSlug: string) {
    const scope = await this.access.require(auth, idOrSlug);
    return {
      ...projectBrandingOf(scope.project.settings),
      companyLogo: await organizationLogo(this.ctx.db, auth.organizationId),
      canEdit: scope.can('project.update') && scope.project.status !== 'archived',
      canEditCompany: auth.orgPermissions.has('admin.settings.manage'),
    };
  }

  async setProject(auth: AuthInfo, idOrSlug: string, input: ProjectBranding, actor: Actor) {
    const scope = await this.access.requireWritable(auth, idOrSlug, 'project.update');
    // jsonb_set touches only this key, so concurrent writers of other project settings stay intact.
    await this.ctx.db.execute(sql`UPDATE projects SET settings = jsonb_set(settings, '{branding}', ${JSON.stringify(input)}::jsonb), updated_at = now() WHERE id = ${scope.project.id}`);
    await audit(this.ctx.db, { organizationId: auth.organizationId, projectId: scope.project.id, actor, action: 'project.branding_changed', resourceType: 'project', resourceId: scope.project.id, metadata: { logo: !!input.logo, customerLogo: !!input.customerLogo, accent: input.accent } });
    await publish(this.ctx.db, { type: 'project.updated', organizationId: auth.organizationId, projectId: scope.project.id });
    return this.project(auth, scope.project.id);
  }
}

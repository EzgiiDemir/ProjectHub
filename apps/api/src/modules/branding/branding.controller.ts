import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { organizationBrandingSchema, projectBrandingSchema } from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { Auth, CurrentActor, parse } from '../../infra/http.js';
import { BrandingService } from './branding.service.js';

@Controller()
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get('organization/branding')
  organization(@Auth() a: AuthInfo) {
    return this.branding.organization(a);
  }

  @Put('organization/branding')
  setOrganization(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.branding.setOrganization(a, parse(organizationBrandingSchema, body), actor);
  }

  @Get('projects/:id/branding')
  project(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.branding.project(a, id);
  }

  @Put('projects/:id/branding')
  setProject(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.branding.setProject(a, id, parse(projectBrandingSchema, body), actor);
  }
}

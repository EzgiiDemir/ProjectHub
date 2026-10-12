import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { integrationInputSchema } from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { IntegrationsService } from './integrations.service.js';

@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('integrations/catalog')
  catalog() {
    return this.integrations.catalog();
  }

  @Get('projects/:id/integrations')
  list(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.integrations.list(a, id);
  }

  @Post('projects/:id/integrations')
  create(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.integrations.save(a, id, null, parse(integrationInputSchema, body), actor);
  }

  @Put('projects/:id/integrations/:integrationId')
  update(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('integrationId') integrationId: string, @Body() body: unknown) {
    return this.integrations.save(a, id, assertUuid(integrationId, 'Entegrasyon'), parse(integrationInputSchema, body), actor);
  }

  @Post('projects/:id/integrations/:integrationId/test')
  test(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('integrationId') integrationId: string) {
    return this.integrations.test(a, id, assertUuid(integrationId, 'Entegrasyon'), actor);
  }

  @Delete('projects/:id/integrations/:integrationId')
  remove(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('integrationId') integrationId: string) {
    return this.integrations.remove(a, id, assertUuid(integrationId, 'Entegrasyon'), actor);
  }
}

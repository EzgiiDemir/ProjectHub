import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthInfo } from '../../infra/context.js';
import type { Actor } from '@projecthub/core';
import { Auth, CurrentActor, parse } from '../../infra/http.js';
import { DependenciesService } from './dependencies.service.js';

@Controller('projects/:id')
export class DependenciesController {
  constructor(private readonly deps: DependenciesService) {}

  @Get('dependencies')
  list(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.deps.list(a, id);
  }

  @Get('dependencies/usage')
  usage(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const { ecosystem, name } = parse(z.object({ ecosystem: z.string().max(20), name: z.string().trim().min(1).max(214) }), q);
    return this.deps.usage(a, id, ecosystem, name);
  }

  @Post('dependencies/upgrade')
  upgrade(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deps.prepareUpgrade(a, id, parse(z.object({ ecosystem: z.string().max(20), name: z.string().trim().min(1).max(214) }), body), actor);
  }

  /** CycloneDX JSON download. */
  @Get('sbom')
  async sbom(@Auth() a: AuthInfo, @Param('id') id: string, @Res() res: Response) {
    const { fileName, bom } = await this.deps.sbom(a, id);
    res.setHeader('content-type', 'application/vnd.cyclonedx+json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(bom, null, 2));
  }
}

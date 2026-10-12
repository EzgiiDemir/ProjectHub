import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { Auth, CurrentActor, parse } from '../../infra/http.js';
import { GuideService } from './guide.service.js';

@Controller('projects/:id/guide')
export class GuideController {
  constructor(private readonly guide: GuideService) {}

  @Get()
  overview(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.guide.overview(a, id);
  }

  @Post()
  generate(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.guide.generate(a, id, parse(z.object({ previewId: z.uuid() }), body).previewId, actor);
  }
}

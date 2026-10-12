import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  branchProtectionSchema,
  createPullRequestSchema,
  mergePullRequestSchema,
  pullRequestCommentSchema,
  pullRequestReviewSchema,
  updatePullRequestSchema,
} from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { Auth, CurrentActor, parse } from '../../infra/http.js';
import { PullRequestsService } from './pull-requests.service.js';

const num = (v: string) => parse(z.coerce.number().int().min(1), v);

@Controller('projects/:id')
export class PullRequestsController {
  constructor(private readonly prs: PullRequestsService) {}

  @Get('pull-requests')
  list(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    return this.prs.list(a, id, parse(z.object({ status: z.string().max(20).optional() }), q).status);
  }

  @Post('pull-requests')
  create(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.prs.create(a, id, parse(createPullRequestSchema, body), actor);
  }

  @Get('pull-requests/:number')
  get(@Auth() a: AuthInfo, @Param('id') id: string, @Param('number') n: string) {
    return this.prs.get(a, id, num(n));
  }

  @Patch('pull-requests/:number')
  update(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('number') n: string, @Body() body: unknown) {
    return this.prs.update(a, id, num(n), parse(updatePullRequestSchema, body), actor);
  }

  @Post('pull-requests/:number/comments')
  comment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('number') n: string, @Body() body: unknown) {
    return this.prs.comment(a, id, num(n), parse(pullRequestCommentSchema, body), actor);
  }

  @Post('pull-requests/:number/reviews')
  review(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('number') n: string, @Body() body: unknown) {
    return this.prs.review(a, id, num(n), parse(pullRequestReviewSchema, body), actor);
  }

  @Post('pull-requests/:number/merge')
  @HttpCode(200)
  merge(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('number') n: string, @Body() body: unknown) {
    return this.prs.merge(a, id, num(n), parse(mergePullRequestSchema, body), actor);
  }

  @Post('pull-requests/:number/close')
  @HttpCode(200)
  close(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('number') n: string) {
    return this.prs.setOpen(a, id, num(n), false, actor);
  }

  @Post('pull-requests/:number/reopen')
  @HttpCode(200)
  reopen(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('number') n: string) {
    return this.prs.setOpen(a, id, num(n), true, actor);
  }

  @Put('branch-protection')
  protection(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.prs.setProtection(a, id, parse(branchProtectionSchema, body), actor);
  }
}

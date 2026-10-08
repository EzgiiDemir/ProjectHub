import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { commitFilesSchema, createBranchSchema, mergeBranchSchema } from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { Auth, CurrentActor, parse } from '../../infra/http.js';
import { RepositoryService } from './repository.service.js';

const refQuery = z.object({ ref: z.string().max(250).optional(), path: z.string().max(1000).default('') });

@Controller('projects/:id/repo')
export class RepositoryController {
  constructor(private readonly repo: RepositoryService) {}

  @Get('branches')
  branches(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.repo.branches(a, id);
  }

  @Get('tree')
  tree(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const { ref, path } = parse(refQuery, q);
    return this.repo.tree(a, id, ref, path);
  }

  @Get('files')
  files(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    return this.repo.files(a, id, parse(refQuery, q).ref);
  }

  @Get('file')
  file(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const { ref, path } = parse(refQuery.extend({ path: z.string().min(1).max(1000) }), q);
    return this.repo.file(a, id, ref, path);
  }

  @Get('raw')
  async raw(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown, @Res() res: Response) {
    const { ref, path } = parse(refQuery.extend({ path: z.string().min(1).max(1000) }), q);
    const content = await this.repo.raw(a, id, ref, path);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(path.split('/').pop()!)}"`);
    res.send(content);
  }

  @Get('commits')
  commits(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const query = parse(
      z.object({
        ref: z.string().max(250).optional(),
        path: z.string().max(1000).optional(),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        skip: z.coerce.number().int().min(0).default(0),
      }),
      q,
    );
    return this.repo.commits(a, id, query);
  }

  @Get('commits/:sha')
  commit(@Auth() a: AuthInfo, @Param('id') id: string, @Param('sha') sha: string) {
    return this.repo.commit(a, id, sha);
  }

  @Get('compare')
  compare(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const { base, head } = parse(z.object({ base: z.string().min(1).max(250), head: z.string().min(1).max(250) }), q);
    return this.repo.compare(a, id, base, head);
  }

  @Get('search')
  search(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const query = parse(z.object({ q: z.string().min(1).max(200), ref: z.string().max(250).optional() }), q);
    return this.repo.search(a, id, query.ref, query.q);
  }

  @Post('commits')
  commitFiles(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.repo.commitFiles(a, id, parse(commitFilesSchema, body), actor);
  }

  @Post('branches')
  createBranch(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.repo.createBranch(a, id, parse(createBranchSchema, body), actor);
  }

  @Delete('branches')
  async deleteBranch(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Query() q: unknown) {
    await this.repo.deleteBranch(a, id, parse(z.object({ name: z.string().min(1).max(200) }), q).name, actor);
    return { ok: true };
  }

  @Post('merge')
  merge(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.repo.merge(a, id, parse(mergeBranchSchema, body), actor);
  }
}

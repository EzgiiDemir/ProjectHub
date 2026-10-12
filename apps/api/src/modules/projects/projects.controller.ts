import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  addProjectMemberSchema,
  archiveProjectSchema,
  createProjectSchema,
  projectListQuerySchema,
  updateProjectSchema,
} from '@projecthub/contracts';
import { AppError, PROJECT_TEMPLATES, type Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse, RequirePermission } from '../../infra/http.js';
import { ProjectsService } from './projects.service.js';
import { UploadsService } from './uploads.service.js';

@Controller()
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly uploads: UploadsService,
  ) {}

  /** Starter templates offered by the project wizard (spec §129). */
  @Get('project-templates')
  templates() {
    return Object.values(PROJECT_TEMPLATES).map(({ files: _files, ...t }) => t);
  }

  @Get('projects')
  list(@Auth() a: AuthInfo, @Query() q: unknown) {
    return this.projects.list(a, parse(projectListQuerySchema, q));
  }

  @Post('projects')
  @RequirePermission('project.create')
  create(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.projects.create(a, parse(createProjectSchema, body), actor);
  }

  /** Raw ZIP upload for Smart Import: Content-Type application/zip, file name in X-File-Name. */
  @Post('uploads')
  @RequirePermission('project.create')
  upload(@Auth() a: AuthInfo, @Req() req: Request) {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/(zip|x-zip-compressed|octet-stream)/.test(type)) {
      throw new AppError('VALIDATION_ERROR', 'ZIP dosyası bekleniyor (Content-Type: application/zip)');
    }
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'proje.zip')).replace(/[\\/]/g, '_');
    return this.uploads.receive(a, req, name);
  }

  @Get('projects/:id')
  get(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.get(a, id);
  }

  @Get('projects/:id/overview')
  overview(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.overview(a, id);
  }

  @Patch('projects/:id')
  update(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.update(a, id, parse(updateProjectSchema, body), actor);
  }

  @Post('projects/:id/archive')
  archive(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.archive(a, id, parse(archiveProjectSchema, body).confirmSlug, actor);
  }

  @Post('projects/:id/unarchive')
  unarchive(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.projects.unarchive(a, id, actor);
  }

  @Get('projects/:id/members')
  members(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.members(a, id);
  }

  @Post('projects/:id/members')
  addMember(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.projects.addMember(a, id, parse(addProjectMemberSchema, body), actor);
  }

  @Delete('projects/:id/members/:userId')
  removeMember(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('userId') userId: string) {
    return this.projects.removeMember(a, id, assertUuid(userId, 'Kullanıcı'), actor);
  }

  @Get('projects/:id/manifest')
  manifest(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.projects.manifest(a, id);
  }

  @Put('projects/:id/manifest')
  saveManifest(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ yaml: z.string().min(1).max(100_000), commit: z.boolean().default(true) }), body);
    return this.projects.saveManifest(a, id, input.yaml, input.commit, actor);
  }

  @Post('projects/:id/detect')
  detect(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.projects.redetect(a, id, actor);
  }

  @Post('projects/:id/sync')
  sync(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.projects.syncUpstream(a, id, actor);
  }

  @Get('projects/:id/timeline')
  timeline(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const query = parse(z.object({ kind: z.string().max(20).optional(), cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), q);
    return this.projects.timeline(a, id, query);
  }
}

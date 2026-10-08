import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { createBuildSchema, createPreviewSchema, responsiveTestSchema } from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { openSse, RealtimeHub } from '../../infra/realtime.js';
import { BuildsService } from './builds.service.js';

@Controller()
export class BuildsController {
  constructor(
    private readonly builds: BuildsService,
    private readonly hub: RealtimeHub,
  ) {}

  @Get('projects/:id/builds')
  list(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const query = parse(z.object({ cursor: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(30), branch: z.string().max(200).optional() }), q);
    return this.builds.list(a, id, query);
  }

  @Post('projects/:id/builds')
  create(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.builds.create(a, id, parse(createBuildSchema, body), actor);
  }

  @Get('builds/:buildId')
  get(@Auth() a: AuthInfo, @Param('buildId') buildId: string) {
    return this.builds.get(a, assertUuid(buildId, 'Build'));
  }

  @Get('builds/:buildId/log')
  log(@Auth() a: AuthInfo, @Param('buildId') buildId: string, @Query() q: unknown) {
    const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0).default(0) }), q);
    return this.builds.log(a, assertUuid(buildId, 'Build'), offset);
  }

  /** Live build progress: step changes and new log text (SSE, spec §69). */
  @Get('builds/:buildId/events')
  async events(@Auth() a: AuthInfo, @Param('buildId') buildId: string, @Res() res: Response) {
    const id = assertUuid(buildId, 'Build');
    const initial = await this.builds.get(a, id);
    let offset = 0;
    let closed = false;
    let pumping = false;
    const send = openSse(res, () => {
      closed = true;
      unsubscribe();
      clearInterval(timer);
    });
    send('build', initial);
    const pump = async () => {
      if (closed || pumping) return;
      pumping = true;
      try {
        for (;;) {
          const chunk = await this.builds.log(a, id, offset);
          if (chunk.text) send('log', { text: chunk.text });
          offset = chunk.offset;
          if (!chunk.text || chunk.offset >= (chunk.size ?? 0)) break;
        }
      } finally {
        pumping = false;
      }
    };
    const unsubscribe = this.hub.subscribe(async (e) => {
      if (e.type === 'build.updated' && e.id === id && !closed) {
        await pump();
        const b = await this.builds.get(a, id);
        send('build', b);
        if (!['queued', 'running'].includes(b.status)) {
          await pump();
          send('end', { status: b.status });
        }
      }
    });
    const timer = setInterval(() => void pump(), 1_000);
    await pump();
  }

  @Post('builds/:buildId/cancel')
  async cancel(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('buildId') buildId: string) {
    await this.builds.cancel(a, assertUuid(buildId, 'Build'), actor);
    return { ok: true };
  }

  @Post('builds/:buildId/retry')
  retry(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('buildId') buildId: string) {
    return this.builds.retry(a, assertUuid(buildId, 'Build'), actor);
  }

  @Get('projects/:id/previews')
  previews(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.builds.listPreviews(a, id);
  }

  @Post('projects/:id/previews')
  createPreview(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.builds.createPreview(a, id, parse(createPreviewSchema, body), actor);
  }

  @Get('previews/:previewId')
  preview(@Auth() a: AuthInfo, @Param('previewId') previewId: string) {
    return this.builds.getPreview(a, assertUuid(previewId, 'Ön izleme'));
  }

  @Post('previews/:previewId/stop')
  stop(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('previewId') previewId: string) {
    return this.builds.stopPreview(a, assertUuid(previewId, 'Ön izleme'), actor);
  }

  @Post('previews/:previewId/extend')
  extend(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('previewId') previewId: string, @Body() body: unknown) {
    const { hours } = parse(z.object({ hours: z.number().int().min(1).max(24 * 14) }), body);
    return this.builds.extendPreview(a, assertUuid(previewId, 'Ön izleme'), hours, actor);
  }

  @Post('previews/:previewId/access')
  access(@Auth() a: AuthInfo, @Param('previewId') previewId: string, @Body() body: unknown) {
    const { path } = parse(z.object({ path: z.string().max(1000).default('/') }), body);
    return this.builds.accessUrl(a, assertUuid(previewId, 'Ön izleme'), path);
  }

  @Get('previews/:previewId/logs')
  logs(@Auth() a: AuthInfo, @Param('previewId') previewId: string) {
    return this.builds.previewLogs(a, assertUuid(previewId, 'Ön izleme'));
  }

  @Get('projects/:id/responsive-tests')
  responsiveTests(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.builds.listResponsiveTests(a, id);
  }

  @Post('projects/:id/responsive-tests')
  createResponsiveTest(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.builds.createResponsiveTest(a, id, parse(responsiveTestSchema, body), actor);
  }

  @Get('responsive-tests/:testId')
  responsiveTest(@Auth() a: AuthInfo, @Param('testId') testId: string) {
    return this.builds.getResponsiveTest(a, assertUuid(testId, 'Test'));
  }

  @Get('device-profiles')
  devices() {
    return this.builds.deviceProfiles();
  }
}

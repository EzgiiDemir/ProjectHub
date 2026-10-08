import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { searchQuerySchema } from '@projecthub/contracts';
import { getProjectAccess, type Actor } from '@projecthub/core';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { openSse, RealtimeHub } from '../../infra/realtime.js';
import { MiscService } from './misc.service.js';

@Controller()
export class MiscController {
  constructor(
    private readonly svc: MiscService,
    private readonly hub: RealtimeHub,
    private readonly ctx: Ctx,
  ) {}

  /**
   * Realtime channel for the web app (spec §127). Events are filtered per connection: same organization,
   * projects the user can see, and user-targeted notifications only for that user.
   */
  @Get('stream')
  stream(@Auth() a: AuthInfo, @Res() res: Response) {
    const visible = new Map<string, { ok: boolean; at: number }>();
    const canSee = async (projectId: string) => {
      const hit = visible.get(projectId);
      if (hit && Date.now() - hit.at < 60_000) return hit.ok;
      const access = await getProjectAccess(this.ctx.db, { organizationId: a.organizationId, userId: a.user.id, projectId, orgPermissions: a.orgPermissions });
      visible.set(projectId, { ok: access.canSee, at: Date.now() });
      return access.canSee;
    };
    const send = openSse(res, () => unsubscribe());
    send('ready', { userId: a.user.id });
    const unsubscribe = this.hub.subscribe(async (e) => {
      if (e.organizationId && e.organizationId !== a.organizationId) return;
      const target = (e.data as { userId?: string } | undefined)?.userId;
      if (e.type === 'notification') {
        if (target === a.user.id) send('notification', e.data);
        return;
      }
      if (e.projectId && !(await canSee(e.projectId))) return;
      send('event', { type: e.type, projectId: e.projectId, id: e.id });
    });
  }

  @Get('notifications')
  notifications(@Auth() a: AuthInfo) {
    return this.svc.notifications(a);
  }

  @Post('notifications/read')
  async read(@Auth() a: AuthInfo, @Body() body: unknown) {
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(200).nullable().default(null) }), body);
    await this.svc.markRead(a, ids);
    return { ok: true };
  }

  @Get('home')
  home(@Auth() a: AuthInfo) {
    return this.svc.home(a);
  }

  @Get('search')
  search(@Auth() a: AuthInfo, @Query() q: unknown) {
    const query = parse(searchQuerySchema, q);
    return this.svc.search(a, query.q, query.limit);
  }

  @Get('projects/:id/incidents')
  incidents(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.incidents(a, id);
  }

  @Post('projects/:id/incidents')
  openIncident(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ title: z.string().trim().min(3).max(300), severity: z.enum(['critical', 'high', 'medium', 'low']), environmentId: z.uuid().nullable().optional() }), body);
    return this.svc.openIncident(a, id, input, actor);
  }

  @Get('incidents/:incidentId')
  incident(@Auth() a: AuthInfo, @Param('incidentId') incidentId: string) {
    return this.svc.incident(a, assertUuid(incidentId, 'Olay'));
  }

  @Patch('incidents/:incidentId')
  updateIncident(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('incidentId') incidentId: string, @Body() body: unknown) {
    const input = parse(z.object({ status: z.enum(['open', 'resolved']).optional(), rootCause: z.string().max(5000).optional(), postmortem: z.string().max(50000).optional() }), body);
    return this.svc.updateIncident(a, assertUuid(incidentId, 'Olay'), input, actor);
  }

  @Post('incidents/:incidentId/postmortem-draft')
  postmortem(@Auth() a: AuthInfo, @Param('incidentId') incidentId: string) {
    return this.svc.draftPostmortem(a, assertUuid(incidentId, 'Olay'));
  }

  @Get('projects/:id/environments/:envId/health-checks')
  health(@Auth() a: AuthInfo, @Param('id') id: string, @Param('envId') envId: string) {
    return this.svc.healthChecks(a, id, assertUuid(envId, 'Ortam'));
  }
}

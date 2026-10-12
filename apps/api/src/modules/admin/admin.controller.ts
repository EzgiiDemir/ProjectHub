import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  aiSettingsSchema,
  auditQuerySchema,
  createTeamSchema,
  inviteUserSchema,
  retentionSettingsSchema,
  updateUserSchema,
  upsertRoleSchema,
  webhookSchema,
} from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse, RequirePermission } from '../../infra/http.js';
import { SystemService } from './system.service.js';
import { UsersService } from './users.service.js';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly system: SystemService,
  ) {}

  /* users */
  @Get('users')
  @RequirePermission('admin.users.manage')
  listUsers(@Auth() a: AuthInfo) {
    return this.users.list(a);
  }

  /** Lightweight directory (id, name) for pickers; any authenticated member may read it. */
  @Get('directory')
  async directory(@Auth() a: AuthInfo) {
    const all = await this.users.list(a);
    return all.filter((u) => u.status === 'active').map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, avatarColor: u.avatarColor, title: u.title }));
  }

  @Get('users/:id')
  @RequirePermission('admin.users.manage')
  userDetail(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.users.detail(a, assertUuid(id, 'Kullanıcı'));
  }

  @Post('users')
  @RequirePermission('admin.users.manage')
  invite(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.users.invite(a, parse(inviteUserSchema, body), actor);
  }

  @Patch('users/:id')
  @RequirePermission('admin.users.manage')
  updateUser(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.users.update(a, assertUuid(id, 'Kullanıcı'), parse(updateUserSchema, body), actor);
  }

  @Post('users/:id/reset-sessions')
  @RequirePermission('admin.users.manage')
  resetSessions(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.users.resetSessions(a, assertUuid(id, 'Kullanıcı'), actor);
  }

  @Post('users/:id/resend-invite')
  @RequirePermission('admin.users.manage')
  resendInvite(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.users.resendInvite(a, assertUuid(id, 'Kullanıcı'), actor);
  }

  @Post('users/:id/password-reset-link')
  @RequirePermission('admin.users.manage')
  resetLink(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.users.passwordResetLink(a, assertUuid(id, 'Kullanıcı'), actor);
  }

  /* roles */
  @Get('roles')
  listRoles(@Auth() a: AuthInfo) {
    return this.users.listRoles(a);
  }

  @Post('roles')
  @RequirePermission('admin.roles.manage')
  createRole(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.users.createRole(a, parse(upsertRoleSchema, body), actor);
  }

  @Put('roles/:id')
  @RequirePermission('admin.roles.manage')
  async updateRole(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    await this.users.updateRole(a, assertUuid(id, 'Rol'), parse(upsertRoleSchema, body), actor);
    return { ok: true };
  }

  @Delete('roles/:id')
  @RequirePermission('admin.roles.manage')
  async deleteRole(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.users.deleteRole(a, assertUuid(id, 'Rol'), actor);
    return { ok: true };
  }

  /* teams */
  @Get('teams')
  listTeams(@Auth() a: AuthInfo) {
    return this.users.listTeams(a);
  }

  @Post('teams')
  @RequirePermission('admin.users.manage')
  createTeam(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.users.createTeam(a, parse(createTeamSchema, body).name, actor);
  }

  @Put('teams/:id/members')
  @RequirePermission('admin.users.manage')
  async teamMembers(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { userIds } = parse(z.object({ userIds: z.array(z.uuid()).max(500) }), body);
    await this.users.setTeamMembers(a, assertUuid(id, 'Ekip'), userIds, actor);
    return { ok: true };
  }

  @Delete('teams/:id')
  @RequirePermission('admin.users.manage')
  async deleteTeam(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.users.deleteTeam(a, assertUuid(id, 'Ekip'), actor);
    return { ok: true };
  }

  /* audit */
  @Get('audit')
  @RequirePermission('admin.audit.read')
  audit(@Auth() a: AuthInfo, @Query() query: unknown) {
    return this.system.auditLog(a, parse(auditQuerySchema, query));
  }

  /* settings */
  @Get('settings')
  @RequirePermission('admin.settings.manage')
  settings(@Auth() a: AuthInfo) {
    return this.system.getSettings(a);
  }

  @Put('settings/ai')
  @RequirePermission('admin.settings.manage')
  updateAi(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.system.updateAi(a, parse(aiSettingsSchema, body), actor);
  }

  @Get('ai/usage')
  @RequirePermission('admin.settings.manage')
  aiUsage(@Auth() a: AuthInfo) {
    return this.system.aiUsage(a);
  }

  @Get('ai/operations')
  @RequirePermission('admin.settings.manage')
  aiOperations(@Auth() a: AuthInfo) {
    return this.system.aiOperations(a);
  }

  @Put('settings/retention')
  @RequirePermission('admin.settings.manage')
  updateRetention(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.system.updateRetention(a, parse(retentionSettingsSchema, body), actor);
  }

  /* system */
  @Get('system')
  @RequirePermission('admin.system.read')
  status(): Promise<unknown> {
    return this.system.systemStatus();
  }

  @Post('jobs/:id/retry')
  @RequirePermission('admin.system.read')
  async retryJob(@Param('id') id: string) {
    await this.system.retryJob(assertUuid(id, 'İş'));
    return { ok: true };
  }

  /* webhooks */
  @Get('webhooks')
  @RequirePermission('admin.settings.manage')
  webhooks(@Auth() a: AuthInfo) {
    return this.system.listWebhooks(a);
  }

  @Post('webhooks')
  @RequirePermission('admin.settings.manage')
  createWebhook(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.system.createWebhook(a, parse(webhookSchema, body), actor);
  }

  @Delete('webhooks/:id')
  @RequirePermission('admin.settings.manage')
  async deleteWebhook(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.system.deleteWebhook(a, assertUuid(id, 'Webhook'), actor);
    return { ok: true };
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission('admin.settings.manage')
  deliveries(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.system.webhookDeliveries(a, assertUuid(id, 'Webhook'));
  }
}

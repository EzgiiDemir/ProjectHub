import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import {
  createDeploymentSchema,
  createVersionSchema,
  databaseConnectionSchema,
  deploymentDecisionSchema,
  deploymentTargetSchema,
  deploymentWindowSchema,
  updateFindingSchema,
  upsertEnvironmentSchema,
  upsertSecretSchema,
} from '@projecthub/contracts';
import { notFound, type Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { SecurityService } from '../security/security.service.js';
import { DatabaseOpsService } from './database-ops.service.js';
import { DeployService } from './deploy.service.js';

@Controller()
export class DeployController {
  constructor(
    private readonly deploy: DeployService,
    private readonly security: SecurityService,
    private readonly dbOps: DatabaseOpsService,
  ) {}

  /* database safety (spec §49–53) */
  @Get('projects/:id/database/overview')
  databaseOverview(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.dbOps.overview(a, id);
  }

  @Get('projects/:id/migrations')
  migrations(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.dbOps.migrations(a, id);
  }

  @Get('projects/:id/deployment-window')
  deploymentWindow(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.deploy.deploymentWindow(a, id);
  }

  @Put('projects/:id/deployment-window')
  setDeploymentWindow(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deploy.setDeploymentWindow(a, id, parse(deploymentWindowSchema, body), actor);
  }

  @Get('projects/:id/deployments/preflight')
  preflight(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const { environmentId, versionId } = parse(z.object({ environmentId: z.uuid(), versionId: z.uuid() }), q);
    return this.dbOps.preflight(a, id, environmentId, versionId);
  }

  @Post('backups/:backupId/verify')
  verifyBackup(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('backupId') backupId: string) {
    return this.dbOps.verify(a, assertUuid(backupId, 'Yedek'), actor);
  }

  @Delete('backups/:backupId')
  deleteBackup(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('backupId') backupId: string) {
    return this.dbOps.remove(a, assertUuid(backupId, 'Yedek'), actor);
  }

  @Post('backups/:backupId/restore')
  restore(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('backupId') backupId: string, @Body() body: unknown) {
    const { environmentId } = parse(z.object({ environmentId: z.uuid() }), body);
    return this.dbOps.requestRestore(a, assertUuid(backupId, 'Yedek'), environmentId, actor);
  }

  @Get('projects/:id/restores')
  restores(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.dbOps.restores(a, id);
  }

  @Post('restores/:restoreId/approve')
  approveRestore(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('restoreId') restoreId: string) {
    return this.dbOps.decideRestore(a, assertUuid(restoreId, 'Geri yükleme'), true, actor);
  }

  @Post('restores/:restoreId/reject')
  rejectRestore(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('restoreId') restoreId: string) {
    return this.dbOps.decideRestore(a, assertUuid(restoreId, 'Geri yükleme'), false, actor);
  }

  /* environments */
  @Get('projects/:id/environments')
  environments(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.deploy.environments(a, id);
  }

  @Post('projects/:id/environments')
  createEnvironment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deploy.upsertEnvironment(a, id, null, parse(upsertEnvironmentSchema, body), actor);
  }

  @Put('projects/:id/environments/:envId')
  updateEnvironment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('envId') envId: string, @Body() body: unknown) {
    return this.deploy.upsertEnvironment(a, id, assertUuid(envId, 'Ortam'), parse(upsertEnvironmentSchema, body), actor);
  }

  @Delete('projects/:id/environments/:envId')
  async deleteEnvironment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('envId') envId: string, @Query() q: unknown) {
    const { confirm } = parse(z.object({ confirm: z.string().max(80) }), q);
    await this.deploy.deleteEnvironment(a, id, assertUuid(envId, 'Ortam'), confirm, actor);
    return { ok: true };
  }

  @Put('projects/:id/environments/:envId/target')
  target(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('envId') envId: string, @Body() body: unknown) {
    return this.deploy.upsertTarget(a, id, assertUuid(envId, 'Ortam'), parse(deploymentTargetSchema, body), actor);
  }

  @Post('projects/:id/environments/:envId/target/test')
  testTarget(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('envId') envId: string) {
    return this.deploy.testTarget(a, id, assertUuid(envId, 'Ortam'), actor);
  }

  /* versions */
  @Get('projects/:id/versions')
  versions(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.deploy.versions(a, id);
  }

  @Post('projects/:id/versions')
  createVersion(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deploy.createVersion(a, id, parse(createVersionSchema, body), actor);
  }

  /* deployments */
  @Get('deployments')
  allDeployments(@Auth() a: AuthInfo) {
    return this.deploy.list(a, null);
  }

  @Get('projects/:id/deployments')
  deployments(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.deploy.list(a, id);
  }

  @Post('projects/:id/deployments')
  createDeployment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deploy.create(a, id, parse(createDeploymentSchema, body), actor);
  }

  @Get('deployments/:deploymentId')
  deployment(@Auth() a: AuthInfo, @Param('deploymentId') deploymentId: string) {
    return this.deploy.get(a, assertUuid(deploymentId, 'Deployment'));
  }

  @Post('deployments/:deploymentId/approve')
  approve(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('deploymentId') deploymentId: string, @Body() body: unknown) {
    return this.deploy.decide(a, assertUuid(deploymentId, 'Deployment'), 'approved', parse(deploymentDecisionSchema, body).comment, actor);
  }

  @Post('deployments/:deploymentId/reject')
  reject(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('deploymentId') deploymentId: string, @Body() body: unknown) {
    return this.deploy.decide(a, assertUuid(deploymentId, 'Deployment'), 'rejected', parse(deploymentDecisionSchema, body).comment, actor);
  }

  @Post('deployments/:deploymentId/cancel')
  cancel(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('deploymentId') deploymentId: string) {
    return this.deploy.cancel(a, assertUuid(deploymentId, 'Deployment'), actor);
  }

  @Post('deployments/:deploymentId/rollback')
  rollback(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('deploymentId') deploymentId: string) {
    return this.deploy.rollback(a, assertUuid(deploymentId, 'Deployment'), actor);
  }

  /* database */
  @Put('projects/:id/database')
  database(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deploy.setDatabase(a, id, parse(databaseConnectionSchema, body), actor);
  }

  @Get('projects/:id/backups')
  backups(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.deploy.backups(a, id);
  }

  @Post('projects/:id/backups')
  createBackup(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const { environmentId } = parse(z.object({ environmentId: z.uuid() }), body);
    return this.deploy.createBackup(a, id, environmentId, actor);
  }

  @Get('backups/:backupId/download')
  async backupDownload(@Auth() a: AuthInfo, @Param('backupId') backupId: string, @Res() res: Response) {
    const f = await this.deploy.backupFile(a, assertUuid(backupId, 'Yedek'));
    if (!fs.existsSync(f.path)) throw notFound('Yedek dosyası');
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${f.name}"`);
    fs.createReadStream(f.path).pipe(res);
  }

  /* secrets */
  @Get('projects/:id/secrets')
  secrets(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.security.listSecrets(a, id);
  }

  @Post('projects/:id/secrets')
  upsertSecret(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.security.upsertSecret(a, id, parse(upsertSecretSchema, body), actor);
  }

  @Post('secrets/:secretId/reveal')
  reveal(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('secretId') secretId: string) {
    return this.security.reveal(a, assertUuid(secretId, 'Secret'), actor);
  }

  @Delete('secrets/:secretId')
  async deleteSecret(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('secretId') secretId: string) {
    await this.security.deleteSecret(a, assertUuid(secretId, 'Secret'), actor);
    return { ok: true };
  }

  /* security */
  @Get('projects/:id/security')
  projectSecurity(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    return this.security.projectSecurity(a, id, parse(z.object({ status: z.string().max(20).optional(), severity: z.string().max(20).optional(), type: z.string().max(20).optional() }), q));
  }

  @Post('projects/:id/security/scans')
  scan(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.security.startScan(a, id, actor);
  }

  @Post('security/findings/:findingId/resolve')
  resolveFinding(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('findingId') findingId: string, @Body() body: unknown) {
    const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), body ?? {});
    return this.security.resolveAndVerify(a, assertUuid(findingId, 'Bulgu'), note, actor);
  }

  @Get('security/findings/:findingId/verification')
  findingVerification(@Auth() a: AuthInfo, @Param('findingId') findingId: string, @Query() q: unknown) {
    return this.security.verification(a, assertUuid(findingId, 'Bulgu'), parse(z.object({ scanId: z.uuid() }), q).scanId);
  }

  @Post('security/findings/:findingId')
  finding(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('findingId') findingId: string, @Body() body: unknown) {
    return this.security.updateFinding(a, assertUuid(findingId, 'Bulgu'), parse(updateFindingSchema, body), actor);
  }

  @Get('security/center')
  center(@Auth() a: AuthInfo) {
    return this.security.center(a);
  }
}

import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  chatMessageSchema,
  createReviewSchema,
  createTaskSchema,
  feedbackCommentSchema,
  feedbackToTaskSchema,
  publicFeedbackSchema,
  updateFeedbackSchema,
  updateTaskSchema,
} from '@projecthub/contracts';
import { notFound, type Actor } from '@projecthub/core';
import { artifacts } from '@projecthub/database';
import { Ctx, type AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { ProjectAccess } from '../../infra/project-access.js';
import { describeUserAgent } from './ua.js';
import { FeedbackService, insertFeedback } from './feedback.service.js';
import { ReviewsService } from './reviews.service.js';

@Controller()
export class ReviewsController {
  constructor(
    private readonly ctx: Ctx,
    private readonly reviews: ReviewsService,
    private readonly feedback: FeedbackService,
    private readonly access: ProjectAccess,
  ) {}

  /* reviews */
  @Get('projects/:id/reviews')
  list(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.reviews.list(a, id);
  }

  @Post('projects/:id/reviews')
  create(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.reviews.create(a, id, parse(createReviewSchema, body), actor);
  }

  @Get('reviews/:reviewId')
  get(@Auth() a: AuthInfo, @Param('reviewId') reviewId: string) {
    return this.reviews.get(a, assertUuid(reviewId, 'Müşteri linki'));
  }

  @Post('reviews/:reviewId/revoke')
  revoke(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('reviewId') reviewId: string) {
    return this.reviews.revoke(a, assertUuid(reviewId, 'Müşteri linki'), actor);
  }

  @Post('reviews/:reviewId/extend')
  extend(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('reviewId') reviewId: string, @Body() body: unknown) {
    const { hours } = parse(z.object({ hours: z.number().int().min(1).max(24 * 30) }), body);
    return this.reviews.extend(a, assertUuid(reviewId, 'Müşteri linki'), hours, actor);
  }

  @Post('reviews/:reviewId/switch-preview')
  switchPreview(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('reviewId') reviewId: string, @Body() body: unknown) {
    const { previewId } = parse(z.object({ previewId: z.uuid() }), body);
    return this.reviews.switchPreview(a, assertUuid(reviewId, 'Müşteri linki'), previewId, actor);
  }

  @Get('reviews/:reviewId/messages')
  messages(@Auth() a: AuthInfo, @Param('reviewId') reviewId: string) {
    return this.reviews.messages(a, assertUuid(reviewId, 'Müşteri linki'));
  }

  @Post('reviews/:reviewId/messages')
  reply(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('reviewId') reviewId: string, @Body() body: unknown) {
    return this.reviews.reply(a, assertUuid(reviewId, 'Müşteri linki'), parse(chatMessageSchema, body).body, actor);
  }

  /* feedback */
  @Get('projects/:id/feedback')
  feedbackList(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    const query = parse(z.object({ status: z.string().max(30).optional(), reviewId: z.uuid().optional(), assignee: z.literal('me').optional(), open: z.coerce.boolean().optional() }), q);
    return this.feedback.list(a, id, query);
  }

  /** Team members can log feedback too (internal QA), with the same context capture. */
  @Post('projects/:id/feedback')
  async internalFeedback(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const scope = await this.access.requireWritable(a, id, 'project.read');
    const input = parse(publicFeedbackSchema.extend({ previewId: z.uuid().optional() }), body);
    const { browser, os } = describeUserAgent(actor.userAgent ?? '');
    const row = await this.ctx.db.transaction((tx) =>
      insertFeedback(
        tx,
        {
          organizationId: a.organizationId,
          projectId: scope.project.id,
          reviewSessionId: null,
          type: input.type,
          title: input.title,
          body: input.body,
          pageUrl: input.pageUrl,
          viewport: input.viewport,
          scrollY: input.scrollY,
          coordinates: input.coordinates,
          domSelector: input.domSelector,
          deviceKey: input.deviceKey,
          browser,
          operatingSystem: os,
          userAgent: actor.userAgent ?? '',
          versionLabel: scope.project.currentVersion ? `v${scope.project.currentVersion}` : null,
          buildId: null,
          previewId: input.previewId ?? null,
          reporter: { type: 'user', userId: a.user.id, label: actor.label },
          captureScreenshot: input.captureScreenshot && !!input.previewId,
        },
        actor,
      ),
    );
    return { id: row.id, key: `FB-${row.number}` };
  }

  @Get('feedback/:feedbackId')
  feedbackGet(@Auth() a: AuthInfo, @Param('feedbackId') feedbackId: string) {
    return this.feedback.get(a, assertUuid(feedbackId, 'Geri bildirim'));
  }

  @Patch('feedback/:feedbackId')
  feedbackUpdate(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('feedbackId') feedbackId: string, @Body() body: unknown) {
    return this.feedback.update(a, assertUuid(feedbackId, 'Geri bildirim'), parse(updateFeedbackSchema, body), actor);
  }

  @Post('feedback/:feedbackId/comments')
  feedbackComment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('feedbackId') feedbackId: string, @Body() body: unknown) {
    return this.feedback.comment(a, assertUuid(feedbackId, 'Geri bildirim'), parse(feedbackCommentSchema, body).body, actor);
  }

  @Post('feedback/:feedbackId/task')
  feedbackTask(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('feedbackId') feedbackId: string, @Body() body: unknown) {
    return this.feedback.toTask(a, assertUuid(feedbackId, 'Geri bildirim'), parse(feedbackToTaskSchema, body), actor);
  }

  /* tasks */
  @Get('projects/:id/tasks')
  tasks(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    return this.feedback.listTasks(a, id, parse(z.object({ status: z.string().max(30).optional() }), q));
  }

  @Post('projects/:id/tasks')
  createTask(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.feedback.createTask(a, id, parse(createTaskSchema, body), actor);
  }

  @Patch('tasks/:taskId')
  updateTask(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('taskId') taskId: string, @Body() body: unknown) {
    return this.feedback.updateTask(a, assertUuid(taskId, 'Görev'), parse(updateTaskSchema, body), actor);
  }

  /* artifacts (screenshots, reports) */
  @Get('artifacts/:artifactId/content')
  async artifact(@Auth() a: AuthInfo, @Param('artifactId') artifactId: string, @Res() res: Response) {
    const row = (await this.ctx.db.select().from(artifacts).where(and(eq(artifacts.id, assertUuid(artifactId, 'Dosya')), eq(artifacts.organizationId, a.organizationId))))[0];
    if (!row || !row.projectId) throw notFound('Dosya');
    await this.access.require(a, row.projectId);
    sendArtifact(this.ctx, row, res);
  }
}

export function sendArtifact(ctx: Ctx, row: typeof artifacts.$inferSelect, res: Response) {
  const file = ctx.storage.resolve(row.storageKey);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) throw notFound('Dosya (saklama süresi dolmuş olabilir)');
  res.setHeader('content-type', row.contentType);
  res.setHeader('cache-control', 'private, max-age=3600');
  res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(row.fileName)}"`);
  fs.createReadStream(file).pipe(res);
}

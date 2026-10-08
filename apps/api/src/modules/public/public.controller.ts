import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { chatMessageSchema, feedbackCommentSchema, publicFeedbackDecisionSchema, publicFeedbackSchema, reviewerIdentitySchema } from '@projecthub/contracts';
import { AppError } from '@projecthub/core';
import { Ctx, clientIp } from '../../infra/context.js';
import { assertUuid, parse, Public, RateLimiter } from '../../infra/http.js';
import { openSse, RealtimeHub } from '../../infra/realtime.js';
import { sendArtifact } from '../reviews/reviews.controller.js';
import { PublicReviewService } from './public-review.service.js';

const identifyLimiter = new RateLimiter(20, 15 * 60_000);
const feedbackLimiter = new RateLimiter(60, 60 * 60_000);

/**
 * Customer review portal API (spec §57–69). No Project Hub account: access = unguessable link token +
 * self-declared identity (name, surname, department) stored in a per-link visitor cookie.
 * All write endpoints accept the custom header used for CSRF protection elsewhere.
 */
@Controller('public/reviews/:token')
export class PublicReviewController {
  constructor(
    private readonly svc: PublicReviewService,
    private readonly hub: RealtimeHub,
    private readonly ctx: Ctx,
  ) {}

  private csrf(req: Request) {
    if (req.headers['x-requested-with'] !== 'projecthub') throw new AppError('PERMISSION_DENIED', 'İstek doğrulanamadı');
  }

  @Public()
  @Get()
  describe(@Param('token') token: string, @Req() req: Request) {
    return this.svc.describe(req, token);
  }

  @Public()
  @Post('identify')
  @HttpCode(200)
  async identify(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    this.csrf(req);
    identifyLimiter.check(`${clientIp(req)}|${token}`);
    const input = parse(reviewerIdentitySchema, body);
    const c = await this.svc.identify(req, token, input);
    res.cookie(c.cookieName, c.cookieValue, { httpOnly: true, sameSite: 'lax', secure: this.ctx.config.COOKIE_SECURE, path: '/', expires: c.expires });
    return this.svc.describe({ headers: { cookie: `${c.cookieName}=${c.cookieValue}` } } as Request, token);
  }

  @Public()
  @Get('workspace')
  workspace(@Param('token') token: string, @Req() req: Request) {
    return this.svc.workspace(req, token);
  }

  @Public()
  @Get('feedback')
  feedback(@Param('token') token: string, @Req() req: Request) {
    return this.svc.listFeedback(req, token);
  }

  @Public()
  @Post('feedback')
  createFeedback(@Param('token') token: string, @Req() req: Request, @Body() body: unknown) {
    this.csrf(req);
    feedbackLimiter.check(`${clientIp(req)}|${token}`);
    return this.svc.createFeedback(req, token, parse(publicFeedbackSchema, body));
  }

  @Public()
  @Post('feedback/:feedbackId/comments')
  comment(@Param('token') token: string, @Param('feedbackId') feedbackId: string, @Req() req: Request, @Body() body: unknown) {
    this.csrf(req);
    return this.svc.comment(req, token, assertUuid(feedbackId, 'Geri bildirim'), parse(feedbackCommentSchema, body).body);
  }

  @Public()
  @Post('feedback/:feedbackId/decision')
  @HttpCode(200)
  decide(@Param('token') token: string, @Param('feedbackId') feedbackId: string, @Req() req: Request, @Body() body: unknown) {
    this.csrf(req);
    const input = parse(publicFeedbackDecisionSchema, body);
    return this.svc.decide(req, token, assertUuid(feedbackId, 'Geri bildirim'), input.decision, input.comment);
  }

  @Public()
  @Get('messages')
  messages(@Param('token') token: string, @Req() req: Request) {
    return this.svc.messages(req, token);
  }

  @Public()
  @Post('messages')
  send(@Param('token') token: string, @Req() req: Request, @Body() body: unknown) {
    this.csrf(req);
    feedbackLimiter.check(`chat|${clientIp(req)}|${token}`);
    return this.svc.sendMessage(req, token, parse(chatMessageSchema, body).body);
  }

  @Public()
  @Get('docs')
  docs(@Param('token') token: string, @Req() req: Request) {
    return this.svc.docs(req, token);
  }

  @Public()
  @Get('attachments/:artifactId')
  async attachment(@Param('token') token: string, @Param('artifactId') artifactId: string, @Req() req: Request, @Res() res: Response) {
    const row = await this.svc.attachment(req, token, assertUuid(artifactId, 'Dosya'));
    sendArtifact(this.ctx, row, res);
  }

  /** Live updates for the portal: team replies, feedback status changes, new version, link revoked. */
  @Public()
  @Get('events')
  async events(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const { r } = await this.svc.assertVisitor(req, token);
    const send = openSse(res, () => unsubscribe());
    send('ready', { reviewId: r.id });
    const unsubscribe = this.hub.subscribe((e) => {
      const data = (e.data ?? {}) as { reviewSessionId?: string; newVersion?: boolean };
      if (data.reviewSessionId !== r.id) return;
      if (e.type === 'review.message') send('message', {});
      else if (e.type === 'feedback.updated') send('feedback', { id: e.id });
      else if (e.type === 'review.updated') send('review', { newVersion: !!data.newVersion });
    });
  }
}

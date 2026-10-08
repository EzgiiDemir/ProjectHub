import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { aiDecisionSchema, aiFixSchema, aiQuerySchema } from '@projecthub/contracts';
import { AppError, type Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { openSse } from '../../infra/realtime.js';
import { AiService } from './ai.service.js';

@Controller()
export class AiController {
  constructor(private readonly svc: AiService) {}

  @Get('ai/status')
  status(@Auth() a: AuthInfo) {
    return this.svc.status(a);
  }

  @Get('projects/:id/ai/conversations')
  conversations(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.conversations(a, id);
  }

  @Get('ai/conversations/:conversationId')
  conversation(@Auth() a: AuthInfo, @Param('conversationId') conversationId: string) {
    return this.svc.conversation(a, assertUuid(conversationId, 'Konuşma'));
  }

  /** Streams the answer as SSE events: delta (text), done (ids + citations), error. */
  @Post('projects/:id/ai/ask')
  async ask(@Auth() a: AuthInfo, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    const input = parse(aiQuerySchema, body);
    const controller = new AbortController();
    let closed = false;
    const send = openSse(res, () => {
      closed = true;
      controller.abort();
    });
    try {
      const result = await this.svc.ask(a, id, input, (delta) => !closed && send('delta', { text: delta }), controller.signal);
      if (!closed) send('done', result);
    } catch (e) {
      if (!closed) {
        const err = e instanceof AppError ? { code: e.code, message: e.message } : { code: 'INTERNAL_ERROR', message: 'AI yanıtı alınamadı. Daha sonra tekrar deneyin.' };
        send('error', err);
      }
    } finally {
      if (!closed) res.end();
    }
  }

  @Get('projects/:id/ai/tasks')
  tasks(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.svc.listTasks(a, id);
  }

  @Post('projects/:id/ai/tasks')
  createTask(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        title: z.string().trim().max(200).optional(),
        instruction: z.string().trim().max(4000).optional(),
        sourceType: z.enum(['feedback', 'build', 'finding', 'manual']).default('manual'),
        sourceId: z.uuid().optional(),
      }),
      body,
    );
    if (input.sourceType !== 'manual' && !input.sourceId) throw new AppError('VALIDATION_ERROR', 'Kaynak kaydı belirtilmeli');
    return this.svc.createTask(a, id, input, actor);
  }

  /** Spec §79: POST /feedback/:feedbackId/ai-fix */
  @Post('projects/:id/feedback/:feedbackId/ai-fix')
  feedbackFix(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Param('feedbackId') feedbackId: string, @Body() body: unknown) {
    const { instruction } = parse(aiFixSchema, body);
    return this.svc.createTask(a, id, { sourceType: 'feedback', sourceId: assertUuid(feedbackId, 'Geri bildirim'), instruction }, actor);
  }

  @Get('ai/tasks/:taskId')
  task(@Auth() a: AuthInfo, @Param('taskId') taskId: string) {
    return this.svc.getTask(a, assertUuid(taskId, 'AI görevi'));
  }

  @Post('ai/tasks/:taskId/approve')
  approve(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('taskId') taskId: string, @Body() body: unknown) {
    return this.svc.approve(a, assertUuid(taskId, 'AI görevi'), parse(aiDecisionSchema, body).comment, actor);
  }

  @Post('ai/tasks/:taskId/reject')
  reject(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('taskId') taskId: string, @Body() body: unknown) {
    return this.svc.reject(a, assertUuid(taskId, 'AI görevi'), parse(aiDecisionSchema, body).comment, actor);
  }

  @Post('builds/:buildId/analyze')
  analyze(@Auth() a: AuthInfo, @Param('buildId') buildId: string) {
    return this.svc.reanalyseBuild(a, assertUuid(buildId, 'Build'));
  }
}

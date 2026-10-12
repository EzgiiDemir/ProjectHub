import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { commentSchema, projectCommentSchema } from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import type { AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse } from '../../infra/http.js';
import { TeamService } from './team.service.js';

@Controller()
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('team/board')
  board(@Auth() a: AuthInfo, @Query() q: unknown) {
    const input = parse(
      z.object({
        projectId: z.uuid().optional(),
        assigneeId: z.union([z.uuid(), z.literal('none')]).optional(),
        mine: z.enum(['1', 'true']).optional(),
        search: z.string().trim().max(100).optional(),
      }),
      q,
    );
    return this.team.board(a, { ...input, mine: !!input.mine });
  }

  @Get('team/activity')
  activity(@Auth() a: AuthInfo, @Query() q: unknown) {
    return this.team.activity(a, parse(z.object({ projectId: z.uuid().optional(), kind: z.string().max(20).optional(), before: z.coerce.date().optional() }), q));
  }

  @Get('team/members')
  members(@Auth() a: AuthInfo) {
    return this.team.members(a);
  }

  @Get('tasks/:taskId')
  task(@Auth() a: AuthInfo, @Param('taskId') taskId: string) {
    return this.team.task(a, assertUuid(taskId, 'Görev'));
  }

  @Post('tasks/:taskId/comments')
  comment(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('taskId') taskId: string, @Body() body: unknown) {
    return this.team.comment(a, assertUuid(taskId, 'Görev'), parse(commentSchema, body).body, actor);
  }

  @Delete('task-comments/:commentId')
  deleteComment(@Auth() a: AuthInfo, @Param('commentId') commentId: string) {
    return this.team.deleteComment(a, assertUuid(commentId, 'Yorum'));
  }

  @Get('projects/:id/discussion')
  discussion(@Auth() a: AuthInfo, @Param('id') id: string) {
    return this.team.discussion(a, id);
  }

  @Post('projects/:id/discussion')
  post(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.team.postComment(a, id, parse(projectCommentSchema, body), actor);
  }

  @Post('discussion/:commentId/:action')
  moderate(@Auth() a: AuthInfo, @Param('commentId') commentId: string, @Param('action') action: string) {
    return this.team.moderateComment(a, assertUuid(commentId, 'Yorum'), parse(z.enum(['delete', 'pin', 'unpin']), action));
  }
}

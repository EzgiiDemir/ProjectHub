import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import type { AuthInfo } from '../../infra/context.js';
import { Auth, parse } from '../../infra/http.js';
import { LogsService } from './logs.service.js';

const logQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  source: z.enum(['build', 'deployment', 'preview']).optional(),
  environmentId: z.uuid().optional(),
  level: z.enum(['error', 'warn']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

@Controller('projects/:id')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  @Get('logs')
  search(@Auth() a: AuthInfo, @Param('id') id: string, @Query() q: unknown) {
    return this.logs.search(a, id, parse(logQuerySchema, q));
  }
}

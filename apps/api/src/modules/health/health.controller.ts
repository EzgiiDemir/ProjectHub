import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import { Ctx } from '../../infra/context.js';
import { Public } from '../../infra/http.js';

/** Liveness and readiness probes (spec §107). Not under /api/v1 so orchestrators can reach them simply. */
@Controller('health')
export class HealthController {
  constructor(private readonly ctx: Ctx) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await this.ctx.db.execute(sql`SELECT 1`);
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
    }
    try {
      await fs.access(this.ctx.storage.root, fs.constants.W_OK);
      checks.storage = { ok: true };
    } catch (e) {
      checks.storage = { ok: false, detail: (e as Error).message };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'not_ready', checks };
  }
}

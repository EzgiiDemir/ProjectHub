import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  acceptInviteSchema,
  changePasswordSchema,
  createApiTokenSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  notificationPreferencesSchema,
  updateProfileSchema,
} from '@projecthub/contracts';
import type { Actor } from '@projecthub/core';
import { AuthGuard, SESSION_COOKIE } from '../../infra/auth.guard.js';
import { clientIp, type AuthInfo } from '../../infra/context.js';
import { assertUuid, Auth, CurrentActor, parse, Public, RateLimiter } from '../../infra/http.js';
import { Mailer } from '../../infra/mailer.js';
import { AuthService } from './auth.service.js';

const loginLimiter = new RateLimiter(20, 15 * 60_000);
const resetLimiter = new RateLimiter(5, 60 * 60_000);

const meta = (req: Request) => ({ ip: clientIp(req), userAgent: (req.headers['user-agent'] ?? '').slice(0, 500) || null });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly guard: AuthGuard,
    private readonly mailer: Mailer,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    loginLimiter.check(`${clientIp(req)}|${input.email.toLowerCase()}`);
    const session = await this.auth.login(input.email, input.password, meta(req));
    res.cookie(SESSION_COOKIE, session.raw, this.guard.cookieOptions(session.expiresAt));
    const authInfo = await this.guard.fromSession(session.raw);
    return this.auth.me(authInfo!);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(a, actor);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@Auth() a: AuthInfo) {
    return this.auth.me(a);
  }

  @Public()
  @Get('config')
  config() {
    return { smtpEnabled: this.mailer.enabled };
  }

  @Post('switch-organization')
  @HttpCode(200)
  async switchOrg(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const { organizationId } = parse(z.object({ organizationId: z.uuid() }), body);
    await this.auth.switchOrganization(a, organizationId, actor);
    return { ok: true };
  }

  @Public()
  @Get('invitations/:token')
  invitation(@Param('token') token: string) {
    return this.auth.describeInvitation(token);
  }

  @Public()
  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = parse(acceptInviteSchema, body);
    const session = await this.auth.acceptInvitation(input, meta(req));
    res.cookie(SESSION_COOKIE, session.raw, this.guard.cookieOptions(session.expiresAt));
    return { ok: true };
  }

  @Public()
  @Post('password-reset/request')
  @HttpCode(200)
  async requestReset(@Body() body: unknown, @Req() req: Request) {
    const { email } = parse(requestPasswordResetSchema, body);
    resetLimiter.check(`${clientIp(req)}`);
    if (this.mailer.enabled) {
      const target = await this.auth.requestPasswordReset(email);
      if (target) {
        const link = await this.auth.issueToken(target.user.id, target.organizationId, 'password_reset', null);
        await this.mailer.send(
          target.user.email,
          'Project Hub şifre sıfırlama',
          `Merhaba ${target.user.displayName},\n\nŞifrenizi sıfırlamak için bağlantı (${link.expiresInHours} saat geçerli):\n${link.url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın.`,
        );
      }
    }
    // Same answer whether or not the account exists.
    return { ok: true, emailEnabled: this.mailer.enabled };
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(200)
  async confirmReset(@Body() body: unknown, @Req() req: Request) {
    await this.auth.resetPassword(parse(resetPasswordSchema, body), meta(req));
    return { ok: true };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = parse(changePasswordSchema, body);
    await this.auth.changePassword(a, input.currentPassword, input.newPassword, actor);
    return { ok: true };
  }

  @Patch('profile')
  profile(@Auth() a: AuthInfo, @Body() body: unknown) {
    return this.auth.updateProfile(a, parse(updateProfileSchema, body));
  }

  @Get('notification-preferences')
  notificationPreferences(@Auth() a: AuthInfo) {
    return this.auth.notificationPreferences(a);
  }

  /** Replaces the user's preferences (categories left out fall back to the defaults). */
  @Put('notification-preferences')
  setNotificationPreferences(@Auth() a: AuthInfo, @Body() body: unknown) {
    return this.auth.setNotificationPreferences(a, parse(notificationPreferencesSchema, body));
  }

  @Get('sessions')
  sessions(@Auth() a: AuthInfo) {
    return this.auth.listSessions(a);
  }

  @Delete('sessions/:id')
  async revokeSession(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.auth.revokeSession(a, assertUuid(id, 'Oturum'), actor);
    return { ok: true };
  }

  @Get('tokens')
  tokens(@Auth() a: AuthInfo) {
    return this.auth.listTokens(a);
  }

  @Post('tokens')
  createToken(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.auth.createToken(a, parse(createApiTokenSchema, body), actor);
  }

  @Delete('tokens/:id')
  async revokeToken(@Auth() a: AuthInfo, @CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.auth.revokeToken(a, assertUuid(id, 'Token'), actor);
    return { ok: true };
  }
}

import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './infra/auth.guard.js';
import { Ctx } from './infra/context.js';
import { Mailer } from './infra/mailer.js';
import { ProjectAccess } from './infra/project-access.js';
import { RealtimeHub } from './infra/realtime.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import { HealthController } from './modules/health/health.controller.js';
import { MODULE_CONTROLLERS, MODULE_PROVIDERS } from './modules/index.js';

@Module({})
export class AppModule {
  static forRoot(ctx: Ctx): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, ...MODULE_CONTROLLERS],
      providers: [
        { provide: Ctx, useValue: ctx },
        AuthGuard,
        { provide: APP_GUARD, useExisting: AuthGuard },
        AuthService,
        Mailer,
        ProjectAccess,
        RealtimeHub,
        ...MODULE_PROVIDERS,
      ],
    };
  }
}

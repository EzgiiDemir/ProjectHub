import { Controller, Get } from '@nestjs/common';
import type { AuthInfo } from '../../infra/context.js';
import { Auth } from '../../infra/http.js';
import { HomeService } from './home.service.js';

@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** Dashboard charts and activity from real project data. */
  @Get('insights')
  insights(@Auth() a: AuthInfo) {
    return this.home.insights(a);
  }

  /** Role-based sections shown under the shared home overview (GET /home). */
  @Get('sections')
  sections(@Auth() a: AuthInfo) {
    return this.home.sections(a);
  }
}

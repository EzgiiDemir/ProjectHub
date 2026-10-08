import type { Type } from '@nestjs/common';
import { Repos } from '../infra/repos.js';
import { AdminController } from './admin/admin.controller.js';
import { DeployController } from './deploy/deploy.controller.js';
import { DeployService } from './deploy/deploy.service.js';
import { MiscController } from './misc/misc.controller.js';
import { MiscService } from './misc/misc.service.js';
import { SecurityService } from './security/security.service.js';
import { AiController } from './ai/ai.controller.js';
import { AiService } from './ai/ai.service.js';
import { BuildsController } from './builds/builds.controller.js';
import { BuildsService } from './builds/builds.service.js';
import { SystemService } from './admin/system.service.js';
import { UsersService } from './admin/users.service.js';
import { ProjectsController } from './projects/projects.controller.js';
import { ProjectsService } from './projects/projects.service.js';
import { UploadsService } from './projects/uploads.service.js';
import { PublicReviewController } from './public/public.controller.js';
import { PublicReviewService } from './public/public-review.service.js';
import { RepositoryController } from './repository/repository.controller.js';
import { FeedbackService } from './reviews/feedback.service.js';
import { ReviewsController } from './reviews/reviews.controller.js';
import { ReviewsService } from './reviews/reviews.service.js';
import { RepositoryService } from './repository/repository.service.js';

/** Feature modules register their controllers and providers here. */
export const MODULE_CONTROLLERS: Type[] = [AdminController, ProjectsController, RepositoryController, BuildsController, ReviewsController, PublicReviewController, AiController, DeployController, MiscController];
export const MODULE_PROVIDERS: Type[] = [Repos, UsersService, SystemService, ProjectsService, UploadsService, RepositoryService, BuildsService, ReviewsService, FeedbackService, PublicReviewService, AiService, DeployService, SecurityService, MiscService];

CREATE TABLE "backup_restores" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"backup_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending_approval' NOT NULL,
	"requested_by" uuid,
	"approved_by" uuid,
	"error" text,
	"log" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "backup_restores_status_ck" CHECK (status IN ('pending_approval', 'queued', 'running', 'completed', 'failed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"migration_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"deployment_id" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_migrations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" varchar(500) NOT NULL,
	"name" varchar(300) NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"risk_level" varchar(10) NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_version_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_migrations_risk_ck" CHECK (risk_level IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "system_metrics" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hostname" varchar(120) NOT NULL,
	"cpu_load" integer NOT NULL,
	"memory_used" bigint NOT NULL,
	"memory_total" bigint NOT NULL,
	"disk_used" bigint,
	"disk_total" bigint,
	"queued_jobs" integer DEFAULT 0 NOT NULL,
	"running_jobs" integer DEFAULT 0 NOT NULL,
	"running_previews" integer DEFAULT 0 NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_request_comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"author_type" varchar(20) DEFAULT 'user' NOT NULL,
	"user_id" uuid,
	"body" text NOT NULL,
	"path" varchar(500),
	"line" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_comments_author_ck" CHECK (author_type IN ('user', 'ai', 'system'))
);
--> statement-breakpoint
CREATE TABLE "pull_request_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"user_id" uuid,
	"decision" varchar(20) NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"commit_sha" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_reviews_decision_ck" CHECK (decision IN ('approved', 'changes_requested'))
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_branch" varchar(200) NOT NULL,
	"target_branch" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"author_id" uuid,
	"merged_by" uuid,
	"merge_commit" varchar(40),
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_status_ck" CHECK (status IN ('open', 'merged', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_migration_id_project_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."project_migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_first_version_id_versions_id_fk" FOREIGN KEY ("first_version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_comments" ADD CONSTRAINT "pull_request_comments_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_comments" ADD CONSTRAINT "pull_request_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_reviews" ADD CONSTRAINT "pull_request_reviews_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_reviews" ADD CONSTRAINT "pull_request_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_merged_by_users_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_restores_project_idx" ON "backup_restores" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_runs_env_uq" ON "migration_runs" USING btree ("migration_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_migrations_path_uq" ON "project_migrations" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "system_metrics_time_idx" ON "system_metrics" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "pr_comments_pr_idx" ON "pull_request_comments" USING btree ("pull_request_id");--> statement-breakpoint
CREATE INDEX "pr_reviews_pr_idx" ON "pull_request_reviews" USING btree ("pull_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_number_uq" ON "pull_requests" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "pull_requests_status_idx" ON "pull_requests" USING btree ("project_id","status");
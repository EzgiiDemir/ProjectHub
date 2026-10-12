CREATE TABLE "ai_remediations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"action" varchar(40) NOT NULL,
	"risk_level" varchar(20) DEFAULT 'low' NOT NULL,
	"trigger" varchar(20) NOT NULL,
	"status" varchar(30) DEFAULT 'queued' NOT NULL,
	"diagnosis" text,
	"result" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_remediations_action_ck" CHECK (action IN ('recheck_health')),
	CONSTRAINT "ai_remediations_risk_ck" CHECK (risk_level IN ('low')),
	CONSTRAINT "ai_remediations_trigger_ck" CHECK (trigger IN ('manual', 'automatic')),
	CONSTRAINT "ai_remediations_status_ck" CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "ai_remediations" ADD CONSTRAINT "ai_remediations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_remediations" ADD CONSTRAINT "ai_remediations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_remediations" ADD CONSTRAINT "ai_remediations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_remediations" ADD CONSTRAINT "ai_remediations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_remediations_incident_idx" ON "ai_remediations" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_remediations_rate_idx" ON "ai_remediations" USING btree ("organization_id","created_at");
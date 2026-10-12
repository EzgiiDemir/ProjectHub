CREATE TABLE "ai_memories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"category" varchar(30) NOT NULL,
	"title" varchar(200) NOT NULL,
	"content" text NOT NULL,
	"verification" varchar(20) DEFAULT 'inferred' NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_ref" varchar(500),
	"source_label" varchar(300),
	"created_by_type" varchar(20) DEFAULT 'system' NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || content || ' ' || coalesce(source_label, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memories_category_ck" CHECK (category IN ('architecture', 'decision', 'convention', 'bug', 'task_outcome', 'fact')),
	CONSTRAINT "ai_memories_verification_ck" CHECK (verification IN ('verified', 'inferred', 'historical')),
	CONSTRAINT "ai_memories_created_by_type_ck" CHECK (created_by_type IN ('user', 'ai', 'system'))
);
--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_memories_project_updated_idx" ON "ai_memories" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_memories_search_idx" ON "ai_memories" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memories_source_uq" ON "ai_memories" USING btree ("project_id","source_type","source_ref");
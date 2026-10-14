CREATE TABLE "ai_insight_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sha256" text NOT NULL,
	"cache_key" text NOT NULL,
	"model" text NOT NULL,
	"insight" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"ai" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_secrets_encrypted" text,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_monthly_file_budget" integer DEFAULT 1000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "ai_reason" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "ai_analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_insight_cache" ADD CONSTRAINT "ai_insight_cache_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_cache_org_sha_key_uq" ON "ai_insight_cache" USING btree ("organization_id","sha256","cache_key");
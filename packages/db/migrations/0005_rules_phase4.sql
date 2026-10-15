ALTER TABLE "files" ADD COLUMN "rules_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "scope_space_id" uuid;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "schedule" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_scope_space_id_spaces_id_fk" FOREIGN KEY ("scope_space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;
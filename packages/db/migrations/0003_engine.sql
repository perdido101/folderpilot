ALTER TABLE "audit_events" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "category_source" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "flag_reason" text;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD COLUMN "undoes_event_id" uuid;--> statement-breakpoint
CREATE INDEX "audit_space_at_idx" ON "audit_events" USING btree ("space_id","at");--> statement-breakpoint
-- Recreate the view so it includes the new space_id column (views freeze their column list at creation).
DROP VIEW audit_events_with_undo;
--> statement-breakpoint
CREATE VIEW audit_events_with_undo AS
SELECT e.*,
       u.actor AS undone_by,
       u.at    AS undone_at,
       u.id    AS undone_by_event_id
FROM audit_events e
LEFT JOIN LATERAL (
  SELECT x.actor, x.at, x.id
  FROM audit_events x
  WHERE x.undoes_event_id = e.id
  ORDER BY x.seq
  LIMIT 1
) u ON true;

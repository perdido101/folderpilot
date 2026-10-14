-- CLAUDE.md §2.3: the audit log is append-only, enforced by the database itself.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
-- Undo is a new event pointing at the original (undoes_event_id); this view derives "undone by".
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

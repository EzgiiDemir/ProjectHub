-- Audit trail is append-only: the database itself rejects UPDATE and DELETE,
-- so neither application bugs nor AI agents can rewrite history.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
-- Wake idle workers immediately when a job becomes available (they also poll as a fallback).
CREATE OR REPLACE FUNCTION jobs_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'queued' THEN
    PERFORM pg_notify('ph_jobs', NEW.queue);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER jobs_notify_insert AFTER INSERT OR UPDATE OF status, run_at ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_notify();
--> statement-breakpoint
-- Full text search over feedback for universal search.
CREATE INDEX feedback_search_idx ON feedback USING gin (to_tsvector('simple', title || ' ' || body));
--> statement-breakpoint
CREATE INDEX projects_search_idx ON projects USING gin (to_tsvector('simple', name || ' ' || description || ' ' || customer_name));

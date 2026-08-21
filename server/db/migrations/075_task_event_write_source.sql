ALTER TABLE task_events
  ADD COLUMN IF NOT EXISTS write_source text NOT NULL DEFAULT 'pointer_derived';

ALTER TABLE task_events
  ADD COLUMN IF NOT EXISTS provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb;

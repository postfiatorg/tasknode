CREATE TABLE IF NOT EXISTS task_accounting_harvest_reports (
  id text PRIMARY KEY,
  report_bucket integer NOT NULL UNIQUE CHECK (report_bucket >= 0),
  resolved_count integer NOT NULL DEFAULT 0 CHECK (resolved_count >= 0),
  unresolved_count integer NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
  requires_action_count integer NOT NULL DEFAULT 0 CHECK (requires_action_count >= 0),
  checked_out_count integer NOT NULL DEFAULT 0 CHECK (checked_out_count >= 0),
  source_task_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_markdown text NOT NULL DEFAULT '',
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_accounting_harvest_reports_generated_idx
  ON task_accounting_harvest_reports (generated_at DESC, report_bucket DESC);

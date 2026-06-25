CREATE TABLE IF NOT EXISTS hive_reports (
  id text PRIMARY KEY,
  type text NOT NULL,
  version text NOT NULL DEFAULT 'hive_reports.v1',
  generated_at timestamptz NOT NULL DEFAULT now(),
  body_markdown text NOT NULL DEFAULT '',
  source_run_id text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hive_reports_type_chk CHECK (type IN ('operative', 'rewarded_task', 'kol', 'development', 'qa', 'executive')),
  CONSTRAINT hive_reports_markdown_not_json_chk CHECK (
    left(ltrim(body_markdown), 1) <> '{'
    AND left(ltrim(body_markdown), 1) <> '['
  )
);

CREATE INDEX IF NOT EXISTS hive_reports_type_generated_idx
  ON hive_reports (type, generated_at DESC, id);

CREATE INDEX IF NOT EXISTS hive_reports_generated_idx
  ON hive_reports (generated_at DESC, id);

CREATE TABLE IF NOT EXISTS hive_report_verifications (
  id text PRIMARY KEY,
  report_id text NOT NULL REFERENCES hive_reports(id) ON DELETE CASCADE,
  phase text NOT NULL,
  agent text NOT NULL DEFAULT '',
  result_summary text NOT NULL DEFAULT '',
  verified_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hive_report_verifications_phase_chk CHECK (phase IN ('initial', 'agent_verify', 'final'))
);

CREATE INDEX IF NOT EXISTS hive_report_verifications_report_phase_idx
  ON hive_report_verifications (report_id, phase, verified_at DESC, id);

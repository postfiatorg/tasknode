CREATE TABLE IF NOT EXISTS hive_decision_runs (
  id text PRIMARY KEY,
  scope text NOT NULL DEFAULT 'global_hive',
  trigger text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',
  shadow boolean NOT NULL DEFAULT true,
  source_packet_digest text NOT NULL DEFAULT '',
  input_report_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  task_status_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  discussion_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  reasoning_text text NOT NULL DEFAULT '',
  options_considered_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  informed_by_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_action text NOT NULL DEFAULT '',
  action_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  guardrail_result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT 'openrouter',
  model text NOT NULL DEFAULT '',
  reasoning_effort text NOT NULL DEFAULT '',
  output_text text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hive_decision_runs_status_chk CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS hive_decision_runs_recent_idx
  ON hive_decision_runs (scope, started_at DESC, id);

CREATE INDEX IF NOT EXISTS hive_decision_runs_action_recent_idx
  ON hive_decision_runs (selected_action, started_at DESC, id);

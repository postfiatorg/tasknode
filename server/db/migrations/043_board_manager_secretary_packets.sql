CREATE TABLE IF NOT EXISTS board_manager_secretary_packets (
  id text PRIMARY KEY,
  scope text NOT NULL DEFAULT 'global_hive',
  packet_type text NOT NULL DEFAULT 'board_triage',
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  source_digest text NOT NULL DEFAULT '',
  packet_digest text NOT NULL DEFAULT '',
  packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  packet_text text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT 'deepseek',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  response_id text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'current',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT board_manager_secretary_packets_status_chk
    CHECK (status IN ('current', 'superseded', 'failed')),
  CONSTRAINT board_manager_secretary_packets_type_chk
    CHECK (packet_type IN ('board_triage', 'project_focus', 'contributor_focus', 'network_task_evidence'))
);

CREATE INDEX IF NOT EXISTS board_manager_secretary_packets_current_idx
  ON board_manager_secretary_packets (scope, packet_type, target_type, target_id, source_digest, created_at DESC)
  WHERE status = 'current';

CREATE INDEX IF NOT EXISTS board_manager_secretary_packets_recent_idx
  ON board_manager_secretary_packets (scope, created_at DESC, id);

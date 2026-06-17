CREATE TABLE IF NOT EXISTS board_manager_evidence_evaluation_packets (
  id text PRIMARY KEY,
  task_id text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  packet_status text NOT NULL DEFAULT 'ready',
  evaluator_id text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  recommendation text NOT NULL DEFAULT '',
  source_digest text NOT NULL DEFAULT '',
  packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_manager_evidence_evaluation_packets_status_chk
    CHECK (packet_status IN ('ready', 'needs_review', 'failed', 'superseded'))
);

CREATE INDEX IF NOT EXISTS board_manager_evidence_evaluation_packets_task_idx
  ON board_manager_evidence_evaluation_packets (task_id, packet_status, updated_at DESC)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS board_manager_evidence_evaluation_packets_project_idx
  ON board_manager_evidence_evaluation_packets (project_id, packet_status, updated_at DESC)
  WHERE project_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS board_manager_evidence_evaluation_packets_source_idx
  ON board_manager_evidence_evaluation_packets (source_digest)
  WHERE source_digest <> '';

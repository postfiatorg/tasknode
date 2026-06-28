CREATE TABLE IF NOT EXISTS hive_board_secretary_memos (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'current',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  memo_markdown text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT hive_board_secretary_memos_status_chk
    CHECK (status IN ('current', 'superseded', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hive_board_secretary_memos_current_unique
  ON hive_board_secretary_memos (project_id)
  WHERE status = 'current' AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS hive_board_secretary_memos_project_recent_idx
  ON hive_board_secretary_memos (project_id, generated_at DESC, id);

CREATE INDEX IF NOT EXISTS hive_board_secretary_memos_status_recent_idx
  ON hive_board_secretary_memos (status, generated_at DESC, id);

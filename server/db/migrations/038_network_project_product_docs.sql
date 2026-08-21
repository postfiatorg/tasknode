CREATE TABLE IF NOT EXISTS network_project_product_docs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'current',
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  project_status text NOT NULL DEFAULT '',
  key_points_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocked_or_unclear_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_actions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  board_manager_run_id text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT network_project_product_docs_status_chk
    CHECK (status IN ('current', 'superseded', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS network_project_product_docs_current_unique
  ON network_project_product_docs (project_id)
  WHERE status = 'current' AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS network_project_product_docs_project_recent_idx
  ON network_project_product_docs (project_id, created_at DESC, id);

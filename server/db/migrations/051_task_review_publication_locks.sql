CREATE TABLE IF NOT EXISTS task_review_publications (
  task_id text NOT NULL,
  worker_name text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  source_tx_hash text NOT NULL DEFAULT '',
  source_cid text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, worker_name)
);

CREATE INDEX IF NOT EXISTS task_review_publications_status_updated_idx
  ON task_review_publications (status, updated_at DESC, task_id);

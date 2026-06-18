CREATE TABLE IF NOT EXISTS taskgen_replay_cache (
  replay_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'generated',
  request_id text NOT NULL DEFAULT '',
  request_bundle_cid text NOT NULL DEFAULT '',
  request_bundle_digest text NOT NULL DEFAULT '',
  source_payload_digest text NOT NULL DEFAULT '',
  input_packet_digest text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  task_class text NOT NULL DEFAULT '',
  reward_policy_version text NOT NULL DEFAULT '',
  deadline_policy_version text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  subject_wallet text NOT NULL DEFAULT '',
  offer_cid text NOT NULL DEFAULT '',
  offer_digest text NOT NULL DEFAULT '',
  offer_tx_hash text NOT NULL DEFAULT '',
  taskgen_output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  taskgen_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  offer_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  replay_identity_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz,
  published_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taskgen_replay_cache_status_chk
    CHECK (status IN ('generated', 'published', 'failed'))
);

CREATE INDEX IF NOT EXISTS taskgen_replay_cache_request_idx
  ON taskgen_replay_cache (request_id, updated_at DESC)
  WHERE request_id <> '';

CREATE INDEX IF NOT EXISTS taskgen_replay_cache_task_idx
  ON taskgen_replay_cache (task_id)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS taskgen_replay_cache_source_idx
  ON taskgen_replay_cache (source_payload_digest, prompt_digest, model)
  WHERE source_payload_digest <> '';

CREATE INDEX IF NOT EXISTS taskgen_replay_cache_status_idx
  ON taskgen_replay_cache (status, updated_at DESC, replay_key);

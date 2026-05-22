ALTER TABLE hive_context_entries
  ADD COLUMN IF NOT EXISTS wallet_address text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS wallet_validated boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS hive_context_entries_validated_recent_idx
  ON hive_context_entries (created_at DESC, id)
  WHERE deleted_at IS NULL AND wallet_validated = true;

CREATE TABLE IF NOT EXISTS hive_secretary_jobs (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  reason text NOT NULL DEFAULT '',
  source_entry_id text NOT NULL DEFAULT '',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hive_secretary_jobs_status_chk
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hive_secretary_jobs_pending_digest_unique
  ON hive_secretary_jobs (source_packet_digest)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS hive_secretary_jobs_pending_idx
  ON hive_secretary_jobs (status, next_attempt_at, created_at, id);

CREATE TABLE IF NOT EXISTS hive_secretary_reports (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'completed',
  source_packet_digest text NOT NULL DEFAULT '',
  source_packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_packet_text text NOT NULL DEFAULT '',
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_text text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  prompt_digest text NOT NULL DEFAULT '',
  usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT hive_secretary_reports_status_chk
    CHECK (status IN ('completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS hive_secretary_reports_current_idx
  ON hive_secretary_reports (completed_at DESC NULLS LAST, created_at DESC, id)
  WHERE status = 'completed' AND superseded_at IS NULL;
